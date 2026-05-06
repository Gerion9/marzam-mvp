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

const router = Router();

/**
 * Permits either a logged-in admin OR a request with x-cron-secret matching
 * the env var. Lets Vercel Cron jobs hit operational endpoints without going
 * through user auth.
 */
function adminOrCron(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  const supplied = req.header('x-cron-secret') || req.query.cron_secret;
  if (cronSecret && supplied && supplied === cronSecret) return next();
  // Fall through to standard auth + admin gate.
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    return authorize({ adminOnly: true })(req, res, next);
  });
}

// ── Routes API budget (for plan editor cost chip + admin dashboard) ────────
router.get('/routes-budget', authenticate, authorize({ roles: ['director_sucursal', 'gerente_ventas', 'supervisor'] }), async (req, res, next) => {
  try {
    const status = await routesMatrix.getDailyBudgetStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// ── Scheduler health (each cron writes to cron_runs) ──────────────────────
router.get('/scheduler/health', authenticate, authorize({ adminOnly: true }), async (req, res, next) => {
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
router.get('/cron/purge-route-cache', adminOrCron, cronPurgeRouteCache);
router.post('/cron/purge-route-cache', adminOrCron, cronPurgeRouteCache);

async function cronPurgeTracking(req, res, next) {
  try {
    const days = Number(process.env.TRACKING_RETENTION_DAYS) || 30;
    const result = await db('rep_tracking_points')
      .whereRaw(`recorded_at < NOW() - INTERVAL '${days} days'`)
      .del();
    const summary = { deleted: result, retention_days: days };
    await recordCronRun('purge-tracking', 'ok', summary);
    res.json(summary);
  } catch (err) {
    await recordCronRun('purge-tracking', 'error', { message: err.message });
    next(err);
  }
}
router.get('/cron/purge-tracking', adminOrCron, cronPurgeTracking);
router.post('/cron/purge-tracking', adminOrCron, cronPurgeTracking);

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
router.get('/cron/geocode-backfill', adminOrCron, cronGeocodeBackfill);
router.post('/cron/geocode-backfill', adminOrCron, cronGeocodeBackfill);

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
router.get('/quadrants/snapshot', adminOrCron, cronQuadrantsSnapshot);
router.post('/quadrants/snapshot', adminOrCron, cronQuadrantsSnapshot);

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
router.get('/cron/purge-live-outbox', adminOrCron, cronPurgeLiveOutbox);
router.post('/cron/purge-live-outbox', adminOrCron, cronPurgeLiveOutbox);

async function recordCronRun(jobKey, status, payload) {
  try {
    await db.raw(`
      INSERT INTO cron_runs (job_key, last_run_at, last_status, last_payload)
      VALUES (?, NOW(), ?, ?::jsonb)
      ON CONFLICT (job_key) DO UPDATE
        SET last_run_at = NOW(),
            last_status = EXCLUDED.last_status,
            last_payload = EXCLUDED.last_payload
    `, [jobKey, status, JSON.stringify(payload || {})]);
  } catch {
    // cron_runs may not exist yet (pre-067) — best effort
  }
}

module.exports = router;
