require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const {
  db,
  reserveStakesTx,
  settleMatchupTx,
  adminAdjustWalletTx,
  requestWithdrawalTx,
  approveWithdrawalTx,
  rejectWithdrawalTx,
} = require('./db');
const { rollTwoDiceSecure, getNextMatchupAfterResult } = require('./gameEngine');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dice_royale_dev_secret_change_in_prod';
const DISCONNECT_COUNTDOWN_MS = 10000; // 10 seconds exact

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Serve Admin Panel statically at /admin
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dice-royale' }));

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, login_id, display_name, role, status, must_change_password, available_balance, reserved_balance, avatar_color, active_session_id FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.status !== 'active') {
      return res.status(403).json({ error: 'Account disabled or not found' });
    }
    if (payload.sessionId && user.active_session_id && payload.sessionId !== user.active_session_id) {
      return res.status(401).json({ error: 'Session expired: logged in from another device', code: 'SESSION_REVOKED' });
    }
    req.user = user;
    req.sessionId = payload.sessionId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
}

// ==================== PUBLIC REGISTRATION BLOCKED ====================
app.post('/api/auth/register', (_req, res) => {
  return res.status(403).json({ error: 'Public registration is disabled. Contact an administrator.' });
});

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'Login ID and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(String(loginId).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid login credentials' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is disabled. Contact administrator.' });
  }

  const sessionId = uuidv4();

  // If user already has open Socket.IO connections from an older session, emit session:force_logout and disconnect them immediately
  const existingSockets = userSockets.get(user.id);
  if (existingSockets && existingSockets.size > 0) {
    for (const socketId of existingSockets) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.emit('session:force_logout', { message: 'You were logged out because your account signed in on another device.' });
        s.disconnect(true);
      }
    }
    userSockets.delete(user.id);
  }

  db.prepare(`
    INSERT INTO login_logs (id, user_id, status, ip_address)
    VALUES (?, ?, 'online', ?)
  `).run(sessionId, user.id, req.ip || 'unknown');

  db.prepare("UPDATE users SET is_online = 1, active_session_id = ?, last_activity = datetime('now') WHERE id = ?").run(sessionId, user.id);

  const token = jwt.sign({ userId: user.id, role: user.role, sessionId }, JWT_SECRET, { expiresIn: '24h' });
  return res.json({
    token,
    user: {
      id: user.id,
      loginId: user.login_id,
      displayName: user.display_name,
      role: user.role,
      mustChangePassword: Boolean(user.must_change_password),
      availableBalance: user.available_balance,
      reservedBalance: user.reserved_balance,
      avatarColor: user.avatar_color,
    },
  });
});

app.post('/api/auth/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.must_change_password && !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, user.id);
  return res.json({ message: 'Password updated successfully' });
});

app.get('/api/me', authenticateToken, (req, res) => {
  const u = db.prepare(`
    SELECT id, login_id, display_name, role, status, must_change_password,
           initial_balance, available_balance, reserved_balance,
           total_wagered, total_won, total_lost, avatar_color
    FROM users WHERE id = ?
  `).get(req.user.id);
  res.json(u);
});

app.get('/api/me/history', authenticateToken, (req, res) => {
  const matchups = db.prepare(`
    SELECT m.*, r.name as room_name, r.code as room_code,
           ua.display_name as player_a_name, ub.display_name as player_b_name
    FROM matchups m
    JOIN rooms r ON m.room_id = r.id
    JOIN users ua ON m.player_a_id = ua.id
    JOIN users ub ON m.player_b_id = ub.id
    WHERE m.player_a_id = ? OR m.player_b_id = ?
    ORDER BY m.started_at DESC LIMIT 30
  `).all(req.user.id, req.user.id);

  const transactions = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);

  res.json({ matchups, transactions });
});

// ==================== WITHDRAWAL ROUTES (PLAYER) ====================
app.post('/api/withdrawals', authenticateToken, (req, res) => {
  const { amount, note } = req.body || {};
  const amt = parseInt(amount, 10);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Withdrawal amount must be a positive integer' });
  }
  try {
    const result = requestWithdrawalTx(req.user.id, amt, note);
    broadcastPlayerBalanceUpdate(req.user.id);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/withdrawals/me', authenticateToken, (req, res) => {
  const withdrawals = db.prepare(`
    SELECT id, amount, note, status, admin_reason, created_at, processed_at
    FROM withdrawal_requests
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(withdrawals);
});

// ==================== LOBBY & ROOMS ====================
app.get('/api/rooms', authenticateToken, (_req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at ASC').all();
  const enriched = rooms.map((r) => {
    const state = roomStates.get(r.id);
    return {
      ...r,
      seatedCount: state ? state.seats.length : 0,
      gameStatus: state && state.activeMatchup ? 'playing' : 'waiting',
    };
  });
  res.json(enriched);
});

// ==================== ADMIN API ROUTES ====================
app.get('/api/admin/overview', authenticateToken, requireAdmin, (_req, res) => {
  const totalPlayers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'player'").get().c;
  const onlinePlayers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'player' AND is_online = 1").get().c;
  const totalCoins = db.prepare("SELECT COALESCE(SUM(available_balance + reserved_balance), 0) as c FROM users WHERE role = 'player'").get().c;
  const activeTables = Array.from(roomStates.values()).filter((s) => s.seats.length >= 2).length;
  const gamesInProgress = Array.from(roomStates.values()).filter((s) => s.activeMatchup !== null).length;

  const recentGames = db.prepare(`
    SELECT m.*, r.name as room_name, ua.display_name as player_a_name, ub.display_name as player_b_name
    FROM matchups m
    JOIN rooms r ON m.room_id = r.id
    JOIN users ua ON m.player_a_id = ua.id
    JOIN users ub ON m.player_b_id = ub.id
    ORDER BY m.started_at DESC LIMIT 10
  `).all();

  const recentTransactions = db.prepare(`
    SELECT t.*, u.display_name, u.login_id
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC LIMIT 10
  `).all();

  res.json({
    totalPlayers,
    onlinePlayers,
    activeTables,
    gamesInProgress,
    totalCoins,
    recentGames,
    recentTransactions,
  });
});

app.get('/api/admin/players', authenticateToken, requireAdmin, (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  const players = db.prepare(`
    SELECT id, login_id, display_name, status, must_change_password, avatar_color,
           initial_balance, available_balance, reserved_balance,
           total_wagered, total_won, total_lost, is_online, last_activity, created_at
    FROM users
    WHERE role = 'player' AND (login_id LIKE ? OR display_name LIKE ?)
    ORDER BY created_at DESC
  `).all(q, q);
  res.json(players);
});

app.post('/api/admin/players', authenticateToken, requireAdmin, (req, res) => {
  const { displayName, loginId, temporaryPassword, initialBalance, status, avatarColor } = req.body || {};
  if (!displayName || !loginId || !temporaryPassword) {
    return res.status(400).json({ error: 'Display name, login ID, and temporary password are required' });
  }
  const initBal = parseInt(initialBalance || 0, 10);
  if (isNaN(initBal) || initBal < 0) return res.status(400).json({ error: 'Initial balance must be >= 0' });

  const existing = db.prepare('SELECT id FROM users WHERE login_id = ?').get(String(loginId).trim());
  if (existing) return res.status(409).json({ error: 'Login ID already exists' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(temporaryPassword, 10);
  const accStatus = status === 'disabled' ? 'disabled' : 'active';
  const color = avatarColor || '#D4AF37';

  const createTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, login_id, display_name, password_hash, role, status, must_change_password, avatar_color, initial_balance, available_balance)
      VALUES (?, ?, ?, ?, 'player', ?, 1, ?, ?, ?)
    `).run(id, String(loginId).trim(), String(displayName).trim(), hash, accStatus, color, initBal, initBal);

    if (initBal > 0) {
      const txId = uuidv4();
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, created_by)
        VALUES (?, ?, 'initial_allocation', ?, 0, ?, 0, 0, 'Initial coin allocation by admin', ?)
      `).run(txId, id, initBal, initBal, req.user.id);

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, amount, reason, transaction_id)
        VALUES (?, ?, 'create_player_with_balance', ?, ?, 'Initial coin allocation on account creation', ?)
      `).run(uuidv4(), req.user.id, id, initBal, txId);
    } else {
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, amount, reason)
        VALUES (?, ?, 'create_player', ?, 0, 'Created player account')
      `).run(uuidv4(), req.user.id, id);
    }
  });

  createTx();
  res.status(201).json({ id, loginId, displayName, initialBalance: initBal, status: accStatus });
});

app.patch('/api/admin/players/:id/status', authenticateToken, requireAdmin, (req, res) => {
  const { status, reason } = req.body || {};
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), req.user.id, `set_status_${status}`, req.params.id, reason || `Account ${status}`);
  res.json({ status });
});

app.post('/api/admin/players/:id/reset-password', authenticateToken, requireAdmin, (req, res) => {
  const { temporaryPassword, reason } = req.body || {};
  if (!temporaryPassword || temporaryPassword.length < 6) {
    return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
  }
  const hash = bcrypt.hashSync(temporaryPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, req.params.id);
  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, reason)
    VALUES (?, ?, 'reset_password', ?, ?)
  `).run(uuidv4(), req.user.id, req.params.id, reason || 'Admin password reset');
  res.json({ message: 'Temporary password reset' });
});

app.post('/api/admin/wallet/adjust', authenticateToken, requireAdmin, (req, res) => {
  const { userId, amount, reason } = req.body || {};
  try {
    const result = adminAdjustWalletTx(req.user.id, userId, parseInt(amount, 10), reason);
    broadcastPlayerBalanceUpdate(userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== WITHDRAWAL ROUTES (ADMIN) ====================
app.get('/api/admin/withdrawals', authenticateToken, requireAdmin, (req, res) => {
  const { status } = req.query || {};
  let sql = `
    SELECT w.*, u.display_name, u.login_id, adm.display_name as admin_name
    FROM withdrawal_requests w
    JOIN users u ON w.user_id = u.id
    LEFT JOIN users adm ON w.admin_id = adm.id
  `;
  const params = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    sql += ' WHERE w.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY w.created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.post('/api/admin/withdrawals/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  const { reason } = req.body || {};
  try {
    const result = approveWithdrawalTx(req.user.id, req.params.id, reason);
    broadcastPlayerBalanceUpdate(result.userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/reject', authenticateToken, requireAdmin, (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'Rejection reason is mandatory' });
  }
  try {
    const result = rejectWithdrawalTx(req.user.id, req.params.id, reason);
    broadcastPlayerBalanceUpdate(result.userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', authenticateToken, requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.login_id, u.display_name
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

app.get('/api/admin/online-users', authenticateToken, requireAdmin, (_req, res) => {
  const logs = db.prepare(`
    SELECT l.*, u.login_id, u.display_name, u.is_online
    FROM login_logs l
    JOIN users u ON l.user_id = u.id
    ORDER BY l.login_at DESC LIMIT 100
  `).all();
  res.json(logs);
});

app.get('/api/admin/tables', authenticateToken, requireAdmin, (_req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms').all();
  const tables = rooms.map((r) => serializeRoomState(r.id));
  res.json(tables);
});

app.post('/api/admin/rooms', authenticateToken, requireAdmin, (req, res) => {
  const { name, code, maxPlayers } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'Name and code required' });
  const id = uuidv4();
  db.prepare('INSERT INTO rooms (id, code, name, max_players) VALUES (?, ?, ?, ?)').run(
    id,
    String(code).toUpperCase().trim(),
    String(name).trim(),
    Math.min(8, Math.max(2, parseInt(maxPlayers || 8, 10)))
  );
  res.status(201).json({ id, name, code });
});

app.get('/api/admin/games', authenticateToken, requireAdmin, (_req, res) => {
  const games = db.prepare(`
    SELECT m.*, r.name as room_name, ua.display_name as player_a_name, ub.display_name as player_b_name
    FROM matchups m
    JOIN rooms r ON m.room_id = r.id
    JOIN users ua ON m.player_a_id = ua.id
    JOIN users ub ON m.player_b_id = ub.id
    ORDER BY m.started_at DESC LIMIT 100
  `).all();
  res.json(games);
});

app.get('/api/admin/audit-logs', authenticateToken, requireAdmin, (_req, res) => {
  const logs = db.prepare(`
    SELECT a.*, adm.display_name as admin_name, tgt.display_name as target_name
    FROM audit_logs a
    LEFT JOIN users adm ON a.admin_id = adm.id
    LEFT JOIN users tgt ON a.target_user_id = tgt.id
    ORDER BY a.created_at DESC LIMIT 200
  `).all();
  res.json(logs);
});

// ==================== REAL-TIME GAME SERVER (SOCKET.IO) ====================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 5000,
});

// In-memory live room state (backed by SQLite for all persistent balances/matchups/rolls)
const roomStates = new Map();
const userSockets = new Map(); // userId -> Set<socketId>
const userDisconnectTimestamps = new Map(); // userId -> number (ms)
const waitingEvictionTimers = new Map(); // `${roomId}:${userId}` -> NodeJS.Timeout

function getOrCreateRoomState(roomId) {
  if (!roomStates.has(roomId)) {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) return null;
    roomStates.set(roomId, {
      room,
      seats: [], // [{ playerId, seatIndex }]
      pendingMatchup: null, // { playerAId, playerBId, firstTurnPlayerId, proposedBy, proposedStake, acceptedBy: Set }
      activeMatchup: null, // { id, playerAId, playerBId, stake, pot, currentTurnPlayerId, lastRoll, rolls: [] }
      disconnectTimer: null,
      countdownDeadline: null,
    });
  }
  return roomStates.get(roomId);
}

function serializeRoomState(roomId) {
  const state = getOrCreateRoomState(roomId);
  if (!state) return null;

  const seatedPlayers = state.seats.map((s) => {
    const u = db.prepare(`
      SELECT id, login_id, display_name, available_balance, reserved_balance, is_online, avatar_color
      FROM users WHERE id = ?
    `).get(s.playerId);
    return {
      seatIndex: s.seatIndex,
      playerId: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      availableBalance: u.available_balance,
      reservedBalance: u.reserved_balance,
      totalBalance: u.available_balance + u.reserved_balance,
      isOnline: Boolean(u.is_online),
      avatarColor: u.avatar_color,
    };
  });

  return {
    room: state.room,
    seats: seatedPlayers,
    pendingMatchup: state.pendingMatchup
      ? {
          playerAId: state.pendingMatchup.playerAId,
          playerBId: state.pendingMatchup.playerBId,
          firstTurnPlayerId: state.pendingMatchup.firstTurnPlayerId,
          proposedBy: state.pendingMatchup.proposedBy,
          proposedStake: state.pendingMatchup.proposedStake,
          acceptedBy: Array.from(state.pendingMatchup.acceptedBy),
        }
      : null,
    activeMatchup: state.activeMatchup,
    countdownDeadline: state.countdownDeadline,
  };
}

function broadcastRoom(roomId) {
  const payload = serializeRoomState(roomId);
  if (payload) {
    io.to(`room:${roomId}`).emit('room:state', payload);
    io.to('admin:monitor').emit('admin:table_update', payload);
  }
}

function broadcastPlayerBalanceUpdate(userId) {
  for (const [roomId, state] of roomStates.entries()) {
    if (state.seats.some((s) => s.playerId === userId)) {
      broadcastRoom(roomId);
    }
  }
}

function clearDisconnectTimer(state) {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
  state.countdownDeadline = null;
}

function scheduleDisconnectAutoRollIfNeeded(roomId) {
  const state = roomStates.get(roomId);
  if (!state || !state.activeMatchup) return;

  const currentTurnId = state.activeMatchup.currentTurnPlayerId;
  const user = db.prepare('SELECT is_online FROM users WHERE id = ?').get(currentTurnId);
  if (user && user.is_online === 1) {
    clearDisconnectTimer(state);
    return;
  }

  // Player whose turn it is is offline -> start 10s server-side countdown
  if (state.disconnectTimer) return; // Never reset an active timer
  state.countdownDeadline = Date.now() + DISCONNECT_COUNTDOWN_MS;
  broadcastRoom(roomId);

  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    state.countdownDeadline = null;
    executeTurnRoll(roomId, currentTurnId, true);
  }, DISCONNECT_COUNTDOWN_MS);
}

function executeTurnRoll(roomId, playerId, isAutoRoll = false) {
  const state = roomStates.get(roomId);
  if (!state || !state.activeMatchup) return;
  const m = state.activeMatchup;
  if (m.currentTurnPlayerId !== playerId) return;

  clearDisconnectTimer(state);

  const roll = rollTwoDiceSecure();
  const rollRecord = {
    id: uuidv4(),
    matchupId: m.id,
    roomId,
    playerId,
    d1: roll.d1,
    d2: roll.d2,
    key: roll.key,
    outcome: roll.outcome,
    isAutoRoll,
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO rolls (id, matchup_id, room_id, player_id, dice_1, dice_2, combo_key, outcome, is_auto_roll)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rollRecord.id, m.id, roomId, playerId, roll.d1, roll.d2, roll.key, roll.outcome, isAutoRoll ? 1 : 0);

  m.lastRoll = rollRecord;
  m.rolls.unshift(rollRecord);

  io.to(`room:${roomId}`).emit('game:roll_result', rollRecord);

  if (roll.outcome === 'PASS') {
    // Alternate turn to the opponent
    m.currentTurnPlayerId = playerId === m.playerAId ? m.playerBId : m.playerAId;
    broadcastRoom(roomId);
    scheduleDisconnectAutoRollIfNeeded(roomId);
    return;
  }

  // Decisive result: WIN or LOSS
  const winnerId = roll.outcome === 'WIN' ? playerId : (playerId === m.playerAId ? m.playerBId : m.playerAId);
  const loserId = winnerId === m.playerAId ? m.playerBId : m.playerAId;

  settleMatchupTx(m.id, winnerId, loserId);

  io.to(`room:${roomId}`).emit('game:matchup_settled', {
    matchupId: m.id,
    winnerId,
    loserId,
    pot: m.pot,
    stake: m.stake,
    finalRoll: rollRecord,
  });

  state.activeMatchup = null;

  // Evict any matchup participant who has been offline for >= 10s (finish 1 active bet first)
  const matchupPlayerIds = [m.playerAId, m.playerBId];
  for (const pid of matchupPlayerIds) {
    const dcTime = userDisconnectTimestamps.get(pid);
    const u = db.prepare('SELECT is_online, display_name FROM users WHERE id = ?').get(pid);
    const isOffline = !u || u.is_online === 0;
    if (isOffline && dcTime && (Date.now() - dcTime >= DISCONNECT_COUNTDOWN_MS)) {
      state.seats = state.seats.filter((s) => s.playerId !== pid).map((s, idx) => ({ ...s, seatIndex: idx }));
      io.to(`room:${roomId}`).emit('table:notice', {
        message: `${u ? u.display_name : 'Player'} auto-exited table after completing active bet while offline.`,
      });
    }
  }

  // Setup next matchup via Circular Turn Rotation (fresh bet required!)
  const next = getNextMatchupAfterResult(state.seats, winnerId, loserId, state.room.rotation_direction);
  if (next) {
    state.pendingMatchup = {
      ...next,
      proposedBy: null,
      proposedStake: null,
      acceptedBy: new Set(),
    };
  } else {
    state.pendingMatchup = null;
  }
  broadcastRoom(roomId);
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, login_id, display_name, role, status, active_session_id FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.status !== 'active') return next(new Error('Account disabled'));
    if (payload.sessionId && user.active_session_id && payload.sessionId !== user.active_session_id) {
      return next(new Error('Session revoked: logged in from another device'));
    }
    socket.user = user;
    socket.sessionId = payload.sessionId;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  userDisconnectTimestamps.delete(userId);
  for (const [key, timer] of waitingEvictionTimers.entries()) {
    if (key.endsWith(`:${userId}`)) {
      clearTimeout(timer);
      waitingEvictionTimers.delete(key);
    }
  }

  db.prepare("UPDATE users SET is_online = 1, last_activity = datetime('now') WHERE id = ?").run(userId);
  if (socket.user.role === 'admin') {
    socket.join('admin:monitor');
  }

  // If user reconnected during an active disconnect countdown, cancel it
  for (const [roomId, state] of roomStates.entries()) {
    if (state.seats.some((s) => s.playerId === userId)) {
      if (state.activeMatchup && state.activeMatchup.currentTurnPlayerId === userId) {
        clearDisconnectTimer(state);
      }
      broadcastRoom(roomId);
    }
  }

  socket.on('room:join', ({ roomId }) => {
    const state = getOrCreateRoomState(roomId);
    if (!state) return socket.emit('error:msg', { message: 'Room not found' });

    socket.join(`room:${roomId}`);
    const alreadySeated = state.seats.some((s) => s.playerId === userId);
    if (!alreadySeated) {
      if (state.seats.length >= state.room.max_players) {
        return socket.emit('error:msg', { message: 'Room is full' });
      }
      state.seats.push({ playerId: userId, seatIndex: state.seats.length });
    }

    // If 2+ players and no active/pending matchup, initialize pending matchup
    if (state.seats.length >= 2 && !state.activeMatchup && !state.pendingMatchup) {
      state.pendingMatchup = {
        playerAId: state.seats[0].playerId,
        playerBId: state.seats[1].playerId,
        firstTurnPlayerId: state.seats[0].playerId,
        proposedBy: null,
        proposedStake: null,
        acceptedBy: new Set(),
      };
    }

    broadcastRoom(roomId);
  });

  socket.on('room:leave', ({ roomId }) => {
    const waitKey = `${roomId}:${userId}`;
    if (waitingEvictionTimers.has(waitKey)) {
      clearTimeout(waitingEvictionTimers.get(waitKey));
      waitingEvictionTimers.delete(waitKey);
    }
    const state = roomStates.get(roomId);
    if (!state) return;
    if (state.activeMatchup && (state.activeMatchup.playerAId === userId || state.activeMatchup.playerBId === userId)) {
      return socket.emit('error:msg', { message: 'Cannot leave during an active locked matchup' });
    }
    state.seats = state.seats.filter((s) => s.playerId !== userId).map((s, idx) => ({ ...s, seatIndex: idx }));
    if (state.pendingMatchup && (state.pendingMatchup.playerAId === userId || state.pendingMatchup.playerBId === userId)) {
      state.pendingMatchup = state.seats.length >= 2 ? {
        playerAId: state.seats[0].playerId,
        playerBId: state.seats[1].playerId,
        firstTurnPlayerId: state.seats[0].playerId,
        proposedBy: null,
        proposedStake: null,
        acceptedBy: new Set(),
      } : null;
    }
    socket.leave(`room:${roomId}`);
    broadcastRoom(roomId);
  });

  socket.on('bet:propose', ({ roomId, stake }) => {
    const state = roomStates.get(roomId);
    if (!state || !state.pendingMatchup) return;
    const pm = state.pendingMatchup;
    if (userId !== pm.playerAId && userId !== pm.playerBId) {
      return socket.emit('error:msg', { message: 'Only players in the matchup can propose a stake' });
    }
    const amt = parseInt(stake, 10);
    if (!amt || amt <= 0) return socket.emit('error:msg', { message: 'Stake must be greater than 0' });

    const u = db.prepare('SELECT available_balance FROM users WHERE id = ?').get(userId);
    if (u.available_balance < amt) return socket.emit('error:msg', { message: 'Insufficient available balance' });

    pm.proposedBy = userId;
    pm.proposedStake = amt;
    pm.acceptedBy = new Set([userId]);
    broadcastRoom(roomId);
  });

  socket.on('bet:accept', ({ roomId }) => {
    const state = roomStates.get(roomId);
    if (!state || !state.pendingMatchup) return;
    const pm = state.pendingMatchup;
    if (userId !== pm.playerAId && userId !== pm.playerBId) return;
    if (!pm.proposedStake) return socket.emit('error:msg', { message: 'No stake proposed yet' });

    // Disconnected player cannot automatically accept
    const u = db.prepare('SELECT available_balance, is_online FROM users WHERE id = ?').get(userId);
    if (!u || !u.is_online) return;
    if (u.available_balance < pm.proposedStake) {
      return socket.emit('error:msg', { message: 'Insufficient available balance to accept stake' });
    }

    pm.acceptedBy.add(userId);

    if (pm.acceptedBy.has(pm.playerAId) && pm.acceptedBy.has(pm.playerBId)) {
      const matchupId = uuidv4();
      try {
        reserveStakesTx(matchupId, roomId, pm.playerAId, pm.playerBId, pm.proposedStake);
      } catch (err) {
        pm.acceptedBy.clear();
        pm.proposedStake = null;
        broadcastRoom(roomId);
        return socket.emit('error:msg', { message: err.message });
      }

      state.activeMatchup = {
        id: matchupId,
        playerAId: pm.playerAId,
        playerBId: pm.playerBId,
        stake: pm.proposedStake,
        pot: pm.proposedStake * 2,
        currentTurnPlayerId: pm.firstTurnPlayerId,
        lastRoll: null,
        rolls: [],
      };
      state.pendingMatchup = null;
      broadcastRoom(roomId);
      scheduleDisconnectAutoRollIfNeeded(roomId);
    } else {
      broadcastRoom(roomId);
    }
  });

  socket.on('game:roll', ({ roomId }) => {
    executeTurnRoll(roomId, userId, false);
  });

  socket.on('heartbeat', () => {
    db.prepare("UPDATE users SET last_activity = datetime('now') WHERE id = ?").run(userId);
  });

  socket.on('disconnect', (reason) => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        userDisconnectTimestamps.set(userId, Date.now());
        db.prepare("UPDATE users SET is_online = 0, last_activity = datetime('now') WHERE id = ?").run(userId);
        const logStatus = reason === 'client namespace disconnect' ? 'logged_out' : 'unexpected_disconnect';
        if (socket.sessionId) {
          db.prepare(`
            UPDATE login_logs
            SET logout_at = datetime('now'), status = ?,
                session_duration_sec = CAST((julianday('now') - julianday(login_at)) * 86400 AS INTEGER)
            WHERE id = ?
          `).run(logStatus, socket.sessionId);
        }

        // Handle offline players across rooms
        for (const [roomId, state] of roomStates.entries()) {
          if (state.seats.some((s) => s.playerId === userId)) {
            broadcastRoom(roomId);
            if (state.activeMatchup) {
              // Complete 1 active bet first: auto-roll if it is their turn
              scheduleDisconnectAutoRollIfNeeded(roomId);
            } else {
              // Outside active matchup: auto-exit after 10 seconds offline
              const waitKey = `${roomId}:${userId}`;
              if (waitingEvictionTimers.has(waitKey)) {
                clearTimeout(waitingEvictionTimers.get(waitKey));
              }
              const timer = setTimeout(() => {
                waitingEvictionTimers.delete(waitKey);
                const u = db.prepare('SELECT is_online, display_name FROM users WHERE id = ?').get(userId);
                if (!u || u.is_online === 0) {
                  const rState = roomStates.get(roomId);
                  if (rState && !rState.activeMatchup && rState.seats.some((s) => s.playerId === userId)) {
                    rState.seats = rState.seats.filter((s) => s.playerId !== userId).map((s, idx) => ({ ...s, seatIndex: idx }));
                    if (rState.pendingMatchup && (rState.pendingMatchup.playerAId === userId || rState.pendingMatchup.playerBId === userId)) {
                      rState.pendingMatchup = rState.seats.length >= 2 ? {
                        playerAId: rState.seats[0].playerId,
                        playerBId: rState.seats[1].playerId,
                        firstTurnPlayerId: rState.seats[0].playerId,
                        proposedBy: null,
                        proposedStake: null,
                        acceptedBy: new Set(),
                      } : null;
                    }
                    io.to(`room:${roomId}`).emit('table:notice', {
                      message: `${u ? u.display_name : 'Player'} auto-exited table after staying offline for 10 seconds.`,
                    });
                    broadcastRoom(roomId);
                  }
                }
              }, DISCONNECT_COUNTDOWN_MS);
              waitingEvictionTimers.set(waitKey, timer);
            }
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dice Royale Server running on http://localhost:${PORT}`);
  console.log(`Admin Dashboard available at http://localhost:${PORT}/admin`);
});
