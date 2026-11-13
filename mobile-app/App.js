import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Alert,
  Modal,
} from 'react-native';
import { io } from 'socket.io-client';
import { API_BASE_URL, SOCKET_URL } from './src/config';
import CircularTable from './src/components/CircularTable';

export default function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [rooms, setRooms] = useState([]);
  const [roomState, setRoomState] = useState(null);
  const [stakeInput, setStakeInput] = useState('50');
  const [countdownSec, setCountdownSec] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [bannerMsg, setBannerMsg] = useState('');
  const socketRef = useRef(null);

  async function apiFetch(path, opts = {}) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  const handleLogin = async () => {
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId, password }),
      });
      setToken(data.token);
      setUser(data.user);
    } catch (err) {
      Alert.alert('Login Failed', err.message);
    }
  };

  const handleChangePassword = async () => {
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      setUser({ ...user, mustChangePassword: false });
      Alert.alert('Success', 'Password updated!');
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  useEffect(() => {
    if (!token || user?.mustChangePassword) return;

    apiFetch('/api/rooms').then(setRooms).catch(() => {});

    const socket = io(SOCKET_URL, { auth: { token } });
    socketRef.current = socket;

    socket.on('room:state', (state) => {
      setRoomState(state);
    });

    socket.on('game:matchup_settled', (res) => {
      setBannerMsg(`Matchup settled! Winner takes ${res.pot} coins.`);
      setTimeout(() => setBannerMsg(''), 4000);
    });

    socket.on('error:msg', (err) => {
      Alert.alert('Notice', err.message);
    });

    const hb = setInterval(() => socket.emit('heartbeat'), 5000);

    return () => {
      clearInterval(hb);
      socket.disconnect();
    };
  }, [token, user?.mustChangePassword]);

  // Countdown timer ticker for disconnected player
  useEffect(() => {
    if (!roomState?.countdownDeadline) {
      setCountdownSec(null);
      return;
    }
    const timer = setInterval(() => {
      const rem = Math.max(0, Math.ceil((roomState.countdownDeadline - Date.now()) / 1000));
      setCountdownSec(rem);
    }, 300);
    return () => clearInterval(timer);
  }, [roomState?.countdownDeadline]);

  if (!token) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.brand}>DICE ROYALE</Text>
          <Text style={styles.subtitle}>Private Multiplayer Table</Text>
          <TextInput
            style={styles.input}
            placeholder="Login ID (provided by Admin)"
            placeholderTextColor="#6B7280"
            value={loginId}
            onChangeText={setLoginId}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#6B7280"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          <TouchableOpacity style={styles.btnPrimary} onPress={handleLogin}>
            <Text style={styles.btnText}>Sign In</Text>
          </TouchableOpacity>
          <Text style={styles.note}>Public registration is disabled. Contact Admin for an account.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (user?.mustChangePassword) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.brand}>Update Password</Text>
          <Text style={styles.subtitle}>First login requires changing your temporary password.</Text>
          <TextInput
            style={styles.input}
            placeholder="New Password (min 6 chars)"
            placeholderTextColor="#6B7280"
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
          />
          <TouchableOpacity style={styles.btnPrimary} onPress={handleChangePassword}>
            <Text style={styles.btnText}>Save New Password</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Room Table View
  if (roomState) {
    const { room, seats, activeMatchup, pendingMatchup } = roomState;
    const isMyTurn = activeMatchup && activeMatchup.currentTurnPlayerId === user.id;
    const amInPending = pendingMatchup && (pendingMatchup.playerAId === user.id || pendingMatchup.playerBId === user.id);
    const hasAccepted = pendingMatchup && pendingMatchup.acceptedBy?.includes(user.id);

    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.tableScreen}>
          <View style={styles.topBar}>
            <View>
              <Text style={styles.roomTitle}>{room.name}</Text>
              <Text style={styles.roomSub}>Code: {room.code} • {seats.length}/{room.max_players} Players</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={styles.btnSmall} onPress={() => setShowRules(true)}>
                <Text style={styles.btnSmallText}>Rules</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSmall, { borderColor: '#EF4444' }]}
                onPress={() => {
                  socketRef.current.emit('room:leave', { roomId: room.id });
                  setRoomState(null);
                }}
              >
                <Text style={[styles.btnSmallText, { color: '#EF4444' }]}>Leave</Text>
              </TouchableOpacity>
            </View>
          </View>

          {!!bannerMsg && (
            <View style={styles.banner}><Text style={styles.bannerText}>{bannerMsg}</Text></View>
          )}

          <CircularTable
            seats={seats}
            activeMatchup={activeMatchup}
            pendingMatchup={pendingMatchup}
            countdownSec={countdownSec}
            currentUserId={user.id}
          />

          {/* Controls */}
          {activeMatchup ? (
            <TouchableOpacity
              style={[styles.rollBtn, !isMyTurn && styles.btnDisabled]}
              disabled={!isMyTurn}
              onPress={() => socketRef.current.emit('game:roll', { roomId: room.id })}
            >
              <Text style={styles.rollBtnText}>
                {isMyTurn ? 'ROLL TWO DICE' : 'Waiting for Opponent...'}
              </Text>
            </TouchableOpacity>
          ) : amInPending ? (
            <View style={styles.betBox}>
              <Text style={styles.betTitle}>Fresh Matchup Bet (Winner Takes Loser)</Text>
              <View style={styles.betRow}>
                <TextInput
                  style={[styles.input, { flex: 1, marginBottom: 0 }]}
                  keyboardType="numeric"
                  value={stakeInput}
                  onChangeText={setStakeInput}
                  placeholder="Stake"
                />
                <TouchableOpacity
                  style={styles.btnGold}
                  onPress={() => socketRef.current.emit('bet:propose', { roomId: room.id, stake: parseInt(stakeInput, 10) })}
                >
                  <Text style={styles.btnText}>Propose</Text>
                </TouchableOpacity>
              </View>
              {pendingMatchup?.proposedStake && !hasAccepted && (
                <TouchableOpacity
                  style={[styles.btnPrimary, { marginTop: 10 }]}
                  onPress={() => socketRef.current.emit('bet:accept', { roomId: room.id })}
                >
                  <Text style={styles.btnText}>Accept Stake ({pendingMatchup.proposedStake} 🪙)</Text>
                </TouchableOpacity>
              )}
              {hasAccepted && (
                <Text style={styles.note}>Waiting for opponent to accept {pendingMatchup.proposedStake} coins...</Text>
              )}
            </View>
          ) : (
            <Text style={styles.note}>Watching table. You will rotate in automatically.</Text>
          )}
        </ScrollView>

        <Modal visible={showRules} transparent animationType="slide">
          <View style={styles.modalBg}>
            <View style={styles.card}>
              <Text style={styles.brand}>Official Dice Rules</Text>
              <Text style={styles.ruleText}>• WIN: 3-3, 5-5, 5-6, 6-6</Text>
              <Text style={styles.ruleText}>• LOSS: 1-1, 1-2, 2-2, 4-4</Text>
              <Text style={styles.ruleText}>• PASS: All other combinations pass the turn.</Text>
              <Text style={styles.ruleText}>• Winner stays active; loser rotates out.</Text>
              <Text style={styles.ruleText}>• 10s offline countdown triggers server auto-roll.</Text>
              <TouchableOpacity style={styles.btnPrimary} onPress={() => setShowRules(false)}>
                <Text style={styles.btnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // Lobby View
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.lobby}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.brand}>DICE ROYALE</Text>
            <Text style={styles.subtitle}>Welcome, {user.displayName}</Text>
          </View>
          <TouchableOpacity onPress={() => { setToken(null); setUser(null); }}>
            <Text style={{ color: '#EF4444', fontWeight: '700' }}>Logout</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.walletCard}>
          <Text style={styles.walletLabel}>Available Balance</Text>
          <Text style={styles.walletVal}>{user.availableBalance} 🪙</Text>
        </View>

        <Text style={styles.sectionTitle}>Private Gaming Rooms</Text>
        {rooms.map((r) => (
          <TouchableOpacity
            key={r.id}
            style={styles.roomCard}
            onPress={() => socketRef.current.emit('room:join', { roomId: r.id })}
          >
            <View>
              <Text style={styles.roomTitle}>{r.name}</Text>
              <Text style={styles.roomSub}>Code: {r.code} • {r.seatedCount}/{r.max_players} seated</Text>
            </View>
            <Text style={styles.joinText}>JOIN →</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0F0E', justifyContent: 'center' },
  card: { backgroundColor: '#121A17', margin: 20, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: '#23332D' },
  brand: { color: '#D4AF37', fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  subtitle: { color: '#9CA3AF', fontSize: 13, marginBottom: 18, marginTop: 4 },
  input: { backgroundColor: '#0B0F0E', color: '#F9FAFB', borderWidth: 1, borderColor: '#23332D', borderRadius: 10, padding: 12, marginBottom: 12 },
  btnPrimary: { backgroundColor: '#10B981', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnGold: { backgroundColor: '#D4AF37', paddingHorizontal: 18, justifyContent: 'center', borderRadius: 10 },
  btnText: { color: '#05120D', fontWeight: '800', fontSize: 15 },
  note: { color: '#9CA3AF', fontSize: 12, textAlign: 'center', marginTop: 12 },
  lobby: { padding: 20 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  walletCard: { backgroundColor: '#121A17', borderWidth: 1, borderColor: '#D4AF37', borderRadius: 14, padding: 18, marginBottom: 20 },
  walletLabel: { color: '#9CA3AF', fontSize: 12 },
  walletVal: { color: '#D4AF37', fontSize: 28, fontWeight: '900', marginTop: 4 },
  sectionTitle: { color: '#F9FAFB', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  roomCard: { backgroundColor: '#121A17', borderWidth: 1, borderColor: '#23332D', borderRadius: 12, padding: 16, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  roomTitle: { color: '#F9FAFB', fontSize: 16, fontWeight: '700' },
  roomSub: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  joinText: { color: '#10B981', fontWeight: '800' },
  tableScreen: { padding: 16 },
  btnSmall: { borderWidth: 1, borderColor: '#23332D', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  btnSmallText: { color: '#F9FAFB', fontSize: 12, fontWeight: '700' },
  rollBtn: { backgroundColor: '#10B981', padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  btnDisabled: { backgroundColor: '#1F2937', opacity: 0.6 },
  rollBtnText: { color: '#05120D', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
  betBox: { backgroundColor: '#121A17', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#23332D', marginTop: 10 },
  betTitle: { color: '#D4AF37', fontWeight: '700', marginBottom: 8 },
  betRow: { flexDirection: 'row', gap: 8 },
  banner: { backgroundColor: 'rgba(16,185,129,0.2)', padding: 10, borderRadius: 8, marginBottom: 8 },
  bannerText: { color: '#10B981', fontWeight: '700', textAlign: 'center' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center' },
  ruleText: { color: '#E5E7EB', fontSize: 14, marginBottom: 8 },
});
