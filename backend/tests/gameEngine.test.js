const assert = require('assert');
const { evaluateRoll, normalizeDice, getNextMatchupAfterResult } = require('../src/gameEngine');

// 1. Test unordered normalization
assert.strictEqual(normalizeDice(1, 2), '1-2');
assert.strictEqual(normalizeDice(2, 1), '1-2');

// 2. Test official WIN combinations
for (const [d1, d2] of [[3, 3], [5, 5], [5, 6], [6, 5], [6, 6]]) {
  assert.strictEqual(evaluateRoll(d1, d2).outcome, 'WIN', `Expected WIN for ${d1}-${d2}`);
}

// 3. Test official LOSS combinations
for (const [d1, d2] of [[1, 1], [1, 2], [2, 1], [2, 2], [4, 4]]) {
  assert.strictEqual(evaluateRoll(d1, d2).outcome, 'LOSS', `Expected LOSS for ${d1}-${d2}`);
}

// 4. Test official PASS combinations
for (const [d1, d2] of [[1, 3], [1, 6], [2, 4], [3, 5], [4, 6]]) {
  assert.strictEqual(evaluateRoll(d1, d2).outcome, 'PASS', `Expected PASS for ${d1}-${d2}`);
}

// 5. Test circular turn rotation (6 players: A, B, C, D, E, F)
const seats = ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) => ({ playerId: id, seatIndex: i }));
// Suppose A and B play and A loses -> B stays active, next opponent is next to A (clockwise: B is skipped because B is winner -> C; or counter-clockwise: F)
const nextCW = getNextMatchupAfterResult(seats, 'B', 'A', 1);
assert.strictEqual(nextCW.playerAId, 'B');
assert.strictEqual(nextCW.playerBId, 'C');
assert.strictEqual(nextCW.firstTurnPlayerId, 'B');

const nextCCW = getNextMatchupAfterResult(seats, 'B', 'A', -1);
assert.strictEqual(nextCCW.playerAId, 'B');
assert.strictEqual(nextCCW.playerBId, 'F');

// 6. Test 2-player fallback
const twoSeats = [{ playerId: 'A', seatIndex: 0 }, { playerId: 'B', seatIndex: 1 }];
const nextTwo = getNextMatchupAfterResult(twoSeats, 'B', 'A', 1);
assert.strictEqual(nextTwo.playerAId, 'B');
assert.strictEqual(nextTwo.playerBId, 'A');

console.log('ALL DICE ROYALE GAME ENGINE TESTS PASSED!');
