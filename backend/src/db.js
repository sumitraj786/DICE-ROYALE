const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}
const DB_PATH = path.join(DB_DIR, 'dice_royale.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'player', -- 'player' | 'admin'
      status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
      must_change_password INTEGER NOT NULL DEFAULT 1,
      avatar_color TEXT NOT NULL DEFAULT '#D4AF37',
      initial_balance INTEGER NOT NULL DEFAULT 0,
      available_balance INTEGER NOT NULL DEFAULT 0,
      reserved_balance INTEGER NOT NULL DEFAULT 0,
      total_wagered INTEGER NOT NULL DEFAULT 0,
      total_won INTEGER NOT NULL DEFAULT 0,
      total_lost INTEGER NOT NULL DEFAULT 0,
      is_online INTEGER NOT NULL DEFAULT 0,
      active_session_id TEXT,
      last_activity TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      max_players INTEGER NOT NULL DEFAULT 8,
      min_players INTEGER NOT NULL DEFAULT 2,
      rotation_direction INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'waiting', -- 'waiting' | 'playing'
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matchups (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      player_a_id TEXT NOT NULL,
      player_b_id TEXT NOT NULL,
      stake INTEGER NOT NULL DEFAULT 0,
      pot INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'active' | 'settled' | 'cancelled'
      winner_id TEXT,
      loser_id TEXT,
      settled INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS rolls (
      id TEXT PRIMARY KEY,
      matchup_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      dice_1 INTEGER NOT NULL,
      dice_2 INTEGER NOT NULL,
      combo_key TEXT NOT NULL,
      outcome TEXT NOT NULL, -- 'WIN' | 'LOSS' | 'PASS'
      is_auto_roll INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (matchup_id) REFERENCES matchups(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL, -- 'initial_allocation' | 'bet_reserve' | 'bet_win' | 'bet_refund' | 'admin_credit' | 'admin_debit'
      amount INTEGER NOT NULL,
      before_available INTEGER NOT NULL,
      after_available INTEGER NOT NULL,
      before_reserved INTEGER NOT NULL,
      after_reserved INTEGER NOT NULL,
      reason TEXT,
      reference_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      login_at TEXT NOT NULL DEFAULT (datetime('now')),
      logout_at TEXT,
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      session_duration_sec INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online', -- 'online' | 'logged_out' | 'unexpected_disconnect'
      ip_address TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      amount INTEGER,
      reason TEXT NOT NULL,
      transaction_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
      admin_id TEXT,
      admin_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Safe migration check for existing databases
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((c) => c.name === 'active_session_id')) {
    db.exec("ALTER TABLE users ADD COLUMN active_session_id TEXT;");
  }
}

function seedDefaults() {
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminExists) {
    const adminId = uuidv4();
    const adminPass = process.env.ADMIN_PASSWORD || 'Admin@12345';
    const hash = bcrypt.hashSync(adminPass, 10);
    db.prepare(`
      INSERT INTO users (id, login_id, display_name, password_hash, role, status, must_change_password, avatar_color)
      VALUES (?, 'admin', 'System Administrator', ?, 'admin', 'active', 0, '#10B981')
    `).run(adminId, hash);
  }

  // Seed 2 default private rooms so lobby is ready immediately
  const roomCount = db.prepare('SELECT COUNT(*) as cnt FROM rooms').get().cnt;
  if (roomCount === 0) {
    db.prepare(`
      INSERT INTO rooms (id, code, name, max_players, min_players, rotation_direction)
      VALUES (?, 'ROYALE1', 'Emerald High-Roller Table', 8, 2, 1)
    `).run(uuidv4());
    db.prepare(`
      INSERT INTO rooms (id, code, name, max_players, min_players, rotation_direction)
      VALUES (?, 'GOLD777', 'VIP Friends Circle', 6, 2, 1)
    `).run(uuidv4());
  }
}

// Atomic wallet reservation for both players before a matchup starts
const reserveStakesTx = db.transaction((matchupId, roomId, playerAId, playerBId, stake) => {
  if (stake <= 0 || !Number.isInteger(stake)) {
    throw new Error('Stake must be a positive integer');
  }
  const pA = db.prepare('SELECT * FROM users WHERE id = ?').get(playerAId);
  const pB = db.prepare('SELECT * FROM users WHERE id = ?').get(playerBId);
  if (!pA || !pB) throw new Error('Player not found');
  if (pA.available_balance < stake) throw new Error(`${pA.display_name} has insufficient available coins`);
  if (pB.available_balance < stake) throw new Error(`${pB.display_name} has insufficient available coins`);

  for (const p of [pA, pB]) {
    const afterAvail = p.available_balance - stake;
    const afterRes = p.reserved_balance + stake;
    db.prepare(`
      UPDATE users SET available_balance = ?, reserved_balance = ?, total_wagered = total_wagered + ?
      WHERE id = ?
    `).run(afterAvail, afterRes, stake, p.id);

    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, reference_id)
      VALUES (?, ?, 'bet_reserve', ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), p.id, -stake, p.available_balance, afterAvail, p.reserved_balance, afterRes, 'Matchup stake reserved', matchupId);
  }

  db.prepare(`
    INSERT INTO matchups (id, room_id, player_a_id, player_b_id, stake, pot, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(matchupId, roomId, playerAId, playerBId, stake, stake * 2);
});

// Atomic settlement — guaranteed to run at most once per matchup
const settleMatchupTx = db.transaction((matchupId, winnerId, loserId) => {
  const m = db.prepare('SELECT * FROM matchups WHERE id = ?').get(matchupId);
  if (!m) throw new Error('Matchup not found');
  if (m.settled === 1) return { alreadySettled: true, matchup: m };

  const winner = db.prepare('SELECT * FROM users WHERE id = ?').get(winnerId);
  const loser = db.prepare('SELECT * FROM users WHERE id = ?').get(loserId);
  if (!winner || !loser) throw new Error('Winner or loser not found');

  const pot = m.pot;
  const stake = m.stake;

  // Winner receives full pot into available_balance and clears their reserved stake
  const wAfterAvail = winner.available_balance + pot;
  const wAfterRes = Math.max(0, winner.reserved_balance - stake);
  db.prepare(`
    UPDATE users SET available_balance = ?, reserved_balance = ?, total_won = total_won + ?
    WHERE id = ?
  `).run(wAfterAvail, wAfterRes, stake, winner.id);

  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, reference_id)
    VALUES (?, ?, 'bet_win', ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), winner.id, pot, winner.available_balance, wAfterAvail, winner.reserved_balance, wAfterRes, 'Matchup pot won', matchupId);

  // Loser clears their reserved stake and records loss
  const lAfterRes = Math.max(0, loser.reserved_balance - stake);
  db.prepare(`
    UPDATE users SET reserved_balance = ?, total_lost = total_lost + ?
    WHERE id = ?
  `).run(lAfterRes, stake, loser.id);

  db.prepare(`
    UPDATE matchups
    SET status = 'settled', settled = 1, winner_id = ?, loser_id = ?, ended_at = datetime('now')
    WHERE id = ?
  `).run(winnerId, loserId, matchupId);

  return { alreadySettled: false, pot, stake };
});

// Atomic admin credit/debit with mandatory reason & immutable audit log
const adminAdjustWalletTx = db.transaction((adminId, targetUserId, delta, reason) => {
  if (!reason || !reason.trim()) throw new Error('Reason is mandatory for wallet adjustment');
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Adjustment amount must be a non-zero integer');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
  if (!user) throw new Error('Player not found');

  const afterAvail = user.available_balance + delta;
  if (afterAvail < 0) throw new Error('Insufficient available balance for debit');

  db.prepare('UPDATE users SET available_balance = ? WHERE id = ?').run(afterAvail, user.id);

  const txId = uuidv4();
  const txType = delta > 0 ? 'admin_credit' : 'admin_debit';
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, user.id, txType, delta, user.available_balance, afterAvail, user.reserved_balance, user.reserved_balance, reason.trim(), adminId);

  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, amount, reason, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), adminId, txType, user.id, delta, reason.trim(), txId);

  return { txId, afterAvail };
});

// Atomic player withdrawal request: moves amount from available to reserved
const requestWithdrawalTx = db.transaction((userId, amount, note) => {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Withdrawal amount must be a positive integer');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Player not found');
  if (user.status !== 'active') throw new Error('Account is not active');
  if (user.available_balance < amount) {
    throw new Error(`Insufficient available balance (Available: ${user.available_balance} 🪙)`);
  }

  const afterAvail = user.available_balance - amount;
  const afterRes = user.reserved_balance + amount;

  db.prepare(`
    UPDATE users SET available_balance = ?, reserved_balance = ?
    WHERE id = ?
  `).run(afterAvail, afterRes, user.id);

  const reqId = uuidv4();
  db.prepare(`
    INSERT INTO withdrawal_requests (id, user_id, amount, note, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(reqId, user.id, amount, note ? String(note).trim() : null);

  const txId = uuidv4();
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, reference_id)
    VALUES (?, ?, 'withdrawal_request', ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, user.id, -amount, user.available_balance, afterAvail, user.reserved_balance, afterRes, note ? `Withdrawal requested: ${note}` : 'Coin withdrawal request', reqId);

  return { id: reqId, amount, afterAvail, afterRes, status: 'pending' };
});

// Atomic admin withdrawal approval: deducts reserved balance, marks approved
const approveWithdrawalTx = db.transaction((adminId, requestId, adminReason) => {
  const req = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('Withdrawal request not found');
  if (req.status !== 'pending') throw new Error(`Withdrawal request is already ${req.status}`);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
  if (!user) throw new Error('Player not found');

  const afterRes = Math.max(0, user.reserved_balance - req.amount);

  db.prepare(`
    UPDATE users SET reserved_balance = ? WHERE id = ?
  `).run(afterRes, user.id);

  db.prepare(`
    UPDATE withdrawal_requests
    SET status = 'approved', admin_id = ?, admin_reason = ?, processed_at = datetime('now')
    WHERE id = ?
  `).run(adminId, adminReason ? String(adminReason).trim() : 'Approved by admin', req.id);

  const txId = uuidv4();
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, reference_id, created_by)
    VALUES (?, ?, 'withdrawal_approved', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, user.id, -req.amount, user.available_balance, user.available_balance, user.reserved_balance, afterRes, adminReason ? `Withdrawal approved: ${adminReason}` : 'Withdrawal approved by admin', req.id, adminId);

  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, amount, reason, transaction_id)
    VALUES (?, ?, 'withdrawal_approved', ?, ?, ?, ?)
  `).run(uuidv4(), adminId, user.id, req.amount, adminReason ? String(adminReason).trim() : 'Withdrawal approved', txId);

  return { id: req.id, userId: user.id, amount: req.amount, status: 'approved' };
});

// Atomic admin withdrawal rejection: refunds reserved balance back to available balance
const rejectWithdrawalTx = db.transaction((adminId, requestId, adminReason) => {
  if (!adminReason || !String(adminReason).trim()) {
    throw new Error('Admin reason is mandatory for rejecting a withdrawal');
  }

  const req = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('Withdrawal request not found');
  if (req.status !== 'pending') throw new Error(`Withdrawal request is already ${req.status}`);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
  if (!user) throw new Error('Player not found');

  const afterAvail = user.available_balance + req.amount;
  const afterRes = Math.max(0, user.reserved_balance - req.amount);

  db.prepare(`
    UPDATE users SET available_balance = ?, reserved_balance = ? WHERE id = ?
  `).run(afterAvail, afterRes, user.id);

  db.prepare(`
    UPDATE withdrawal_requests
    SET status = 'rejected', admin_id = ?, admin_reason = ?, processed_at = datetime('now')
    WHERE id = ?
  `).run(adminId, String(adminReason).trim(), req.id);

  const txId = uuidv4();
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, before_available, after_available, before_reserved, after_reserved, reason, reference_id, created_by)
    VALUES (?, ?, 'withdrawal_rejected', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, user.id, req.amount, user.available_balance, afterAvail, user.reserved_balance, afterRes, `Withdrawal rejected: ${adminReason.trim()}`, req.id, adminId);

  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, amount, reason, transaction_id)
    VALUES (?, ?, 'withdrawal_rejected', ?, ?, ?, ?)
  `).run(uuidv4(), adminId, user.id, req.amount, String(adminReason).trim(), txId);

  return { id: req.id, userId: user.id, amount: req.amount, status: 'rejected' };
});

initSchema();
seedDefaults();

module.exports = {
  db,
  reserveStakesTx,
  settleMatchupTx,
  adminAdjustWalletTx,
  requestWithdrawalTx,
  approveWithdrawalTx,
  rejectWithdrawalTx,
};
