let token = localStorage.getItem('dr_admin_token') || '';
let currentTab = 'dashboard';

const titles = {
  'dashboard': 'Dashboard',
  'players': 'Players',
  'create-player': 'Create Player',
  'withdrawals': 'Withdrawals',
  'online-users': 'Online Users',
  'game-tables': 'Game Tables',
  'bets-games': 'Bets and Games',
  'transactions': 'Transactions',
  'login-logs': 'Login Logs',
  'wallet-adjustments': 'Wallet Adjustments',
  'audit-logs': 'Audit Logs',
  'settings': 'Settings',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const loginId = document.getElementById('login-id').value;
  const password = document.getElementById('login-pass').value;
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginId, password }),
    });
    if (res.user.role !== 'admin') throw new Error('Administrator role required');
    token = res.token;
    localStorage.setItem('dr_admin_token', token);
    showApp();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('dr_admin_token');
  token = '';
  location.reload();
});

document.getElementById('refresh-btn').addEventListener('click', () => renderTab(currentTab));

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    document.getElementById('page-title').textContent = titles[currentTab] || currentTab;
    renderTab(currentTab);
  });
});

function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  renderTab(currentTab);
}

async function renderTab(tab) {
  const container = document.getElementById('tab-content');
  container.innerHTML = '<p class="muted">Loading...</p>';
  try {
    if (tab === 'dashboard') {
      const d = await api('/api/admin/overview');
      container.innerHTML = `
        <div class="cards-grid">
          <div class="stat-card"><div class="stat-label">Registered Players</div><div class="stat-value">${d.totalPlayers}</div></div>
          <div class="stat-card"><div class="stat-label">Online Players</div><div class="stat-value">${d.onlinePlayers}</div></div>
          <div class="stat-card"><div class="stat-label">Active Tables</div><div class="stat-value">${d.activeTables}</div></div>
          <div class="stat-card"><div class="stat-label">Games In Progress</div><div class="stat-value">${d.gamesInProgress}</div></div>
          <div class="stat-card"><div class="stat-label">Coins In Circulation</div><div class="stat-value gold">${d.totalCoins}</div></div>
        </div>
        <div class="panel">
          <h3>Recent Completed & Active Games</h3>
          <table><thead><tr><th>Room</th><th>Matchup</th><th>Stake</th><th>Pot</th><th>Status</th></tr></thead>
          <tbody>${d.recentGames.map(g => `<tr><td>${g.room_name}</td><td>${g.player_a_name} vs ${g.player_b_name}</td><td>${g.stake}</td><td>${g.pot}</td><td><span class="badge badge-online">${g.status}</span></td></tr>`).join('')}</tbody></table>
        </div>
        <div class="panel">
          <h3>Recent Wallet Transactions</h3>
          <table><thead><tr><th>Player</th><th>Type</th><th>Amount</th><th>After Avail</th><th>Reason</th></tr></thead>
          <tbody>${d.recentTransactions.map(t => `<tr><td>${t.display_name}</td><td>${t.type}</td><td>${t.amount}</td><td>${t.after_available}</td><td>${t.reason || '-'}</td></tr>`).join('')}</tbody></table>
        </div>`;
    } else if (tab === 'players') {
      const players = await api('/api/admin/players');
      container.innerHTML = `
        <div class="panel">
          <h3>All Player Accounts</h3>
          <table><thead><tr><th>Name</th><th>Login ID</th><th>Available</th><th>Reserved</th><th>Status</th><th>Online</th><th>Actions</th></tr></thead>
          <tbody>${players.map(p => `
            <tr>
              <td>${p.display_name}</td>
              <td>${p.login_id}</td>
              <td>${p.available_balance}</td>
              <td>${p.reserved_balance}</td>
              <td><span class="badge ${p.status === 'active' ? 'badge-online' : 'badge-danger'}">${p.status}</span></td>
              <td><span class="badge ${p.is_online ? 'badge-online' : 'badge-offline'}">${p.is_online ? 'Online' : 'Offline'}</span></td>
              <td>
                <button class="btn-sm" onclick="togglePlayerStatus('${p.id}', '${p.status === 'active' ? 'disabled' : 'active'}')">${p.status === 'active' ? 'Disable' : 'Activate'}</button>
                <button class="btn-sm" onclick="resetPlayerPass('${p.id}')">Reset Pass</button>
              </td>
            </tr>`).join('')}</tbody></table>
        </div>`;
    } else if (tab === 'create-player') {
      container.innerHTML = `
        <div class="panel form-grid">
          <h3>Create New Player Account</h3>
          <form id="create-player-form">
            <label>Player Name</label><input id="cp-name" required />
            <label>Unique Login ID</label><input id="cp-login" required />
            <label>Temporary Password</label><input id="cp-pass" type="text" value="Welcome@123" required />
            <label>Initial Coin Balance</label><input id="cp-bal" type="number" value="1000" min="0" required />
            <label>Account Status</label><select id="cp-status"><option value="active">Active</option><option value="disabled">Disabled</option></select>
            <button type="submit" class="btn-primary">Create Player</button>
            <p id="cp-msg" class="muted" style="margin-top:10px;"></p>
          </form>
        </div>`;
      document.getElementById('create-player-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('cp-msg');
        try {
          await api('/api/admin/players', {
            method: 'POST',
            body: JSON.stringify({
              displayName: document.getElementById('cp-name').value,
              loginId: document.getElementById('cp-login').value,
              temporaryPassword: document.getElementById('cp-pass').value,
              initialBalance: document.getElementById('cp-bal').value,
              status: document.getElementById('cp-status').value,
            }),
          });
          msg.textContent = 'Player created successfully! Share the login ID and temporary password privately.';
          msg.style.color = '#10b981';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#ef4444';
        }
      });
    } else if (tab === 'withdrawals') {
      const withdrawals = await api('/api/admin/withdrawals');
      window.allWithdrawals = withdrawals;
      container.innerHTML = `
        <div class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
            <h3>Coin Withdrawal Requests</h3>
            <div>
              <label style="display:inline;margin-right:8px;font-size:12px;">Filter Status:</label>
              <select id="w-filter" style="width:auto;display:inline-block;padding:6px 10px;" onchange="filterWithdrawals(this.value)">
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Login ID</th>
                <th>Amount</th>
                <th>Player Note</th>
                <th>Status</th>
                <th>Requested At</th>
                <th>Processed At</th>
                <th>Admin Reason</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="w-tbody">
              ${renderWithdrawalRows(withdrawals)}
            </tbody>
          </table>
        </div>`;
    } else if (tab === 'online-users' || tab === 'login-logs') {
      const logs = await api('/api/admin/online-users');
      container.innerHTML = `
        <div class="panel">
          <h3>${titles[tab]}</h3>
          <table><thead><tr><th>Player</th><th>Login ID</th><th>Status</th><th>Login At</th><th>Logout At</th><th>Duration (s)</th><th>Last Activity</th></tr></thead>
          <tbody>${logs.map(l => `<tr><td>${l.display_name}</td><td>${l.login_id}</td><td><span class="badge ${l.status === 'online' ? 'badge-online' : l.status === 'unexpected_disconnect' ? 'badge-danger' : 'badge-offline'}">${l.status}</span></td><td>${l.login_at}</td><td>${l.logout_at || '-'}</td><td>${l.session_duration_sec || 0}</td><td>${l.last_activity}</td></tr>`).join('')}</tbody></table>
        </div>`;
    } else if (tab === 'game-tables') {
      const tables = await api('/api/admin/tables');
      container.innerHTML = tables.map(t => `
        <div class="panel">
          <h3>${t.room.name} (${t.room.code}) — ${t.seats.length}/${t.room.max_players} Seated</h3>
          <p class="muted">Active Matchup: ${t.activeMatchup ? `${t.activeMatchup.stake} coins/player (Pot: ${t.activeMatchup.pot})` : 'None'}</p>
          <table><thead><tr><th>Seat</th><th>Player</th><th>Available</th><th>Reserved</th><th>Status</th></tr></thead>
          <tbody>${t.seats.map(s => `<tr><td>#${s.seatIndex + 1}</td><td>${s.displayName}</td><td>${s.availableBalance}</td><td>${s.reservedBalance}</td><td>${s.isOnline ? 'Online' : 'Offline'}</td></tr>`).join('')}</tbody></table>
        </div>`).join('');
    } else if (tab === 'bets-games') {
      const games = await api('/api/admin/games');
      container.innerHTML = `<div class="panel"><h3>Matchup History</h3><table><thead><tr><th>Room</th><th>Players</th><th>Stake</th><th>Pot</th><th>Status</th><th>Started</th></tr></thead><tbody>${games.map(g => `<tr><td>${g.room_name}</td><td>${g.player_a_name} vs ${g.player_b_name}</td><td>${g.stake}</td><td>${g.pot}</td><td>${g.status}</td><td>${g.started_at}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'transactions') {
      const txs = await api('/api/admin/transactions');
      container.innerHTML = `<div class="panel"><h3>Wallet Ledger</h3><table><thead><tr><th>Player</th><th>Type</th><th>Amount</th><th>Before</th><th>After</th><th>Reason</th><th>Date</th></tr></thead><tbody>${txs.map(t => `<tr><td>${t.display_name}</td><td>${t.type}</td><td>${t.amount}</td><td>${t.before_available}</td><td>${t.after_available}</td><td>${t.reason || '-'}</td><td>${t.created_at}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'wallet-adjustments') {
      const players = await api('/api/admin/players');
      container.innerHTML = `
        <div class="panel form-grid">
          <h3>Credit / Debit Player Wallet</h3>
          <form id="adj-form">
            <label>Select Player</label>
            <select id="adj-user">${players.map(p => `<option value="${p.id}">${p.display_name} (${p.login_id}) — Bal: ${p.available_balance}</option>`).join('')}</select>
            <label>Amount (positive to credit, negative to debit)</label>
            <input id="adj-amt" type="number" required />
            <label>Mandatory Reason</label>
            <input id="adj-reason" required placeholder="e.g., Weekly top-up" />
            <button type="submit" class="btn-primary">Apply Adjustment</button>
            <p id="adj-msg" class="muted" style="margin-top:10px;"></p>
          </form>
        </div>`;
      document.getElementById('adj-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('adj-msg');
        try {
          await api('/api/admin/wallet/adjust', {
            method: 'POST',
            body: JSON.stringify({
              userId: document.getElementById('adj-user').value,
              amount: document.getElementById('adj-amt').value,
              reason: document.getElementById('adj-reason').value,
            }),
          });
          msg.textContent = 'Wallet adjusted and recorded in immutable audit log.';
          msg.style.color = '#10b981';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#ef4444';
        }
      });
    } else if (tab === 'audit-logs') {
      const logs = await api('/api/admin/audit-logs');
      container.innerHTML = `<div class="panel"><h3>Immutable Audit Logs</h3><table><thead><tr><th>Admin</th><th>Action</th><th>Target Player</th><th>Amount</th><th>Reason</th><th>Timestamp</th></tr></thead><tbody>${logs.map(l => `<tr><td>${l.admin_name || l.admin_id}</td><td>${l.action}</td><td>${l.target_name || l.target_user_id || '-'}</td><td>${l.amount ?? '-'}</td><td>${l.reason}</td><td>${l.created_at}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'settings') {
      container.innerHTML = `
        <div class="panel form-grid">
          <h3>Create New Private Table Room</h3>
          <form id="room-form">
            <label>Room Name</label><input id="rm-name" required placeholder="e.g., Midnight Lounge" />
            <label>Room Code</label><input id="rm-code" required placeholder="e.g., NIGHT99" />
            <label>Max Players (2-8)</label><input id="rm-max" type="number" min="2" max="8" value="8" required />
            <button type="submit" class="btn-primary">Create Room</button>
            <p id="rm-msg" class="muted" style="margin-top:10px;"></p>
          </form>
        </div>
        <div class="panel form-grid">
          <h3>Change Admin Password</h3>
          <form id="admin-pass-form">
            <label>Current Password</label><input id="ap-cur" type="password" required />
            <label>New Password (min 6 chars)</label><input id="ap-new" type="password" minlength="6" required />
            <button type="submit" class="btn-primary">Update Admin Password</button>
            <p id="ap-msg" class="muted" style="margin-top:10px;"></p>
          </form>
        </div>`;
      document.getElementById('room-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('rm-msg');
        try {
          await api('/api/admin/rooms', {
            method: 'POST',
            body: JSON.stringify({
              name: document.getElementById('rm-name').value,
              code: document.getElementById('rm-code').value,
              maxPlayers: document.getElementById('rm-max').value,
            }),
          });
          msg.textContent = 'Room created!';
          msg.style.color = '#10b981';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#ef4444';
        }
      });
      document.getElementById('admin-pass-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('ap-msg');
        try {
          await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
              currentPassword: document.getElementById('ap-cur').value,
              newPassword: document.getElementById('ap-new').value,
            }),
          });
          msg.textContent = 'Admin password updated! Use the new password next time you sign in.';
          msg.style.color = '#10b981';
          document.getElementById('admin-pass-form').reset();
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#ef4444';
        }
      });
    }
  } catch (err) {
    container.innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

window.togglePlayerStatus = async (id, status) => {
  await api(`/api/admin/players/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  renderTab('players');
};

window.resetPlayerPass = async (id) => {
  const temporaryPassword = prompt('Enter new temporary password (min 6 chars):');
  if (!temporaryPassword) return;
  await api(`/api/admin/players/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ temporaryPassword }) });
  alert('Temporary password reset.');
};

function renderWithdrawalRows(list) {
  if (!list || list.length === 0) {
    return '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px;">No withdrawal requests found.</td></tr>';
  }
  return list.map(w => `
    <tr>
      <td><strong>${w.display_name}</strong></td>
      <td>${w.login_id}</td>
      <td class="gold" style="font-weight:700;">${w.amount} 🪙</td>
      <td>${w.note ? w.note : '<span class="muted">-</span>'}</td>
      <td>
        <span class="badge ${w.status === 'pending' ? 'badge-warning' : w.status === 'approved' ? 'badge-online' : 'badge-danger'}">
          ${w.status.toUpperCase()}
        </span>
      </td>
      <td>${w.created_at}</td>
      <td>${w.processed_at ? `${w.processed_at} (${w.admin_name || 'Admin'})` : '<span class="muted">-</span>'}</td>
      <td>${w.admin_reason ? w.admin_reason : '<span class="muted">-</span>'}</td>
      <td>
        ${w.status === 'pending' ? `
          <button class="btn-sm" style="background:#10b981;color:#05120d;font-weight:700;margin-right:6px;" onclick="approveWithdrawal('${w.id}')">Approve</button>
          <button class="btn-sm btn-danger" onclick="rejectWithdrawal('${w.id}')">Reject</button>
        ` : `<span class="muted">Processed</span>`}
      </td>
    </tr>
  `).join('');
}

window.filterWithdrawals = (status) => {
  const tbody = document.getElementById('w-tbody');
  if (!tbody || !window.allWithdrawals) return;
  const filtered = status === 'all' ? window.allWithdrawals : window.allWithdrawals.filter(w => w.status === status);
  tbody.innerHTML = renderWithdrawalRows(filtered);
};

window.approveWithdrawal = async (id) => {
  const reason = prompt('Optional approval note (or press OK to confirm):', 'Approved');
  if (reason === null) return;
  try {
    await api(`/api/admin/withdrawals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || 'Approved' }),
    });
    alert('Withdrawal request approved successfully.');
    renderTab('withdrawals');
  } catch (err) {
    alert('Approval failed: ' + err.message);
  }
};

window.rejectWithdrawal = async (id) => {
  const reason = prompt('Mandatory rejection reason (coins will be refunded to player):');
  if (reason === null) return;
  if (!reason.trim()) {
    alert('A reason is mandatory to reject a withdrawal.');
    return;
  }
  try {
    await api(`/api/admin/withdrawals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
    alert('Withdrawal request rejected. Coins refunded to player.');
    renderTab('withdrawals');
  } catch (err) {
    alert('Rejection failed: ' + err.message);
  }
};

if (token) showApp();