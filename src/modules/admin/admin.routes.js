/**
 * Admin-only operational endpoints — routes budget, scheduler health,
 * cron-secret-protected purge jobs.
 *
 * Mounted at /api/admin (see src/app.js). All endpoints require either:
 *   - an authenticated admin user (req.user.role === 'admin' or is_global), OR
 *   - the x-cron-secret header matching CRON_SECRET (for Vercel Cron).
 *
 * The cron-secret variant exists so vercel.json can hit endpoints from a
 * non-authenticated context.
 */

const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const routesMatrix = require('../../services/routesMatrix');
const db = require('../../config/database');
const { secretsEqual } = require('../../utils/secretCompare');
const { recordCronRun } = require('../../utils/cronRunRecorder');

const router = Router();

// Stable 32-bit signed hash of a job key string; used as the pg advisory-lock id.
function hashJobKey(jobKey) {
  let h = 0;
  for (let i = 0; i < jobKey.length; i++) {
    h = ((h << 5) - h + jobKey.charCodeAt(i)) | 0;
  }
  return h;
}

// Wrap a cron handler to deduplicate concurrent invocations (Vercel Cron has been
// observed to occasionally fire the same schedule twice within seconds). Uses a
// transactional advisory lock held by a long-running "lock holder" trx — this
// pattern is safe under PgBouncer transaction-mode because the holder keeps the
// same backend connection for the lifetime of the trx, while the handler's own
// queries run on independent pooled connections (they don't need the lock).
function withCronLock(jobKey, handler) {
  return async (req, res, next) => {
    const lockId = hashJobKey(jobKey);
    let lockTrx;
    try {
      lockTrx = await db.transaction();
      const got = await lockTrx.raw('SELECT pg_try_advisory_xact_lock(?) AS got', [lockId]);
      if (!got.rows?.[0]?.got) {
        await lockTrx.rollback();
        lockTrx = null;
        const summary = { skipped: 'duplicate_invocation', job_key: jobKey };
        await recordCronRun(jobKey, 'skipped', summary);
        return res.json(summary);
      }
      return await handler(req, res, next);
    } finally {
      if (lockTrx) {
        try { await lockTrx.rollback(); } catch { /* nothing useful to do */ }
      }
    }
  };
}

/**
 * Permits a request with x-cron-secret matching the env var, OR a logged-in
 * admin (Marzam admin OR blackprint_admin). Lets Vercel Cron jobs hit
 * operational endpoints without user auth, and lets BlackPrint trigger crons
 * manually for diagnostics.
 *
 * BlackPrint writes are blocked platform-wide by denyBlackprintWrites — but
 * /api/admin/cron/* is in that middleware's whitelist precisely so BP can
 * fire crons. This is the matching authorization gate.
 */
function adminOrAnyAdminOrCron(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  const supplied = req.header('x-cron-secret') || req.query.cron_secret;
  if (cronSecret && secretsEqual(supplied, cronSecret)) return next();
  // Fall through to standard auth + any-admin gate.
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return authorize({ anyAdmin: true })(req, res, next);
  });
}

// ── Routes API budget (for plan editor cost chip + admin dashboard) ────────
// includeBlackprint: true — BP foots the bill for Google Routes, so they need
// to see the budget at all times.
router.get('/routes-budget', authenticate, authorize({
  roles: ['director_sucursal', 'gerente_ventas', 'supervisor'],
  includeBlackprint: true,
}), async (req, res, next) => {
  try {
    const status = await routesMatrix.getDailyBudgetStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// ── Scheduler health (each cron writes to cron_runs) ──────────────────────
// Shared between Marzam admin and BP — both need visibility into cron status.
router.get('/scheduler/health', authenticate, authorize({ anyAdmin: true }), async (req, res, next) => {
  try {
    // cron_runs is a thin observability table (created in migration 067).
    const exists = await db.raw("SELECT to_regclass('cron_runs') AS t");
    if (!exists.rows?.[0]?.t) {
      return res.json({ jobs: [], note: 'cron_runs table not found — migration 067 pending' });
    }
    const rows = await db('cron_runs').orderBy('job_key').select('*');
    res.json({ jobs: rows });
  } catch (err) { next(err); }
});

// [O4] ── Admin error log browser (rows from `error_log`, mig 082) ──────────
// Paginated by occurred_at DESC. Filterable by status/path/since. Shared
// between Marzam admin and BP — diagnostics often need BP and Marzam together.
router.get('/errors', authenticate, authorize({ anyAdmin: true }), async (req, res, next) => {
  try {
    const exists = await db.raw("SELECT to_regclass('error_log') AS t");
    if (!exists.rows?.[0]?.t) {
      return res.json({ rows: [], note: 'error_log table not found — apply migration 082' });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    let q = db('error_log').orderBy('occurred_at', 'desc');
    if (req.query.status) {
      q = q.where('status', Number(req.query.status));
    }
    if (req.query.path) {
      q = q.where('path', 'like', '%' + String(req.query.path) + '%');
    }
    if (req.query.since) {
      q = q.where('occurred_at', '>=', req.query.since);
    }
    if (req.query.request_id) {
      q = q.where('request_id', String(req.query.request_id));
    }
    const rows = await q.limit(limit).offset(offset);
    res.json({ rows, limit, offset });
  } catch (err) { next(err); }
});

// ── Cron-only purge jobs (Vercel Cron pings these via x-cron-secret) ──────
// IMPORTANT: Vercel Cron ONLY sends GET requests. We expose GET as the canonical
// handler and POST as an alias for ad-hoc admin invocations. Do not remove the
// GET handlers — without them the scheduled jobs silently 404 every fire.

async function cronPurgeRouteCache(req, res, next) {
  try {
    const result = await routesMatrix.purgeExpired();
    await recordCronRun('purge-route-cache', 'ok', result);
    res.json(result);
  } catch (err) {
    await recordCronRun('purge-route-cache', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/purge-route-cache', adminOrAnyAdminOrCron, withCronLock('purge-route-cache', cronPurgeRouteCache));
router.post('/cron/purge-route-cache', adminOrAnyAdminOrCron, withCronLock('purge-route-cache', cronPurgeRouteCache));

async function cronPurgeTracking(req, res, next) {
  try {
    const days = Number(process.env.TRACKING_RETENTION_DAYS) || 30;
    // Respect retain_until (mig 064): pings tied to a visit_report or a closed
    // session may have an explicit longer retention. Only delete rows whose
    // retain_until has passed, or rows without retain_until older than the
    // default window.
    const result = await db('rep_tracking_points')
      .where(function applyRetentionFilter() {
        this.where('retain_until', '<', db.fn.now())
          .orWhere(function unsetRetainUntilFilter() {
            this.whereNull('retain_until')
              .andWhereRaw(`recorded_at < NOW() - INTERVAL '${days} days'`);
          });
      })
      .del();
    const summary = { deleted: result, retention_days: days, respects_retain_until: true };
    await recordCronRun('purge-tracking', 'ok', summary);
    res.json(summary);
  } catch (err) {
    await recordCronRun('purge-tracking', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/purge-tracking', adminOrAnyAdminOrCron, withCronLock('purge-tracking', cronPurgeTracking));
router.post('/cron/purge-tracking', adminOrAnyAdminOrCron, withCronLock('purge-tracking', cronPurgeTracking));

async function cronGeocodeBackfill(req, res, next) {
  try {
    const geocoder = require('../../services/geocoder');
    const result = await geocoder.backfillUsersHome({ limit: Number(req.query.limit) || 100 });
    await recordCronRun('geocode-backfill', 'ok', result);
    res.json(result);
  } catch (err) {
    await recordCronRun('geocode-backfill', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/geocode-backfill', adminOrAnyAdminOrCron, withCronLock('geocode-backfill', cronGeocodeBackfill));
router.post('/cron/geocode-backfill', adminOrAnyAdminOrCron, withCronLock('geocode-backfill', cronGeocodeBackfill));

async function cronQuadrantsSnapshot(req, res, next) {
  try {
    const job = require('../bq-sync/jobs/snapshotQuadrants');
    const result = await job.run({ periodStart: req.query.period_start });
    await recordCronRun('quadrants-snapshot', 'ok', result);
    res.json(result);
  } catch (err) {
    await recordCronRun('quadrants-snapshot', 'error', { message: err.message });
    next(err);
  }
}
router.get('/quadrants/snapshot', adminOrAnyAdminOrCron, withCronLock('quadrants-snapshot', cronQuadrantsSnapshot));
router.post('/quadrants/snapshot', adminOrAnyAdminOrCron, withCronLock('quadrants-snapshot', cronQuadrantsSnapshot));

async function cronPurgeLiveOutbox(req, res, next) {
  try {
    const hours = Number(process.env.LIVE_OUTBOX_RETENTION_HOURS) || 24;
    const result = await db('live_event_outbox')
      .whereRaw(`created_at < NOW() - INTERVAL '${hours} hours'`)
      .del();
    const summary = { deleted: result, retention_hours: hours };
    await recordCronRun('purge-live-outbox', 'ok', summary);
    res.json(summary);
  } catch (err) {
    await recordCronRun('purge-live-outbox', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/purge-live-outbox', adminOrAnyAdminOrCron, withCronLock('purge-live-outbox', cronPurgeLiveOutbox));
router.post('/cron/purge-live-outbox', adminOrAnyAdminOrCron, withCronLock('purge-live-outbox', cronPurgeLiveOutbox));

async function cronParseOpeningHours(req, res, next) {
  try {
    const job = require('../bq-sync/jobs/parseOpeningHours');
    const result = await job.run({
      batchSize: Number(req.query.batch_size) || undefined,
      force: req.query.force === 'true',
    });
    await recordCronRun('parse-opening-hours', 'ok', result);
    res.json(result);
  } catch (err) {
    await recordCronRun('parse-opening-hours', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/parse-opening-hours', adminOrAnyAdminOrCron, withCronLock('parse-opening-hours', cronParseOpeningHours));
router.post('/cron/parse-opening-hours', adminOrAnyAdminOrCron, withCronLock('parse-opening-hours', cronParseOpeningHours));

/**
 * Monthly retention cron for audit_events.
 *
 * Decision: 2-year retention. Rows older than AUDIT_RETENTION_DAYS (default
 * 730) are MOVED to `audit_events_archive` (created in migration 078). The
 * CTE makes the operation atomic — no window where a row is absent from
 * both tables.
 *
 * Add to vercel.json with schedule "0 4 1 * *" (1st of each month, 04:00 UTC).
 * See audit Fix #10 in docs/qa-fix-plan.md.
 */
async function cronAuditRetention(req, res, next) {
  try {
    const days = Number(process.env.AUDIT_RETENTION_DAYS) || 730;
    if (!Number.isFinite(days) || days < 1) {
      throw new Error(`Invalid AUDIT_RETENTION_DAYS: ${process.env.AUDIT_RETENTION_DAYS}`);
    }
    // Defensive: archive table may not exist yet (pre-mig-078).
    const archiveExists = await db.raw(
      "SELECT to_regclass('audit_events_archive') AS t",
    );
    if (!archiveExists.rows?.[0]?.t) {
      const summary = { skipped: 'audit_events_archive missing — apply migration 078' };
      await recordCronRun('audit-retention', 'skipped', summary);
      return res.json(summary);
    }
    const moved = await db.raw(`
      WITH old AS (
        DELETE FROM audit_events
        WHERE created_at < NOW() - INTERVAL '${days} days'
        RETURNING *
      )
      INSERT INTO audit_events_archive
        (id, user_id, action, entity_type, entity_id,
         before_state, after_state, ip_address, created_at)
      SELECT id, user_id, action, entity_type, entity_id,
             before_state, after_state, ip_address, created_at
        FROM old
    `);
    const summary = { archived: moved.rowCount || 0, retention_days: days };
    await recordCronRun('audit-retention', 'ok', summary);
    res.json(summary);
  } catch (err) {
    await recordCronRun('audit-retention', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/audit-retention', adminOrAnyAdminOrCron, withCronLock('audit-retention', cronAuditRetention));
router.post('/cron/audit-retention', adminOrAnyAdminOrCron, withCronLock('audit-retention', cronAuditRetention));

/**
 * Daily presence reconciliation — collapses rep_tracking_points × pharmacies
 * into pharmacy_presence (mig 079) so we can answer "rep was at pharmacy X
 * but didn't register a visit" without scanning raw pings every time.
 *
 * Schedule: "30 8 * * *" — 30 minutes before the 9:00 UTC tracking purge so
 * yesterday's pings are still alive. Idempotent: skips if rows already exist
 * for the target day unless `?force=true`.
 */
async function cronReconcilePresence(req, res, next) {
  try {
    const presenceService = require('../presence/presence.service');
    const result = await presenceService.reconcileDay({
      date: req.query.date || null,
      force: req.query.force === 'true',
    });
    await recordCronRun('reconcile-presence', 'ok', result);
    res.json(result);
  } catch (err) {
    await recordCronRun('reconcile-presence', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/reconcile-presence', adminOrAnyAdminOrCron, withCronLock('reconcile-presence', cronReconcilePresence));
router.post('/cron/reconcile-presence', adminOrAnyAdminOrCron, withCronLock('reconcile-presence', cronReconcilePresence));

/**
 * Daily purge of expired ephemeral credential tables.
 *
 * - rate_limit_buckets (mig 080): rows whose expires_at has passed.
 * - sse_tickets       (mig 081): tickets whose expires_at has passed.
 *
 * Both tables are write-heavy and short-lived; one cron at 09:45 UTC keeps
 * them small. Each lookup is gated on `to_regclass` so a deploy without
 * the migrations applied still records a "skipped" run instead of erroring.
 */
async function cronPurgeRateLimit(req, res, next) {
  try {
    const summary = {};
    const rlExists = await db.raw("SELECT to_regclass('rate_limit_buckets') AS t");
    if (rlExists.rows?.[0]?.t) {
      summary.rate_limit_deleted = await db('rate_limit_buckets')
        .where('expires_at', '<', db.fn.now())
        .del();
    } else {
      summary.rate_limit_skipped = 'table missing — apply migration 080';
    }
    const tkExists = await db.raw("SELECT to_regclass('sse_tickets') AS t");
    if (tkExists.rows?.[0]?.t) {
      summary.sse_tickets_deleted = await db('sse_tickets')
        .where('expires_at', '<', db.fn.now())
        .del();
    } else {
      summary.sse_tickets_skipped = 'table missing — apply migration 081';
    }
    // [O7] bq_sync_warnings — append-only per CLAUDE.md, no purge cron existed.
    // Default 90 days retention. Override with BQ_SYNC_WARNINGS_RETENTION_DAYS.
    const wExists = await db.raw("SELECT to_regclass('bq_sync_warnings') AS t");
    if (wExists.rows?.[0]?.t) {
      const days = Number(process.env.BQ_SYNC_WARNINGS_RETENTION_DAYS) || 90;
      summary.bq_sync_warnings_deleted = await db('bq_sync_warnings')
        .whereRaw(`occurred_at < NOW() - INTERVAL '${days} days'`)
        .del();
      summary.bq_sync_warnings_retention_days = days;
    }
    // [O4] error_log — same purge channel for the new error log table.
    const elExists = await db.raw("SELECT to_regclass('error_log') AS t");
    if (elExists.rows?.[0]?.t) {
      const days = Number(process.env.ERROR_LOG_RETENTION_DAYS) || 90;
      summary.error_log_deleted = await db('error_log')
        .whereRaw(`occurred_at < NOW() - INTERVAL '${days} days'`)
        .del();
      summary.error_log_retention_days = days;
    }
    await recordCronRun('purge-rate-limit', 'ok', summary);
    res.json(summary);
  } catch (err) {
    await recordCronRun('purge-rate-limit', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/purge-rate-limit', adminOrAnyAdminOrCron, withCronLock('purge-rate-limit', cronPurgeRateLimit));
router.post('/cron/purge-rate-limit', adminOrAnyAdminOrCron, withCronLock('purge-rate-limit', cronPurgeRateLimit));

module.exports = router;
