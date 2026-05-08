const service = require('./alerts.service');
const engine = require('./alerts.engine');
const { secretsEqual } = require('../../utils/secretCompare');
const { recordCronRun } = require('../../utils/cronRunRecorder');

async function feed(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await engine.feed({
      actorId: req.user.id,
      isGlobal: req.user.is_global,
      limit,
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function resolve(req, res, next) {
  try {
    const row = await engine.resolve({
      alertId: req.params.id,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(row);
  } catch (err) { next(err); }
}

// Cron tick — auth via shared secret OR an authenticated admin.
async function evaluateTick(req, res, next) {
  const startedAt = Date.now();
  try {
    const cronSecret = process.env.CRON_SECRET;
    const headerSecret = req.headers['x-cron-secret'];
    const queryToken = req.query.token;
    const fromCron = cronSecret && (secretsEqual(headerSecret, cronSecret) || secretsEqual(queryToken, cronSecret));
    const fromAdmin = req.user && (req.user.role === 'admin' || req.user.is_global);
    if (!fromCron && !fromAdmin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const summary = await engine.evaluateAll();
    // [O1] Record cron run for scheduler/health observability.
    await recordCronRun('alerts-evaluate', 'ok', {
      ...(summary && typeof summary === 'object' ? summary : {}),
      duration_ms: Date.now() - startedAt,
    });
    res.json({ ok: true, evaluated_at: new Date().toISOString(), summary });
  } catch (err) {
    await recordCronRun('alerts-evaluate', 'error', {
      message: err && err.message ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    });
    next(err);
  }
}

async function listDismissals(req, res, next) {
  try {
    const rows = await service.listDismissals(req.user.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function dismiss(req, res, next) {
  try {
    const row = await service.dismiss({
      userId: req.user.id,
      alertKey: req.body.alert_key,
      expiresAt: req.body.expires_at || null,
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function undismiss(req, res, next) {
  try {
    const result = await service.undismiss({
      userId: req.user.id,
      alertKey: req.params.key,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { feed, resolve, evaluateTick, listDismissals, dismiss, undismiss };
