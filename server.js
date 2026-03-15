import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import db from './src/db.js';
import { handleMessage, handleDisconnect } from './src/gameManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/leaderboard', (_req, res) => {
  try {
    const rows = db.getLeaderboard(50);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard/me', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username query param required' });
  try {
    const player = db.getPlayerRank(username);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/votes.csv', (_req, res) => {
  try {
    const rows = db.getAllVoteLogs();
    const headers = [
      'id','session_id','round_number','question_id','username',
      'revealed_score','mu','sigma','is_coherent','slash_amount',
      'reward_amount','is_leaker','player_count','timestamp',
    ];
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="votes.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Schelling Game server running on http://localhost:${PORT}`);
});

export default server; // for testing
