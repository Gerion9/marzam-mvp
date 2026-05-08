/**
 * Distributed rate limiter backed by Postgres (table `rate_limit_buckets`).
 *
 * Replaces express-rate-limit's in-memory store: that store is per-instance,
 * so a Vercel deploy with N concurrent function instances effectively
 * multiplied every limit by N. With this implementation, a single global
 * counter is enforced regardless of which instance handles the request.
 *
 * Usage:
 *   const dbRateLimit = require('./rateLimitDb');
 *   app.use('/api/auth/login', dbRateLimit({
 *     name: 'auth',
 *     windowMs: 15 * 60 * 1000,
 *     max: 30,
 *     keyGenerator: (req) => 'login:' + (req.body?.email || 'noemail') + ':' + req.ip,
 *     message: { error: 'Too many login attempts, please try again later.' },
 *   }));
 *
 * Keys must be deterministic per "caller bucket". When req.authUserId is set
 * (softAuth ran first), prefer keying on user id over IP for stability under
 * NAT'd networks.
 *
 * Failure mode: fail-open. If Postgres is unreachable or the table doesn't
 * exist, requests pass through with a warning. That trade-off matches express
 * -rate-limit's own posture; we'd rather degrade rate limiting than DoS the
 * whole API on a transient DB hiccup. The fail-open is logged so ops can
 * notice the gap.
 */

const db = require('../config/database');

const DEFAULT_MESSAGE = { error: 'Too many requests, please try again later.' };

function dbRateLimit(options) {
  const {
    name = 'default',
    windowMs,
    max,
    keyGenerator,
    message = DEFAULT_MESSAGE,
    skip,
  } = options;

  if (!windowMs || !max || typeof keyGenerator !== 'function') {
    throw new Error('dbRateLimit requires { windowMs, max, keyGenerator }');
  }

  return async function rateLimitMiddleware(req, res, next) {
    if (process.env.DISABLE_RATE_LIMIT === 'true') return next();
    if (typeof skip === 'function' && skip(req, res)) return next();

    let bucketKey;
    try {
      bucketKey = name + ':' + keyGenerator(req, res);
    } catch (err) {
      console.warn('[rateLimitDb] keyGenerator threw — failing open:', err.message);
      return next();
    }

    const now = Date.now();
    // Fixed-window: window starts at floor(now / windowMs) * windowMs. Old
    // windows fall out simply by going stale. The expires_at gives the cron
    // a clean target (window_start + 2 * windowMs is enough headroom for any
    // tail traffic from the last window).
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs);
    const expiresAt = new Date(windowStartMs + 2 * windowMs);

    let count;
    try {
      const result = await db.raw(
        `INSERT INTO rate_limit_buckets (bucket_key, window_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket_key, window_start) DO UPDATE
           SET count = rate_limit_buckets.count + 1
         RETURNING count`,
        [bucketKey, windowStart, expiresAt],
      );
      count = result.rows?.[0]?.count;
      if (typeof count !== 'number') {
        throw new Error('RETURNING did not include count');
      }
    } catch (err) {
      // Fail-open. Logged loudly so ops can see when the limiter is degraded.
      console.error('[rateLimitDb] DB failure (fail-open) for ' + bucketKey + ':', err.message);
      return next();
    }

    // RFC 6585-compatible advisory headers — same shape express-rate-limit emits.
    const resetSeconds = Math.ceil((windowStartMs + windowMs) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (count > max) {
      const retryAfter = Math.max(0, Math.ceil((windowStartMs + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json(message);
    }
    return next();
  };
}

module.exports = dbRateLimit;
