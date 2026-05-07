const bqSyncService = require('./bqSync.service');
const purgeRouteCache = require('./jobs/purgeRouteCache');
const { secretsEqual } = require('../../utils/secretCompare');

function checkCronAuth(req, res) {
  const secret = process.env.CRON_SECRET || process.env.MARZAM_CRON_SECRET;
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
  try {
    if (!checkCronAuth(req, res)) return;
    const result = await purgeRouteCache.run();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function workerTick(req, res, next) {
  try {
    if (!checkCronAuth(req, res)) return;
    const limitPerJob = req.query.limit ? Number(req.query.limit) : null;
    const result = await bqSyncService.runAll({ limitPerJob });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { workerTick, purgeRouteCacheTick };
