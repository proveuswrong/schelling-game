import { v4 as uuidv4 } from 'uuid';
import { verifyCommit, computeRoundResult, applyBalanceChanges } from './gameLogic.js';
import db from './db.js';
import QUESTIONS from './questions.js';

const STARTING_BALANCE = 1000;
const ROUND_STAKE = 100;
const COMMIT_DURATION_NORMAL = 30;   // seconds
const COMMIT_DURATION_ESTIMATION = 60;
const REVEAL_DURATION = 15;
const RESULTS_DURATION = 12;
const MAX_CHAT_LENGTH = 300;

// In-memory store of all rooms
const rooms = new Map();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj, excludeUsername = null) {
  for (const [username, player] of room.players) {
    if (username !== excludeUsername) {
      send(player.ws, obj);
    }
  }
}

function broadcastAll(room, obj) {
  broadcast(room, obj, null);
}

function getPublicPlayers(room) {
  return Array.from(room.players.values()).map(p => ({
    username: p.username,
    balance: p.balance,
    isConnected: p.isConnected,
    isHost: p.username === room.host,
    hasCommitted: !!p.committed,
    hasRevealed: !!p.revealed,
  }));
}

function selectQuestions(totalRounds) {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, totalRounds);
}

// ---------------------------------------------------------------------------
// Phase management
// ---------------------------------------------------------------------------

function startCommitPhase(room) {
  room.phase = 'commit';
  clearTimers(room);

  const question = room.questions[room.currentRound];
  const isEstimation = question.category === 'estimation';
  const commitDuration = isEstimation ? COMMIT_DURATION_ESTIMATION : COMMIT_DURATION_NORMAL;

  // Reset per-round player state
  for (const p of room.players.values()) {
    p.committed = false;
    p.revealed = false;
    p.score = null;
    p.hash = null;
    p.salt = null;
  }
  room.leakReports = [];

  broadcastAll(room, {
    type: 'round_start',
    round: room.currentRound + 1,
    question,
    commitDuration,
    phase: 'commit',
  });

  room.commitTimer = setTimeout(() => startRevealPhase(room), commitDuration * 1000);
}

function startRevealPhase(room) {
  clearTimers(room);
  room.phase = 'reveal';

  broadcastAll(room, {
    type: 'phase_change',
    phase: 'reveal',
    revealDuration: REVEAL_DURATION,
  });

  room.revealTimer = setTimeout(() => finaliseRound(room), REVEAL_DURATION * 1000);
}

function finaliseRound(room) {
  clearTimers(room);
  room.phase = 'results';

  const question = room.questions[room.currentRound];
  const playerDataForLogic = Array.from(room.players.values()).map(p => ({
    username: p.username,
    score: p.score,
    balance: p.balance,
    stake: Math.min(ROUND_STAKE, p.balance > 0 ? p.balance : 0),
    hash: p.hash,
    committed: p.committed,
    revealed: p.revealed,
  }));

  const result = computeRoundResult(
    playerDataForLogic,
    room.leakReports,
    room.chatMessages,
    room.currentRound,
  );

  // Apply balance changes
  if (!result.cancelled) {
    const changes = applyBalanceChanges(
      Array.from(room.players.values()),
      result,
    );
    for (const { username, newBalance } of changes) {
      const p = room.players.get(username);
      if (p) p.balance = newBalance;
    }
    // Annotate result players with new balance
    for (const pr of result.players) {
      const p = room.players.get(pr.username);
      if (p) pr.newBalance = p.balance;
    }
  } else {
    for (const pr of result.players) {
      const p = room.players.get(pr.username);
      if (p) pr.newBalance = p.balance;
    }
  }

  result.roundNum = room.currentRound + 1;

  // Log to DB
  const playerCount = room.players.size;
  for (const pr of result.players) {
    db.insertVoteLog({
      sessionId: room.sessionId,
      roundNumber: room.currentRound + 1,
      questionId: question.id,
      username: pr.username,
      revealedScore: pr.score,
      mu: result.mu,
      sigma: result.sigma,
      isCoherent: pr.coherent,
      slashAmount: pr.slash,
      rewardAmount: pr.reward,
      isLeaker: pr.isLeaker,
      playerCount,
    });
  }

  broadcastAll(room, { type: 'round_result', result });

  // Advance after results display
  room.resultsTimer = setTimeout(() => {
    room.currentRound++;
    if (room.currentRound >= room.totalRounds) {
      endGame(room);
    } else {
      startCommitPhase(room);
    }
  }, RESULTS_DURATION * 1000);
}

function endGame(room) {
  clearTimers(room);
  room.phase = 'lobby';

  const summary = {
    players: Array.from(room.players.values()).map(p => ({
      username: p.username,
      finalBalance: p.balance,
      profit: p.balance - STARTING_BALANCE,
    })).sort((a, b) => b.finalBalance - a.finalBalance),
  };

  // Update global DB stats
  for (const p of room.players.values()) {
    db.updatePlayerStats(p.username, {
      roundsPlayed: room.totalRounds,
      coherentRounds: p.coherentRoundsThisGame || 0,
      scoreChange: p.balance - STARTING_BALANCE,
    });
    p.coherentRoundsThisGame = 0;
  }

  broadcastAll(room, { type: 'game_over', summary });

  // Reset room for potential replay
  room.currentRound = 0;
  room.questions = [];
}

function clearTimers(room) {
  clearTimeout(room.commitTimer);
  clearTimeout(room.revealTimer);
  clearTimeout(room.resultsTimer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a newly connected WebSocket. Returns the room code if joined.
 */
function handleMessage(ws, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  switch (msg.type) {
    case 'join':       return handleJoin(ws, msg);
    case 'start_game': return handleStartGame(ws);
    case 'commit':     return handleCommit(ws, msg);
    case 'reveal':     return handleReveal(ws, msg);
    case 'chat':       return handleChat(ws, msg);
    case 'report_leak': return handleReportLeak(ws, msg);
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

function handleJoin(ws, msg) {
  const { username, roomCode, roundCount } = msg;
  if (!username || !roomCode) {
    return send(ws, { type: 'error', message: 'username and roomCode required' });
  }
  if (!/^[A-Za-z0-9_\-]{1,20}$/.test(username)) {
    return send(ws, { type: 'error', message: 'Username must be 1-20 characters (letters, digits, _ or -)' });
  }
  const code = roomCode.toUpperCase();

  db.upsertPlayer(username);

  let room = rooms.get(code);
  if (!room) {
    // Create new room
    room = {
      code,
      host: username,
      players: new Map(),
      phase: 'lobby',
      currentRound: 0,
      totalRounds: [5, 7, 10].includes(roundCount) ? roundCount : 10,
      questions: [],
      chatMessages: [],
      leakReports: [],
      commitTimer: null,
      revealTimer: null,
      resultsTimer: null,
      sessionId: uuidv4(),
    };
    rooms.set(code, room);
  }

  // Reconnect existing player or add new one
  let player = room.players.get(username);
  if (player) {
    player.ws = ws;
    player.isConnected = true;
  } else {
    if (room.phase !== 'lobby') {
      return send(ws, { type: 'error', message: 'Game already in progress' });
    }
    player = {
      username,
      ws,
      balance: STARTING_BALANCE,
      committed: false,
      revealed: false,
      score: null,
      hash: null,
      salt: null,
      stake: 0,
      isConnected: true,
      coherentRoundsThisGame: 0,
    };
    room.players.set(username, player);
  }

  // Tag ws with room and username for disconnect tracking
  ws._roomCode = code;
  ws._username = username;

  send(ws, {
    type: 'room_state',
    room: {
      code,
      host: room.host,
      phase: room.phase,
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
    },
    players: getPublicPlayers(room),
    myBalance: player.balance,
  });

  // Broadcast updated player list
  broadcast(room, {
    type: 'room_state',
    room: {
      code,
      host: room.host,
      phase: room.phase,
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
    },
    players: getPublicPlayers(room),
  }, username);
}

function handleStartGame(ws) {
  const room = getRoomForWs(ws);
  if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
  if (ws._username !== room.host) return send(ws, { type: 'error', message: 'Only the host can start the game' });
  if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'Game already started' });
  if (room.players.size < 1) return send(ws, { type: 'error', message: 'Need at least 1 player' });

  room.questions = selectQuestions(room.totalRounds);
  room.currentRound = 0;

  // Reset balances
  for (const p of room.players.values()) {
    p.balance = STARTING_BALANCE;
    p.coherentRoundsThisGame = 0;
  }

  broadcastAll(room, {
    type: 'game_started',
    roundCount: room.totalRounds,
    firstRound: {
      round: 1,
      question: room.questions[0],
    },
  });

  startCommitPhase(room);
}

function handleCommit(ws, msg) {
  const room = getRoomForWs(ws);
  if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
  if (room.phase !== 'commit') return send(ws, { type: 'error', message: 'Not in commit phase' });

  const { hash } = msg;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    return send(ws, { type: 'error', message: 'Invalid hash format (expected 64-char hex)' });
  }

  const player = room.players.get(ws._username);
  if (!player) return send(ws, { type: 'error', message: 'Player not found' });
  if (player.committed) return send(ws, { type: 'error', message: 'Already committed' });

  player.committed = true;
  player.hash = hash;

  // Broadcast commit status
  broadcastAll(room, {
    type: 'commit_status',
    committed: Array.from(room.players.values()).map(p => ({
      username: p.username,
      hasCommitted: p.committed,
    })),
  });

  // Auto-advance if all players committed
  const allCommitted = Array.from(room.players.values()).every(p => p.committed);
  if (allCommitted) {
    clearTimeout(room.commitTimer);
    startRevealPhase(room);
  }
}

function handleReveal(ws, msg) {
  const room = getRoomForWs(ws);
  if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
  if (room.phase !== 'reveal') return send(ws, { type: 'error', message: 'Not in reveal phase' });

  const { score, salt } = msg;
  if (typeof score !== 'number' || score < 0 || score > 1) {
    return send(ws, { type: 'error', message: 'score must be a number in [0,1]' });
  }
  if (typeof salt !== 'string' || !/^[0-9a-f]+$/.test(salt)) {
    return send(ws, { type: 'error', message: 'salt must be a hex string' });
  }

  const player = room.players.get(ws._username);
  if (!player) return send(ws, { type: 'error', message: 'Player not found' });
  if (!player.committed) return send(ws, { type: 'error', message: 'Did not commit' });
  if (player.revealed) return send(ws, { type: 'error', message: 'Already revealed' });

  // Verify hash
  if (!verifyCommit(score, salt, player.hash)) {
    return send(ws, { type: 'error', message: 'Hash mismatch — reveal does not match commitment' });
  }

  player.revealed = true;
  player.score = Math.round(score * 100) / 100;
  player.salt = salt;

  // Broadcast reveal status
  broadcastAll(room, {
    type: 'reveal_status',
    revealed: Array.from(room.players.values()).map(p => ({
      username: p.username,
      hasRevealed: p.revealed,
    })),
  });

  // Auto-advance if all committed players have revealed
  const committedPlayers = Array.from(room.players.values()).filter(p => p.committed);
  const allRevealed = committedPlayers.length > 0 && committedPlayers.every(p => p.revealed);
  if (allRevealed) {
    clearTimeout(room.revealTimer);
    finaliseRound(room);
  }
}

function handleChat(ws, msg) {
  const room = getRoomForWs(ws);
  if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
  if (room.phase !== 'commit' && room.phase !== 'lobby') {
    return send(ws, { type: 'error', message: 'Chat only allowed in lobby or commit phase' });
  }

  const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return;

  const messageId = uuidv4();
  const chatMsg = { id: messageId, username: ws._username, text, timestamp: Date.now() };
  room.chatMessages.push(chatMsg);

  broadcastAll(room, {
    type: 'chat',
    from: ws._username,
    text,
    messageId,
  });
}

function handleReportLeak(ws, msg) {
  const room = getRoomForWs(ws);
  if (!room) return send(ws, { type: 'error', message: 'Not in a room' });

  const { messageId, suspectUsername } = msg;
  if (!messageId || !suspectUsername) {
    return send(ws, { type: 'error', message: 'messageId and suspectUsername required' });
  }
  if (suspectUsername === ws._username) {
    return send(ws, { type: 'error', message: 'Cannot report yourself' });
  }

  // Deduplicate reports
  const alreadyReported = room.leakReports.some(
    r => r.messageId === messageId && r.reporterUsername === ws._username
  );
  if (!alreadyReported) {
    room.leakReports.push({
      messageId,
      reporterUsername: ws._username,
      suspectUsername,
    });
  }

  send(ws, { type: 'report_ack', messageId });
}

function handleDisconnect(ws) {
  const { _roomCode, _username } = ws;
  if (!_roomCode || !_username) return;
  const room = rooms.get(_roomCode);
  if (!room) return;

  const player = room.players.get(_username);
  if (player) {
    player.isConnected = false;
    broadcastAll(room, {
      type: 'room_state',
      room: {
        code: room.code,
        host: room.host,
        phase: room.phase,
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
      },
      players: getPublicPlayers(room),
    });
  }
}

function getRoomForWs(ws) {
  return ws._roomCode ? rooms.get(ws._roomCode) : null;
}

export { handleMessage, handleDisconnect, rooms };
