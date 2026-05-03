const bqSyncService = require('./bqSync.service');

async function workerTick(req, res, next) {
  try {
    // Accept the same auth patterns as imports/_worker.
    const secret = process.env.CRON_SECRET || process.env.MARZAM_CRON_SECRET;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const presented = bearer || req.headers['x-cron-secret'] || req.query.secret;
    const authedDirector = req.user && (req.user.role === 'director_sucursal' || req.user.role === 'national_admin');

    if (secret) {
      if (presented !== secret && !authedDirector) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } else if (!authedDirector) {
      return res.status(401).json({ error: 'Worker secret not configured and request is not authenticated' });
    }

    const limitPerJob = req.query.limit ? Number(req.query.limit) : null;
    const result = await bqSyncService.runAll({ limitPerJob });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { workerTick };
