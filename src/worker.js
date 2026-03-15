import { verifyCommit, computeRoundResult, applyBalanceChanges } from './gameLogic.js';
import QUESTIONS from './questions.js';

const STARTING_BALANCE = 1000;
const ROUND_STAKE = 100;
const COMMIT_DURATION_NORMAL = 30;
const COMMIT_DURATION_ESTIMATION = 60;
const REVEAL_DURATION = 15;
const RESULTS_DURATION = 12;
const MAX_CHAT_LENGTH = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const roomCode = url.searchParams.get('room');
      if (!roomCode) return new Response('missing room', { status: 400 });
      const id = env.GAME_ROOM.idFromName(roomCode.toUpperCase());
      return env.GAME_ROOM.get(id).fetch(request);
    }
    if (url.pathname === '/api/leaderboard') {
      const { results } = await env.DB.prepare('SELECT * FROM players ORDER BY global_score DESC, coherent_rounds DESC LIMIT 50').all();
      return Response.json(results);
    }
    if (url.pathname === '/api/leaderboard/me') {
      const username = url.searchParams.get('username');
      if (!username) return Response.json({ error: 'username required' }, { status: 400 });
      const player = await env.DB.prepare('SELECT * FROM players WHERE username = ?').bind(username).first();
      if (!player) return Response.json({ error: 'Player not found' }, { status: 404 });
      const rankRow = await env.DB.prepare('SELECT COUNT(*) as rank FROM players WHERE global_score > ?').bind(player.global_score).first();
      return Response.json({ ...player, rank: (rankRow?.rank ?? 0) + 1 });
    }
    if (url.pathname === '/api/export/votes.csv') {
      const { results } = await env.DB.prepare('SELECT * FROM vote_logs ORDER BY id ASC').all();
      const headers = ['id','session_id','round_number','question_id','username','revealed_score','mu','sigma','is_coherent','created_at'];
      const csv = [headers.join(','), ...results.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
      return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="votes.csv"' } });
    }
    return new Response('Not found', { status: 404 });
  }
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.gameState = null;
    this.roundTimer = null;
    this.sessionId = null;
    this.state.blockConcurrencyWhile(async () => {
      this.gameState = await this.state.storage.get('gameState') || null;
      this.sessionId = await this.state.storage.get('sessionId') || null;
    });
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws) {
    ws.accept();
    const sessionKey = crypto.randomUUID();
    this.sessions.set(sessionKey, { ws, username: null, committed: false, revealed: false });

    ws.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(sessionKey, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });

    ws.addEventListener('close', () => {
      const session = this.sessions.get(sessionKey);
      if (session) {
        this.sessions.delete(sessionKey);
        if (session.username) {
          this.broadcast({ type: 'player_left', username: session.username });
          this.broadcastPlayerList();
        }
      }
    });

    if (this.gameState) {
      ws.send(JSON.stringify({ type: 'game_state', state: this.sanitizeState(this.gameState) }));
    } else {
      ws.send(JSON.stringify({ type: 'waiting' }));
    }
  }

  async handleMessage(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    if (msg.type === 'join') {
      const username = msg.username?.trim().slice(0, 20);
      if (!username) return;
      session.username = username;
      this.broadcast({ type: 'player_joined', username });
      this.broadcastPlayerList();
      if (!this.gameState && this.sessions.size >= 2) {
        await this.startGame();
      } else if (this.gameState) {
        session.ws.send(JSON.stringify({ type: 'game_state', state: this.sanitizeState(this.gameState) }));
      }
      return;
    }

    if (!session.username) return;

    if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, MAX_CHAT_LENGTH);
      this.broadcast({ type: 'chat', username: session.username, text });
      return;
    }

    if (msg.type === 'commit') {
      if (!this.gameState || this.gameState.phase !== 'commit') return;
      if (session.committed) return;
      const valid = verifyCommit(msg.commitment, msg.salt, msg.value);
      if (!valid) {
        session.ws.send(JSON.stringify({ type: 'error', message: 'Invalid commitment' }));
        return;
      }
      session.committed = true;
      if (!this.gameState.commits) this.gameState.commits = {};
      this.gameState.commits[session.username] = { commitment: msg.commitment, salt: msg.salt };
      await this.state.storage.put('gameState', this.gameState);
      this.broadcast({ type: 'committed', username: session.username });
      if (this.allCommitted()) await this.startReveal();
      return;
    }

    if (msg.type === 'reveal') {
      if (!this.gameState || this.gameState.phase !== 'reveal') return;
      if (session.revealed) return;
      const commit = this.gameState.commits?.[session.username];
      if (!commit) return;
      const valid = verifyCommit(commit.commitment, msg.salt, msg.value);
      if (!valid) {
        session.ws.send(JSON.stringify({ type: 'error', message: 'Invalid reveal' }));
        return;
      }
      session.revealed = true;
      if (!this.gameState.reveals) this.gameState.reveals = {};
      this.gameState.reveals[session.username] = { value: msg.value, salt: msg.salt };
      await this.state.storage.put('gameState', this.gameState);
      this.broadcast({ type: 'revealed', username: session.username });
      if (this.allRevealed()) await this.computeResults();
      return;
    }
  }

  allCommitted() {
    const players = [...this.sessions.values()].filter(s => s.username);
    return players.every(s => s.committed);
  }

  allRevealed() {
    const players = [...this.sessions.values()].filter(s => s.username && this.gameState.commits?.[s.username]);
    return players.every(s => s.revealed);
  }

  async startGame() {
    if (!this.sessionId) {
      this.sessionId = crypto.randomUUID();
      await this.state.storage.put('sessionId', this.sessionId);
    }
    const question = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const duration = question.type === 'estimation' ? COMMIT_DURATION_ESTIMATION : COMMIT_DURATION_NORMAL;
    this.gameState = {
      phase: 'commit',
      question,
      roundNumber: (this.gameState?.roundNumber || 0) + 1,
      commits: {},
      reveals: {},
      startedAt: Date.now(),
      duration,
    };
    await this.state.storage.put('gameState', this.gameState);
    this.broadcast({ type: 'game_started', state: this.sanitizeState(this.gameState) });
    this.schedulePhaseEnd(duration, () => this.startReveal());
  }

  async startReveal() {
    if (this.gameState.phase !== 'commit') return;
    this.gameState.phase = 'reveal';
    this.gameState.startedAt = Date.now();
    this.gameState.duration = REVEAL_DURATION;
    await this.state.storage.put('gameState', this.gameState);
    this.broadcast({ type: 'phase_changed', phase: 'reveal', state: this.sanitizeState(this.gameState) });
    this.schedulePhaseEnd(REVEAL_DURATION, () => this.computeResults());
  }

  async computeResults() {
    if (this.gameState.phase !== 'reveal') return;
    this.gameState.phase = 'results';
    const reveals = this.gameState.reveals || {};
    const result = computeRoundResult(this.gameState.question, reveals);
    this.gameState.results = result;

    const players = [...this.sessions.values()].filter(s => s.username);
    const usernamesInRound = Object.keys(reveals);

    for (const username of usernamesInRound) {
      const playerResult = result.playerResults[username];
      if (!playerResult) continue;
      await this.env.DB.prepare(`
        INSERT INTO players (username, global_score, coherent_rounds)
        VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          global_score = global_score + excluded.global_score,
          coherent_rounds = coherent_rounds + excluded.coherent_rounds
      `).bind(username, playerResult.scoreChange, playerResult.isCoherent ? 1 : 0).run();

      await this.env.DB.prepare(`
        INSERT INTO vote_logs (session_id, round_number, question_id, username, revealed_score, mu, sigma, is_coherent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        this.sessionId,
        this.gameState.roundNumber,
        this.gameState.question.id,
        username,
        playerResult.score,
        playerResult.mu,
        playerResult.sigma,
        playerResult.isCoherent ? 1 : 0
      ).run();
    }

    await this.state.storage.put('gameState', this.gameState);
    this.broadcast({ type: 'results', state: this.sanitizeState(this.gameState) });
    this.schedulePhaseEnd(RESULTS_DURATION, () => this.nextRound());
  }

  async nextRound() {
    for (const session of this.sessions.values()) {
      session.committed = false;
      session.revealed = false;
    }
    await this.startGame();
  }

  schedulePhaseEnd(seconds, callback) {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(callback, seconds * 1000);
  }

  broadcastPlayerList() {
    const players = [...this.sessions.values()]
      .filter(s => s.username)
      .map(s => s.username);
    this.broadcast({ type: 'player_list', players });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const session of this.sessions.values()) {
      try { session.ws.send(data); } catch {}
    }
  }

  sanitizeState(state) {
    if (!state) return null;
    const { commits, reveals, ...rest } = state;
    return {
      ...rest,
      committedPlayers: Object.keys(commits || {}),
      revealedPlayers: Object.keys(reveals || {}),
      reveals: state.phase === 'results' ? reveals : undefined,
    };
  }
}
