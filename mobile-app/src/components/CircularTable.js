import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';

const { width } = Dimensions.get('window');
const TABLE_SIZE = Math.min(width - 36, 360);
const RADIUS = TABLE_SIZE / 2 - 26;

export default function CircularTable({
  seats = [],
  activeMatchup,
  pendingMatchup,
  countdownSec,
  currentUserId,
}) {
  const matchup = activeMatchup || pendingMatchup;

  const getPlayerName = (id) => {
    const found = seats.find((s) => s.playerId === id);
    return found ? found.displayName : 'Player';
  };

  return (
    <View style={styles.wrapper}>
      <View style={[styles.tableOuter, { width: TABLE_SIZE, height: TABLE_SIZE, borderRadius: TABLE_SIZE / 2 }]}>
        <View style={[styles.tableFelt, { width: TABLE_SIZE - 16, height: TABLE_SIZE - 16, borderRadius: (TABLE_SIZE - 16) / 2 }]}>
          {/* Center Table Info */}
          <View style={styles.centerBox}>
            {matchup ? (
              <>
                <Text style={styles.matchupLabel}>
                  {getPlayerName(matchup.playerAId)} vs {getPlayerName(matchup.playerBId)}
                </Text>
                {activeMatchup ? (
                  <>
                    <Text style={styles.potText}>POT: {activeMatchup.pot} 🪙</Text>
                    <Text style={styles.turnText}>
                      Turn: {getPlayerName(activeMatchup.currentTurnPlayerId)}
                      {activeMatchup.currentTurnPlayerId === currentUserId ? ' (YOU)' : ''}
                    </Text>
                    {countdownSec !== null && countdownSec > 0 && (
                      <View style={styles.countdownPill}>
                        <Text style={styles.countdownText}>
                          Auto-roll in {countdownSec}s (Offline)
                        </Text>
                      </View>
                    )}
                    {activeMatchup.lastRoll && (
                      <View style={styles.diceRow}>
                        <View style={styles.die}>
                          <Text style={styles.dieText}>{activeMatchup.lastRoll.d1}</Text>
                        </View>
                        <View style={styles.die}>
                          <Text style={styles.dieText}>{activeMatchup.lastRoll.d2}</Text>
                        </View>
                        <Text
                          style={[
                            styles.outcomeBadge,
                            activeMatchup.lastRoll.outcome === 'WIN'
                              ? styles.winColor
                              : activeMatchup.lastRoll.outcome === 'LOSS'
                              ? styles.lossColor
                              : styles.passColor,
                          ]}
                        >
                          {activeMatchup.lastRoll.outcome}
                        </Text>
                      </View>
                    )}
                  </>
                ) : (
                  <Text style={styles.waitingText}>
                    {pendingMatchup?.proposedStake
                      ? `Proposed Stake: ${pendingMatchup.proposedStake} 🪙`
                      : 'Propose a fresh bet'}
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.waitingText}>Waiting for 2+ players...</Text>
            )}
          </View>
        </View>

        {/* Circular Seats */}
        {seats.map((seat, idx) => {
          const angle = (idx / Math.max(seats.length, 1)) * 2 * Math.PI - Math.PI / 2;
          const x = TABLE_SIZE / 2 + RADIUS * Math.cos(angle) - 40;
          const y = TABLE_SIZE / 2 + RADIUS * Math.sin(angle) - 28;
          const isInMatchup =
            matchup && (seat.playerId === matchup.playerAId || seat.playerId === matchup.playerBId);
          const isTurn = activeMatchup && activeMatchup.currentTurnPlayerId === seat.playerId;

          return (
            <View
              key={seat.playerId}
              style={[
                styles.seatCard,
                { left: x, top: y },
                isInMatchup && styles.seatMatchup,
                isTurn && styles.seatTurn,
              ]}
            >
              <View style={styles.seatHeader}>
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: seat.isOnline ? '#10B981' : '#EF4444' },
                  ]}
                />
                <Text style={styles.seatName} numberOfLines={1}>
                  {seat.displayName}
                </Text>
              </View>
              <Text style={styles.seatBalance}>{seat.availableBalance} 🪙</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', justifyContent: 'center', marginVertical: 14 },
  tableOuter: {
    backgroundColor: '#2B2214',
    borderWidth: 3,
    borderColor: '#D4AF37',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tableFelt: {
    backgroundColor: '#0D3B2A',
    borderWidth: 2,
    borderColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  centerBox: { alignItems: 'center', justifyContent: 'center', maxWidth: 185 },
  matchupLabel: { color: '#F3F4F6', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  potText: { color: '#D4AF37', fontWeight: '800', fontSize: 15, marginTop: 4 },
  turnText: { color: '#10B981', fontWeight: '600', fontSize: 12, marginTop: 2, textAlign: 'center' },
  waitingText: { color: '#9CA3AF', fontSize: 12, textAlign: 'center', marginTop: 4 },
  countdownPill: { backgroundColor: 'rgba(239,68,68,0.22)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginTop: 6 },
  countdownText: { color: '#FCA5A5', fontSize: 11, fontWeight: '700' },
  diceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  die: { width: 32, height: 32, borderRadius: 6, backgroundColor: '#F9FAFB', alignItems: 'center', justifyContent: 'center' },
  dieText: { color: '#111827', fontWeight: '900', fontSize: 16 },
  outcomeBadge: { fontWeight: '800', fontSize: 12 },
  winColor: { color: '#10B981' },
  lossColor: { color: '#EF4444' },
  passColor: { color: '#FBBF24' },
  seatCard: {
    position: 'absolute',
    width: 80,
    backgroundColor: '#121A17',
    borderWidth: 1,
    borderColor: '#2A3F37',
    borderRadius: 10,
    padding: 6,
    alignItems: 'center',
  },
  seatMatchup: { borderColor: '#D4AF37', borderWidth: 1.5 },
  seatTurn: { borderColor: '#10B981', borderWidth: 2, backgroundColor: '#132A21' },
  seatHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  seatName: { color: '#F9FAFB', fontSize: 11, fontWeight: '700', maxWidth: 56 },
  seatBalance: { color: '#D4AF37', fontSize: 11, fontWeight: '700', marginTop: 2 },
});
