const service = require('./planConflictAlerts.service');

async function list(req, res, next) {
  try {
    const rows = await service.list({
      branchId: req.query.branch_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function show(req, res, next) {
  try {
    const row = await service.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Alert not found' });
    res.json(row);
  } catch (err) { next(err); }
}

async function acknowledge(req, res, next) {
  try {
    const row = await service.acknowledge(req.params.id, req.user.id);
    res.json(row);
  } catch (err) { next(err); }
}

async function dismiss(req, res, next) {
  try {
    const row = await service.dismiss(req.params.id, req.user.id);
    res.json(row);
  } catch (err) { next(err); }
}

async function reoptimize(req, res, next) {
  try {
    const {
      plan_type: planType,
      custom_start: customStart,
      custom_end: customEnd,
    } = req.body || {};
    const result = await service.reoptimize(req.params.id, {
      triggeredByUserId: req.user.id,
      planType: planType || 'custom',
      customStart,
      customEnd,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
}

module.exports = { list, show, acknowledge, dismiss, reoptimize };
