/**
 * Test suite for Schelling Game logic.
 * Run with: node test/test.js
 */

import crypto from 'node:crypto';
import { verifyCommit, computeRoundResult, applyBalanceChanges, extractNumbers } from '../src/gameLogic.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function approx(a, b, eps = 0.001) {
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// Helper: build a SHA-256 commit the same way the server does
// ---------------------------------------------------------------------------
function makeCommit(score, salt) {
  const preimage = `${score.toFixed(2)}:${salt}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Commit-reveal verification
// ---------------------------------------------------------------------------
console.log('\n1. Commit-Reveal Verification');

{
  const score = 0.75;
  const salt = 'deadbeef1234';
  const hash = makeCommit(score, salt);

  assert(verifyCommit(score, salt, hash), 'Valid commit verifies correctly');
  assert(!verifyCommit(0.74, salt, hash), 'Wrong score rejected');
  assert(!verifyCommit(score, 'wrongsalt', hash), 'Wrong salt rejected');
  assert(!verifyCommit(score, salt, 'a'.repeat(64)), 'Wrong hash rejected');
}

{
  const score = 0.00;
  const salt = 'abc';
  const hash = makeCommit(score, salt);
  assert(verifyCommit(score, salt, hash), 'Score 0.00 verifies');
}

{
  const score = 1.00;
  const salt = 'xyz';
  const hash = makeCommit(score, salt);
  assert(verifyCommit(score, salt, hash), 'Score 1.00 verifies');
}

// ---------------------------------------------------------------------------
// 2. extractNumbers
// ---------------------------------------------------------------------------
console.log('\n2. extractNumbers');

assert(JSON.stringify(extractNumbers('I think 0.75 or maybe 0.8')) === JSON.stringify([0.75, 0.8]),
  'Extracts decimals from text');
assert(JSON.stringify(extractNumbers('no numbers here')) === JSON.stringify([]),
  'Returns empty for no numbers');
assert(JSON.stringify(extractNumbers('balance is -5 or 10')) === JSON.stringify([-5, 10]),
  'Handles negative numbers');

// ---------------------------------------------------------------------------
// 3. Scoring formulas — basic coherent round
// ---------------------------------------------------------------------------
console.log('\n3. Basic coherent round (3 players, all reveal)');

{
  // Use scores spread enough that sigma > 0.02, yet all within 1.25σ of mean
  const salt = 'aabbcc';
  const players = [
    { username: 'alice', score: 0.30, balance: 100, committed: true, revealed: true, hash: makeCommit(0.30, salt) },
    { username: 'bob',   score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'carol', score: 0.70, balance: 100, committed: true, revealed: true, hash: makeCommit(0.70, salt) },
  ];

  const result = computeRoundResult(players, [], [], 0);

  assert(!result.cancelled, 'Round not cancelled');
  assert(typeof result.mu === 'number', 'mu is a number');
  assert(approx(result.mu, 0.50, 0.01), `mu ≈ 0.50 (got ${result.mu})`);
  assert(result.sigma < 0.2, `sigma is moderate (got ${result.sigma})`);
  assert(result.players.every(p => p.coherent), 'All players coherent');
  assert(result.players.every(p => p.slash === 0), 'No slashing when all coherent');
  assert(result.players.every(p => p.reward === 0), 'No rewards when no slashing');
}

// ---------------------------------------------------------------------------
// 4. Incoherent player gets slashed
// ---------------------------------------------------------------------------
console.log('\n4. Incoherent player slashing');

{
  const salt = 'ff00ff';
  // alice, bob, carol cluster near 0.50; dave is a far outlier
  const players = [
    { username: 'alice', score: 0.30, balance: 100, committed: true, revealed: true, hash: makeCommit(0.30, salt) },
    { username: 'bob',   score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'carol', score: 0.60, balance: 100, committed: true, revealed: true, hash: makeCommit(0.60, salt) },
    { username: 'dave',  score: 0.99, balance: 100, committed: true, revealed: true, hash: makeCommit(0.99, salt) },
  ];

  const result = computeRoundResult(players, [], [], 1);

  assert(!result.cancelled, 'Round not cancelled');
  const dave = result.players.find(p => p.username === 'dave');
  assert(dave && !dave.coherent, 'Dave is incoherent');
  assert(dave && dave.slash > 0, `Dave slashed (got ${dave?.slash})`);
  assert(dave && approx(dave.slash, 0.03 * 100, 0.01), `Dave slashed 3% of stake (got ${dave?.slash})`);

  const coherentPlayers = result.players.filter(p => p.coherent);
  assert(coherentPlayers.every(p => p.reward > 0), 'Coherent players receive rewards');
  const totalRewards = coherentPlayers.reduce((s, p) => s + p.reward, 0);
  assert(approx(totalRewards, dave.slash, 0.01), `Total rewards ≈ total slash (${totalRewards} vs ${dave.slash})`);
}

// ---------------------------------------------------------------------------
// 5. Flat round cancellation (sigma < 0.02)
// ---------------------------------------------------------------------------
console.log('\n5. Flat round cancellation');

{
  const salt = '010203';
  const players = [
    { username: 'alice', score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'bob',   score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'carol', score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
  ];

  const result = computeRoundResult(players, [], [], 2);
  assert(result.cancelled, 'Round cancelled when sigma < 0.02');
  assert(result.cancelReason === 'sigma_too_small', `Cancel reason correct (got ${result.cancelReason})`);
}

// ---------------------------------------------------------------------------
// 6. Fewer than 2 reveals — round cancelled
// ---------------------------------------------------------------------------
console.log('\n6. Fewer than 2 reveals → cancelled');

{
  const salt = 'aaa';
  const players = [
    { username: 'alice', score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    // bob and carol did not reveal
    { username: 'bob',   score: null, balance: 100, committed: false, revealed: false, hash: null },
    { username: 'carol', score: null, balance: 100, committed: false, revealed: false, hash: null },
  ];

  const result = computeRoundResult(players, [], [], 3);
  assert(result.cancelled, 'Round cancelled with only 1 reveal');
  assert(result.cancelReason === 'fewer_than_2_reveals', `Cancel reason correct (got ${result.cancelReason})`);
}

// ---------------------------------------------------------------------------
// 6b. Two-player game completes round successfully
// ---------------------------------------------------------------------------
console.log('\n6b. Two-player game completes round');

{
  const salt = 'aaa2';
  const players = [
    { username: 'alice', score: 0.30, balance: 100, committed: true, revealed: true, hash: makeCommit(0.30, salt) },
    { username: 'bob',   score: 0.70, balance: 100, committed: true, revealed: true, hash: makeCommit(0.70, salt) },
  ];

  const result = computeRoundResult(players, [], [], 3);
  assert(!result.cancelled, 'Round not cancelled with 2 reveals');
  assert(typeof result.mu === 'number', 'mu is a number');
  assert(approx(result.mu, 0.50, 0.01), `mu ≈ 0.50 (got ${result.mu})`);
}

// ---------------------------------------------------------------------------
// 7. Player with 0 balance has stake = 0 (spectator)
// ---------------------------------------------------------------------------
console.log('\n7. Zero-balance spectator');

{
  const salt = 'bbb';
  const players = [
    { username: 'alice',    score: 0.30, balance: 100, committed: true, revealed: true, hash: makeCommit(0.30, salt) },
    { username: 'bob',      score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'carol',    score: 0.70, balance: 100, committed: true, revealed: true, hash: makeCommit(0.70, salt) },
    { username: 'spectator', score: 0.99, balance: 0, committed: true, revealed: true, hash: makeCommit(0.99, salt) },
  ];

  const result = computeRoundResult(players, [], [], 4);
  assert(!result.cancelled, 'Round not cancelled');
  const spectator = result.players.find(p => p.username === 'spectator');
  assert(spectator && spectator.stake === 0, 'Spectator has stake 0');
  assert(spectator && spectator.slash === 0, 'Spectator not slashed (stake 0)');
}

// ---------------------------------------------------------------------------
// 8. Weight cap (10% max weight)
// ---------------------------------------------------------------------------
console.log('\n8. Weight cap — rich player capped at 10%');

{
  const salt = 'ccc';
  // All players have balance 100 → stake = min(100, 100) = 100
  // sum stakes = 500; 10% cap = 50 → all weights capped at 50 each
  const players = [
    { username: 'rich',    score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'p1',      score: 0.40, balance: 100, committed: true, revealed: true, hash: makeCommit(0.40, salt) },
    { username: 'p2',      score: 0.60, balance: 100, committed: true, revealed: true, hash: makeCommit(0.60, salt) },
    { username: 'p3',      score: 0.52, balance: 100, committed: true, revealed: true, hash: makeCommit(0.52, salt) },
    { username: 'outlier', score: 0.99, balance: 100, committed: true, revealed: true, hash: makeCommit(0.99, salt) },
  ];

  const result = computeRoundResult(players, [], [], 5);
  assert(!result.cancelled, 'Round not cancelled');
  // All with balance 100 → stake = 100; sumStakes = 500; cap = 50; all weights = 50
  assert(typeof result.mu === 'number', 'mu computed');
}

// ---------------------------------------------------------------------------
// 9. Leak detection
// ---------------------------------------------------------------------------
console.log('\n9. Leak detection');

{
  const salt = 'ddd';
  const leakerScore = 0.75;
  const msgId = 'msg-1';
  const players = [
    { username: 'leaker', score: leakerScore, balance: 100, committed: true, revealed: true, hash: makeCommit(leakerScore, salt) },
    { username: 'reporter', score: 0.50, balance: 100, committed: true, revealed: true, hash: makeCommit(0.50, salt) },
    { username: 'carol',    score: 0.52, balance: 100, committed: true, revealed: true, hash: makeCommit(0.52, salt) },
    { username: 'dave',     score: 0.48, balance: 100, committed: true, revealed: true, hash: makeCommit(0.48, salt) },
  ];
  const chatMessages = [{ id: msgId, username: 'leaker', text: 'I am voting 0.75 obviously', timestamp: Date.now() }];
  const leakReports = [{ messageId: msgId, reporterUsername: 'reporter', suspectUsername: 'leaker' }];

  const result = computeRoundResult(players, leakReports, chatMessages, 6);
  const leaker = result.players.find(p => p.username === 'leaker');
  assert(leaker && leaker.isLeaker, 'Leaker identified');
  assert(leaker && !leaker.coherent, 'Leaker treated as incoherent');
  assert(leaker && approx(leaker.slash, 0.09 * 100, 0.01), `Leaker slashed 9% (got ${leaker?.slash})`);

  const reporter = result.players.find(p => p.username === 'reporter');
  assert(reporter && reporter.reward > 0, 'Reporter gets bounty');
}

// ---------------------------------------------------------------------------
// 10. applyBalanceChanges
// ---------------------------------------------------------------------------
console.log('\n10. applyBalanceChanges');

{
  const players = [
    { username: 'alice', balance: 100 },
    { username: 'bob', balance: 100 },
  ];
  const roundResult = {
    players: [
      { username: 'alice', slash: 3, reward: 0 },
      { username: 'bob', slash: 0, reward: 3 },
    ],
  };
  const changes = applyBalanceChanges(players, roundResult);
  const alice = changes.find(c => c.username === 'alice');
  const bob = changes.find(c => c.username === 'bob');
  assert(alice && alice.newBalance === 97, `Alice balance: 97 (got ${alice?.newBalance})`);
  assert(bob && bob.newBalance === 103, `Bob balance: 103 (got ${bob?.newBalance})`);
  assert(alice && alice.delta === -3, `Alice delta: -3 (got ${alice?.delta})`);
}

// ---------------------------------------------------------------------------
// 11. Non-committing player treated as incoherent
// ---------------------------------------------------------------------------
console.log('\n11. Non-committing player is incoherent');

{
  const salt = 'eee';
  const players = [
    { username: 'alice', score: 0.30, balance: 100, committed: true,  revealed: true,  hash: makeCommit(0.30, salt) },
    { username: 'bob',   score: 0.50, balance: 100, committed: true,  revealed: true,  hash: makeCommit(0.50, salt) },
    { username: 'carol', score: 0.70, balance: 100, committed: true,  revealed: true,  hash: makeCommit(0.70, salt) },
    { username: 'dave',  score: null, balance: 100, committed: false, revealed: false, hash: null },
  ];

  // Need 2 valid reveals → ok (alice, bob, carol provide 3)
  const result = computeRoundResult(players, [], [], 7);
  assert(!result.cancelled, 'Round proceeds with 3 valid reveals');
  const dave = result.players.find(p => p.username === 'dave');
  assert(dave && !dave.coherent, 'Non-committing Dave is incoherent');
  assert(dave && dave.slash > 0, `Dave slashed (got ${dave?.slash})`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
