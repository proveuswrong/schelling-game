'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'schelling.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      username        TEXT PRIMARY KEY,
      global_score    INTEGER DEFAULT 0,
      games_played    INTEGER DEFAULT 0,
      rounds_played   INTEGER DEFAULT 0,
      coherent_rounds INTEGER DEFAULT 0,
      longest_streak  INTEGER DEFAULT 0,
      current_streak  INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vote_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT,
      round_number   INTEGER,
      question_id    INTEGER,
      username       TEXT,
      revealed_score REAL,
      mu             REAL,
      sigma          REAL,
      is_coherent    INTEGER,
      slash_amount   REAL,
      reward_amount  REAL,
      is_leaker      INTEGER,
      player_count   INTEGER,
      timestamp      TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ---------------------------------------------------------------------------
// Player queries
// ---------------------------------------------------------------------------

function upsertPlayer(username) {
  const d = getDb();
  d.prepare(`
    INSERT INTO players (username) VALUES (?)
    ON CONFLICT(username) DO NOTHING
  `).run(username);
}

function getPlayer(username) {
  return getDb().prepare('SELECT * FROM players WHERE username = ?').get(username);
}

function getLeaderboard(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM players ORDER BY global_score DESC, coherent_rounds DESC LIMIT ?')
    .all(limit);
}

function getPlayerRank(username) {
  const d = getDb();
  const player = d.prepare('SELECT * FROM players WHERE username = ?').get(username);
  if (!player) return null;
  const rank = d.prepare(
    'SELECT COUNT(*) as rank FROM players WHERE global_score > ?'
  ).get(player.global_score).rank + 1;
  return { ...player, rank };
}

/**
 * Update player stats after a game ends.
 * @param {string} username
 * @param {object} stats - { roundsPlayed, coherentRounds, scoreChange }
 */
function updatePlayerStats(username, stats) {
  const d = getDb();
  upsertPlayer(username);
  const player = d.prepare('SELECT * FROM players WHERE username = ?').get(username);

  // Streak: add coherent rounds if any; reset only if player played rounds but had zero coherent ones
  const hadIncoherence = stats.roundsPlayed > 0 && stats.coherentRounds === 0;
  const newStreak = hadIncoherence ? 0 : (player.current_streak + stats.coherentRounds);
  const longestStreak = Math.max(player.longest_streak, newStreak);

  d.prepare(`
    UPDATE players SET
      global_score    = global_score + ?,
      games_played    = games_played + 1,
      rounds_played   = rounds_played + ?,
      coherent_rounds = coherent_rounds + ?,
      current_streak  = ?,
      longest_streak  = ?
    WHERE username = ?
  `).run(
    Math.round(stats.scoreChange),
    stats.roundsPlayed,
    stats.coherentRounds,
    newStreak,
    longestStreak,
    username,
  );
}

// ---------------------------------------------------------------------------
// Vote log queries
// ---------------------------------------------------------------------------

function insertVoteLog(entry) {
  getDb().prepare(`
    INSERT INTO vote_logs
      (session_id, round_number, question_id, username, revealed_score,
       mu, sigma, is_coherent, slash_amount, reward_amount, is_leaker, player_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId,
    entry.roundNumber,
    entry.questionId,
    entry.username,
    entry.revealedScore ?? null,
    entry.mu ?? null,
    entry.sigma ?? null,
    entry.isCoherent ? 1 : 0,
    entry.slashAmount,
    entry.rewardAmount,
    entry.isLeaker ? 1 : 0,
    entry.playerCount,
  );
}

function getAllVoteLogs() {
  return getDb().prepare('SELECT * FROM vote_logs ORDER BY id ASC').all();
}

module.exports = {
  getDb,
  upsertPlayer,
  getPlayer,
  getLeaderboard,
  getPlayerRank,
  updatePlayerStats,
  insertVoteLog,
  getAllVoteLogs,
};
