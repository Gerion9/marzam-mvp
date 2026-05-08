/**
 * Constant-time string comparison for shared secrets (CRON_SECRET, etc.).
 *
 * Uses crypto.timingSafeEqual under the hood. Handles the edge cases that
 * tripped earlier reviews:
 *   - either side null/undefined → false
 *   - lengths differ → false (without leaking the diff via early-return
 *     timing — we still compare in constant time over a fixed-length pad
 *     to keep the operation duration uncorrelated with which side is bad)
 *   - any non-string input → false
 *
 * Use this anywhere we compare a secret to a presented value:
 *   const { secretsEqual } = require('../utils/secretCompare');
 *   if (secretsEqual(presented, process.env.CRON_SECRET)) { ... }
 */

const crypto = require('crypto');

function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // crypto.timingSafeEqual requires equal-length buffers. To avoid leaking
  // the length difference, hash both inputs to fixed-size buffers first.
  // (Alternative: pad to a fixed length, but hashing is simpler and the
  // cost is negligible for per-request use.)
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { secretsEqual };
