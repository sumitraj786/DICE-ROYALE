const crypto = require('crypto');

/**
 * Official Dice Royale unordered two-dice rules.
 * Combinations are normalized as [min, max].
 */
const WIN_COMBOS = new Set(['3-3', '5-5', '5-6', '6-6']);
const LOSS_COMBOS = new Set(['1-1', '1-2', '2-2', '4-4']);

function normalizeDice(d1, d2) {
  const a = Math.min(d1, d2);
  const b = Math.max(d1, d2);
  return `${a}-${b}`;
}

function evaluateRoll(d1, d2) {
  if (d1 < 1 || d1 > 6 || d2 < 1 || d2 > 6) {
    throw new Error('Dice values must be between 1 and 6');
  }
  const key = normalizeDice(d1, d2);
  if (WIN_COMBOS.has(key)) return { outcome: 'WIN', key };
  if (LOSS_COMBOS.has(key)) return { outcome: 'LOSS', key };
  return { outcome: 'PASS', key };
}

function rollTwoDiceSecure() {
  const d1 = crypto.randomInt(1, 7);
  const d2 = crypto.randomInt(1, 7);
  const { outcome, key } = evaluateRoll(d1, d2);
  return { d1, d2, key, outcome };
}

/**
 * Circular Turn Rotation:
 * Winner stays active for the next matchup.
 * Next opponent is the player sitting next to the previous loser
 * following the circular seating order (direction = 1 clockwise, -1 counter-clockwise).
 * With 2 players, the same 2 players continue.
 */
function getNextMatchupAfterResult(seats, winnerId, loserId, direction = 1) {
  const n = seats.length;
  if (n < 2) return null;
  if (n === 2) {
    return {
      playerAId: winnerId,
      playerBId: loserId,
      firstTurnPlayerId: winnerId,
    };
  }

  const loserIdx = seats.findIndex((s) => s.playerId === loserId);
  if (loserIdx === -1) return null;

  // Step from loser in configured direction to find the next seated player who isn't the winner
  for (let step = 1; step < n; step++) {
    const idx = (loserIdx + step * direction + n * 10) % n;
    const candidate = seats[idx];
    if (candidate && candidate.playerId !== winnerId && candidate.playerId !== loserId) {
      return {
        playerAId: winnerId,
        playerBId: candidate.playerId,
        firstTurnPlayerId: winnerId,
      };
    }
  }

  // Fallback for 2 active players
  return {
    playerAId: winnerId,
    playerBId: loserId,
    firstTurnPlayerId: winnerId,
  };
}

module.exports = {
  WIN_COMBOS,
  LOSS_COMBOS,
  normalizeDice,
  evaluateRoll,
  rollTwoDiceSecure,
  getNextMatchupAfterResult,
};
