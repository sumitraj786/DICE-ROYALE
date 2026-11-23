const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const {
  db,
  requestWithdrawalTx,
  approveWithdrawalTx,
  rejectWithdrawalTx,
  adminAdjustWalletTx,
} = require('../src/db');

console.log('--- Running features test suite ---');

// 1. Verify schema migrations
const userCols = db.prepare("PRAGMA table_info(users)").all();
assert(userCols.some((c) => c.name === 'active_session_id'), 'users table should have active_session_id');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
assert(tables.some((t) => t.name === 'withdrawal_requests'), 'withdrawal_requests table should exist');

// 2. Create test admin and test player
const adminId = uuidv4();
const playerId = uuidv4();

const existing = db.prepare("SELECT id FROM users WHERE login_id IN ('test_admin_feat', 'test_player_feat')").all();
for (const u of existing) {
  db.prepare('DELETE FROM audit_logs WHERE admin_id = ? OR target_user_id = ?').run(u.id, u.id);
  db.prepare('DELETE FROM transactions WHERE user_id = ? OR created_by = ?').run(u.id, u.id);
  db.prepare('DELETE FROM withdrawal_requests WHERE user_id = ? OR admin_id = ?').run(u.id, u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
}

db.prepare(`
  INSERT INTO users (id, login_id, display_name, password_hash, role, status, available_balance, reserved_balance, initial_balance)
  VALUES (?, 'test_admin_feat', 'Test Admin', 'hash', 'admin', 'active', 0, 0, 0)
`).run(adminId);

db.prepare(`
  INSERT INTO users (id, login_id, display_name, password_hash, role, status, available_balance, reserved_balance, initial_balance)
  VALUES (?, 'test_player_feat', 'Test Player', 'hash', 'player', 'active', 500, 0, 500)
`).run(playerId);

// 3. Test Withdrawal Request
console.log('Testing requestWithdrawalTx...');
const reqResult = requestWithdrawalTx(playerId, 200, 'Test withdrawal request');
assert.strictEqual(reqResult.amount, 200);

let player = db.prepare('SELECT available_balance, reserved_balance FROM users WHERE id = ?').get(playerId);
assert.strictEqual(player.available_balance, 300, 'Available balance should be 300');
assert.strictEqual(player.reserved_balance, 200, 'Reserved balance should be 200');

// Test over-withdrawal
assert.throws(() => {
  requestWithdrawalTx(playerId, 400, 'Exceeds balance');
}, /Insufficient available balance/);

// 4. Test Rejecting Withdrawal
console.log('Testing rejectWithdrawalTx...');
const rejectResult = rejectWithdrawalTx(adminId, reqResult.id, 'Test admin rejection note');
assert.strictEqual(rejectResult.status, 'rejected');

player = db.prepare('SELECT available_balance, reserved_balance FROM users WHERE id = ?').get(playerId);
assert.strictEqual(player.available_balance, 500, 'Available balance should be refunded to 500');
assert.strictEqual(player.reserved_balance, 0, 'Reserved balance should be back to 0');

const reqRecord = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(reqResult.id);
assert.strictEqual(reqRecord.status, 'rejected');
assert.strictEqual(reqRecord.admin_reason, 'Test admin rejection note');

// 5. Test Approving Withdrawal
console.log('Testing approveWithdrawalTx...');
const reqResult2 = requestWithdrawalTx(playerId, 150, 'Second request');
const approveResult = approveWithdrawalTx(adminId, reqResult2.id, 'Approved by admin');
assert.strictEqual(approveResult.status, 'approved');

player = db.prepare('SELECT available_balance, reserved_balance FROM users WHERE id = ?').get(playerId);
assert.strictEqual(player.available_balance, 350, 'Available balance should be 350');
assert.strictEqual(player.reserved_balance, 0, 'Reserved balance should be 0 after deduction');

const reqRecord2 = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(reqResult2.id);
assert.strictEqual(reqRecord2.status, 'approved');

// 6. Test Single Session ID update
console.log('Testing active_session_id update...');
const session1 = uuidv4();
db.prepare('UPDATE users SET active_session_id = ? WHERE id = ?').run(session1, playerId);
player = db.prepare('SELECT active_session_id FROM users WHERE id = ?').get(playerId);
assert.strictEqual(player.active_session_id, session1);

const session2 = uuidv4();
db.prepare('UPDATE users SET active_session_id = ? WHERE id = ?').run(session2, playerId);
player = db.prepare('SELECT active_session_id FROM users WHERE id = ?').get(playerId);
assert.strictEqual(player.active_session_id, session2);
assert.notStrictEqual(player.active_session_id, session1);

// Cleanup test users
db.prepare('DELETE FROM audit_logs WHERE admin_id = ? OR target_user_id = ?').run(adminId, playerId);
db.prepare('DELETE FROM transactions WHERE user_id = ?').run(playerId);
db.prepare('DELETE FROM withdrawal_requests WHERE user_id = ?').run(playerId);
db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(adminId, playerId);

console.log('All feature tests passed successfully!');
