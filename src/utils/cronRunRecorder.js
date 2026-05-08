/**
 * Audit O1 — single source of truth for writing to `cron_runs`.
 *
 * Pre-audit, recordCronRun was inlined in src/modules/admin/admin.routes.js so
 * only the crons defined there reported their status. Imports, bq-sync, and
 * alerts ran without leaving a trace, which meant the `/api/admin/scheduler/health`
 * dashboard was incomplete and silent failures went unnoticed for hours.
 *
 * Importing this util from a cron handler costs nothing extra: the table may
 * not exist yet (pre-mig 067), in which case we swallow the error rather than
 * surfacing one. Production already has 067 applied per CLAUDE.md.
 *
 * Status convention:
 *   - 'ok'      — handler completed without throwing
 *   - 'error'   — handler threw; payload should include `message`
 *   - 'skipped' — handler short-circuited (e.g. advisory lock contended,
 *                 dependency missing, idempotent skip)
 */

const db = require('../config/database');

async function recordCronRun(jobKey, status, payload) {
  try {
    await db.raw(
      `INSERT INTO cron_runs (job_key, last_run_at, last_status, last_payload)
       VALUES (?, NOW(), ?, ?::jsonb)
       ON CONFLICT (job_key) DO UPDATE
         SET last_run_at = NOW(),
             last_status = EXCLUDED.last_status,
             last_payload = EXCLUDED.last_payload`,
      [jobKey, status, JSON.stringify(payload || {})],
    );
  } catch {
    // Best-effort. cron_runs may not exist yet on a fresh deploy; we'd rather
    // succeed silently than fail the cron just because the audit table is
    // missing. Once mig 067 is applied (production has it as of 2026-05-06)
    // this catch is unreachable.
  }
}

/**
 * withCronRecording — wraps an async cron handler with start/end recording.
 * Use this in cron controllers so every job key automatically writes an
 * `ok` or `error` row without scattering try/catch in every handler.
 *
 * Example:
 *   exports.workerTick = withCronRecording('imports-worker', async () => {
 *     return importsService.runWorkerTick();
 *   });
 */
function withCronRecording(jobKey, handler) {
  return async function recordedHandler(req, res, next) {
    const startedAt = Date.now();
    try {
      const result = await handler(req, res, next);
      const summary = { ...(typeof result === 'object' && result ? result : { result }), duration_ms: Date.now() - startedAt };
      await recordCronRun(jobKey, 'ok', summary);
      if (!res.headersSent) res.json(result || { ok: true });
      return undefined;
    } catch (err) {
      await recordCronRun(jobKey, 'error', {
        message: err && err.message ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      });
      throw err;
    }
  };
}

module.exports = { recordCronRun, withCronRecording };
