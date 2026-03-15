import crypto from 'node:crypto';

const STAKE_CAP = 100;
const LEAK_DETECTION_THRESHOLD = 0.05;

const EDUCATIONAL_NOTES = [
  "You submitted a hash of your answer, not the answer itself. Nobody could see your vote before the reveal. This is how the real protocol enforces independent judgment: cryptographic commitment prevents herding.",
  "Players within 1.25 standard deviations of the weighted mean are 'coherent' and get rewarded. This does not reward conformity; it rewards convergence on a shared assessment. The band allows reasonable disagreement.",
  "Players outside the coherence band lost 3% of their round stake. In the real protocol, this creates skin-in-the-game: participants who consistently misjudge lose capital, while accurate ones accumulate it.",
  "When everyone votes nearly the same (std dev < 0.02), the round is cancelled. Unanimous agreement could be genuine consensus or silent collusion; the protocol treats it as non-informative.",
  "Revealing your vote before the reveal phase is penalized at 3x the normal rate. If others can see your vote, they can copy it, destroying the independent judgment the mechanism depends on.",
  "No single player's weight can exceed 10% of the total committee weight. This prevents one wealthy participant from dominating the outcome.",
  "You tried to match the group without seeing their answers. The 'right' answer is whatever everyone converges on independently. When the question is clear, convergence is natural. When it is ambiguous, convergence breaks down.",
  "Over many rounds, players who are consistently coherent accumulate chips while incoherent players lose them. This same dynamic filters for competent participants over time.",
];

/**
 * Verify a commit-reveal pair.
 * @param {number} score   - revealed score (float, 2 decimal places)
 * @param {string} salt    - hex salt string
 * @param {string} hash    - expected SHA-256 hex digest
 * @returns {boolean}
 */
function verifyCommit(score, salt, hash) {
  const preimage = `${score.toFixed(2)}:${salt}`;
  const computed = crypto.createHash('sha256').update(preimage).digest('hex');
  return computed === hash;
}

/**
 * Compute round results given player reveal data.
 *
 * @param {Array<{username, score, stake, hash, salt, revealed, committed}>} players
 * @param {Array<{messageId, reporterUsername, suspectUsername}>} leakReports
 * @param {Array<{id, username, text}>} chatMessages
 * @param {number} roundIndex - 0-based, used to pick educational note
 * @returns {object} result
 */
function computeRoundResult(players, leakReports, chatMessages, roundIndex) {
  // Identify confirmed leakers via chat leak detection
  const confirmedLeakers = new Set();
  const leakBounties = new Map(); // reporterUsername -> bounty amount

  // Collect valid reveals: committed and revealed (hash verified)
  const validReveals = players.filter(p => p.committed && p.revealed && p.score !== null);

  // Check leak reports — only meaningful if we have enough reveals
  for (const report of leakReports) {
    const suspect = players.find(p => p.username === report.suspectUsername);
    if (!suspect || !suspect.revealed || suspect.score === null) continue;

    const suspectScore = suspect.score;
    // Find the reported chat message
    const msg = chatMessages.find(m => m.id === report.messageId && m.username === report.suspectUsername);
    if (!msg) continue;

    // Extract all numbers from the message text
    const nums = extractNumbers(msg.text);
    const leaked = nums.some(n => Math.abs(n - suspectScore) <= LEAK_DETECTION_THRESHOLD);
    if (leaked) {
      confirmedLeakers.add(report.suspectUsername);
      // Track reporter for bounty (last reporter per suspect wins)
      leakBounties.set(report.suspectUsername, report.reporterUsername);
    }
  }

  // Determine slash rate per player
  // Players who didn't commit or reveal are treated as incoherent (slashed 3%)
  // Confirmed leakers slashed at 9%

  // For scoring we need at least 2 valid reveals
  if (validReveals.length < 2) {
    return buildCancelledResult(players, 'fewer_than_2_reveals', roundIndex, confirmedLeakers, leakBounties);
  }

  // Compute stakes
  for (const p of players) {
    p.stake = Math.min(STAKE_CAP, p.balance > 0 ? p.balance : 0);
  }

  // Only revealed players participate in weighting
  const sumStakes = validReveals.reduce((s, p) => s + p.stake, 0);

  // Apply weight cap: w_i = min(s_i, 0.10 * sumStakes)
  for (const p of validReveals) {
    p.weight = Math.min(p.stake, 0.10 * sumStakes);
  }
  const sumWeights = validReveals.reduce((s, p) => s + p.weight, 0);

  // Weighted mean
  let mu = 0;
  if (sumWeights > 0) {
    mu = validReveals.reduce((s, p) => s + p.weight * p.score, 0) / sumWeights;
  }

  // Weighted std dev
  let sigma = 0;
  if (sumWeights > 0) {
    sigma = Math.sqrt(
      validReveals.reduce((s, p) => s + p.weight * Math.pow(p.score - mu, 2), 0) / sumWeights
    );
  }

  // Flat round cancellation
  if (sigma < 0.02) {
    return buildCancelledResult(players, 'sigma_too_small', roundIndex, confirmedLeakers, leakBounties);
  }

  // Coherence check for revealed players
  for (const p of validReveals) {
    p.coherent = Math.abs(p.score - mu) <= 1.25 * sigma;
    if (confirmedLeakers.has(p.username)) {
      p.coherent = false; // leakers treated as incoherent
    }
  }

  // Non-revealing / non-committing players are incoherent
  const nonParticipants = players.filter(p => !p.committed || !p.revealed || p.score === null);
  for (const p of nonParticipants) {
    p.coherent = false;
    p.weight = 0;
    p.stake = Math.min(STAKE_CAP, p.balance > 0 ? p.balance : 0);
  }

  // Slash amounts
  const slashPool = { total: 0, byRecipient: new Map() };
  const playerResults = [];

  for (const p of players) {
    const isLeaker = confirmedLeakers.has(p.username);
    const slashRate = isLeaker ? 0.09 : 0.03;
    let slash = 0;
    let reward = 0;

    const isCoherent = validReveals.find(r => r.username === p.username)?.coherent ?? false;
    const stake = p.stake ?? Math.min(STAKE_CAP, p.balance > 0 ? p.balance : 0);

    if (!isCoherent) {
      slash = slashRate * stake;
      // Extra 6% goes to reporter as bounty if leaker
      if (isLeaker && leakBounties.has(p.username)) {
        const extraBounty = 0.06 * stake;
        const reporter = leakBounties.get(p.username);
        slashPool.byRecipient.set(reporter, (slashPool.byRecipient.get(reporter) || 0) + extraBounty);
        slashPool.total += slash - extraBounty; // only 3% goes to coherent pool
      } else {
        slashPool.total += slash;
      }
    }

    playerResults.push({
      username: p.username,
      score: p.score ?? null,
      coherent: isCoherent,
      slash: Math.round(slash * 100) / 100,
      reward: 0,
      isLeaker,
      stake,
    });
  }

  // Distribute slash pool to coherent players proportionally by weight
  const coherentReveals = validReveals.filter(p => p.coherent);
  const sumCoherentWeights = coherentReveals.reduce((s, p) => s + p.weight, 0);

  for (const pr of playerResults) {
    const reveal = validReveals.find(r => r.username === pr.username);
    if (reveal && reveal.coherent && sumCoherentWeights > 0) {
      pr.reward = Math.round((reveal.weight / sumCoherentWeights) * slashPool.total * 100) / 100;
    }
    // Add reporter bounties
    if (slashPool.byRecipient.has(pr.username)) {
      pr.reward += Math.round(slashPool.byRecipient.get(pr.username) * 100) / 100;
    }
  }

  const note = EDUCATIONAL_NOTES[roundIndex % EDUCATIONAL_NOTES.length];

  return {
    cancelled: false,
    mu: Math.round(mu * 10000) / 10000,
    sigma: Math.round(sigma * 10000) / 10000,
    players: playerResults,
    educationalNote: note,
    totalSlashPool: Math.round(slashPool.total * 100) / 100,
  };
}

function buildCancelledResult(players, reason, roundIndex, confirmedLeakers, leakBounties) {
  const note = EDUCATIONAL_NOTES[roundIndex % EDUCATIONAL_NOTES.length];
  return {
    cancelled: true,
    cancelReason: reason,
    mu: null,
    sigma: null,
    players: players.map(p => ({
      username: p.username,
      score: p.score ?? null,
      coherent: null,
      slash: 0,
      reward: 0,
      isLeaker: confirmedLeakers.has(p.username),
      stake: Math.min(STAKE_CAP, p.balance > 0 ? p.balance : 0),
    })),
    educationalNote: note,
    totalSlashPool: 0,
  };
}

/**
 * Extract all numeric values from a string.
 */
function extractNumbers(text) {
  const matches = text.match(/-?\d+(\.\d+)?/g) || [];
  return matches.map(Number);
}

/**
 * Apply round result to player balances.
 * Returns array of {username, newBalance, delta}
 */
function applyBalanceChanges(players, roundResult) {
  const changes = [];
  for (const pr of roundResult.players) {
    const player = players.find(p => p.username === pr.username);
    if (!player) continue;
    const delta = pr.reward - pr.slash;
    const newBalance = Math.max(0, Math.round((player.balance + delta) * 100) / 100);
    changes.push({ username: pr.username, newBalance, delta: Math.round(delta * 100) / 100 });
  }
  return changes;
}

export {
  verifyCommit,
  computeRoundResult,
  applyBalanceChanges,
  extractNumbers,
  EDUCATIONAL_NOTES,
};
