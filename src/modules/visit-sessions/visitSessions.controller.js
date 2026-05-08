const service = require('./visitSessions.service');
const accessDirectory = require('../../services/accessDirectory');

async function start(req, res, next) {
  try {
    const session = await service.start({
      userId: req.user.id,
      branchId: req.body.branch_id,
      visitPlanId: req.body.visit_plan_id,
      pharmaciesPlanned: req.body.pharmacies_planned,
      notes: req.body.notes,
    });
    res.status(201).json(session);
  } catch (err) { next(err); }
}

async function end(req, res, next) {
  try {
    const session = await service.end({
      sessionId: req.params.id,
      userId: req.user.id,
      isGlobal: req.user.is_global,
      reason: req.body && req.body.reason,
    });
    res.json(session);
  } catch (err) { next(err); }
}

async function active(req, res, next) {
  try {
    const session = await service.getActive({
      // Accept stale virtual ids ('u-dir-001') from cached frontends and
      // translate to the canonical UUID before hitting the DB.
      targetUserId: accessDirectory.toCanonicalId(req.params.userId),
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(session || null);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const userId = accessDirectory.toCanonicalId(req.query.user_id || req.user.id);
    const sessions = await service.listForUser({
      userId,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
      limit: req.query.limit,
    });
    res.json(sessions);
  } catch (err) { next(err); }
}

module.exports = { start, end, active, list };
