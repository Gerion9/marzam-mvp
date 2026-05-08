/**
 * Express error handler — final stop for unhandled errors.
 *
 * Two responsibilities:
 *   1. Always respond to the client (status + sanitized message).
 *   2. [O4] For 5xx, append a row to `error_log` (mig 082) with request id,
 *      user id, method, path, error name/message, and stack. Best-effort: a
 *      DB write here must never delay or block the response — if the insert
 *      fails (table missing, DB down) we swallow and log to stderr.
 *
 * Logging side-effect uses fire-and-forget so the response goes out
 * immediately. Order:
 *   - res.json(...) sends the response synchronously
 *   - then a then-able promise inserts the row
 */

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return null; }
}

async function persistError(req, status, err) {
  // Lazy-require to keep tests that exercise the handler without a DB safe.
  // eslint-disable-next-line global-require
  const db = require('../config/database');
  // eslint-disable-next-line global-require
  const { getRequestId } = require('./requestContext');
  try {
    const userId = req.user && req.user.id ? req.user.id : (req.authUserId || null);
    const requestId = (req && req.requestId) || getRequestId() || null;
    await db.raw(
      `INSERT INTO error_log
        (request_id, user_id, method, path, status, error_name, error_message, stack, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
      [
        requestId,
        userId,
        req.method || null,
        req.originalUrl || req.url || null,
        status,
        err && err.name ? err.name : 'Error',
        err && err.message ? err.message : null,
        err && err.stack ? err.stack : null,
        safeStringify({
          // Best-effort context; never include req.body wholesale because it
          // can contain plaintext passwords or PII. Pick a safe subset.
          query: req.query || null,
          headers: { 'user-agent': req.headers && req.headers['user-agent'] },
        }),
      ],
    );
  } catch (insertErr) {
    // Don't let the persistence step itself become a noisy failure.
    process.stderr.write('[errorHandler] failed to persist error_log row: ' + insertErr.message + '\n');
  }
}

function errorHandler(err, req, res, _next) {
  // Always log to stderr first — that's the most reliable trail.
  process.stderr.write((err.stack || String(err)) + '\n');

  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : (err.message || 'Something went wrong');

  res.status(status).json({ error: message });

  if (status >= 500) {
    // Fire-and-forget: do NOT await the persistence. The client already has
    // its response; the DB insert is purely observability.
    persistError(req, status, err).catch(() => { /* swallowed inside persistError */ });
  }
}

module.exports = errorHandler;
