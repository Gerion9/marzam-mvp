const bqSyncService = require('./bqSync.service');
const purgeRouteCache = require('./jobs/purgeRouteCache');
const { secretsEqual } = require('../../utils/secretCompare');
const { recordCronRun } = require('../../utils/cronRunRecorder');

function checkCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const presented = bearer || req.headers['x-cron-secret'] || req.query.secret;
  const authedDirector = req.user && (req.user.role === 'director_sucursal' || req.user.role === 'national_admin');
  if (secret) {
    if (!secretsEqual(presented, secret) && !authedDirector) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
  } else if (!authedDirector) {
    res.status(401).json({ error: 'Worker secret not configured and request is not authenticated' });
    return false;
  }
  return true;
}

async function purgeRouteCacheTick(req, res, next) {
  const startedAt = Date.now();
  try {
    if (!checkCronAuth(req, res)) return;
    const result = await purgeRouteCache.run();
    await recordCronRun('bq-purge-route-cache', 'ok', {
      ...(result && typeof result === 'object' ? result : { result }),
      duration_ms: Date.now() - startedAt,
    });
    res.json(result);
  } catch (err) {
    await recordCronRun('bq-purge-route-cache', 'error', {
      message: err && err.message ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    });
    next(err);
  }
}

async function workerTick(req, res, next) {
  const startedAt = Date.now();
  try {
    if (!checkCronAuth(req, res)) return;
    const limitPerJob = req.query.limit ? Number(req.query.limit) : null;
    const result = await bqSyncService.runAll({ limitPerJob });
    // [O1] Record summary so /api/admin/scheduler/health includes bq-sync.
    // The 5-job orchestrator returns { jobs: [...] }; we surface the count.
    const summary = {
      jobs_run: Array.isArray(result?.jobs) ? result.jobs.length : 0,
      duration_ms: Date.now() - startedAt,
    };
    await recordCronRun('bq-sync-worker', 'ok', summary);
    res.json(result);
  } catch (err) {
    await recordCronRun('bq-sync-worker', 'error', {
      message: err && err.message ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    });
    next(err);
  }
}

module.exports = { workerTick, purgeRouteCacheTick };
