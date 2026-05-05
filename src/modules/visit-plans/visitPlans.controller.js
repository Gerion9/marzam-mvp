const service = require('./visitPlans.service');
const accessDirectory = require('../../services/accessDirectory');

async function list(req, res, next) {
  try {
    const rows = await service.listForUser({ userId: req.user.id, isGlobal: req.user.is_global });
    res.json(rows);
  } catch (err) { next(err); }
}

async function show(req, res, next) {
  try {
    const plan = await service.getById(req.params.id, { userId: req.user.id, isGlobal: req.user.is_global });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const {
      scope_user_ids: scopeUserIds,
      granularity,
      period_start: periodStart,
      period_end: periodEnd,
      pareto_filter: paretoFilter,
      branch_id: branchId,
      name,
    } = req.body || {};
    if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
      return res.status(400).json({ error: 'scope_user_ids is required' });
    }
    if (!granularity || !periodStart || !periodEnd) {
      return res.status(400).json({ error: 'granularity, period_start, period_end required' });
    }
    const result = await service.generate({
      ownerUserId: req.user.id,
      // Tolerate stale virtual ids in scope_user_ids by translating each one.
      scopeUserIds: scopeUserIds.map((id) => accessDirectory.toCanonicalId(id)),
      granularity,
      periodStart,
      periodEnd,
      paretoFilter,
      branchId,
      name,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
}

async function preview(req, res, next) {
  try {
    const {
      scope_user_ids: scopeUserIds,
      period_start: periodStart,
      period_end: periodEnd,
      pareto_filter: paretoFilter,
    } = req.body || {};
    if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
      return res.status(400).json({ error: 'scope_user_ids is required' });
    }
    const result = await service.preview({
      ownerUserId: req.user.id,
      scopeUserIds: scopeUserIds.map((id) => accessDirectory.toCanonicalId(id)),
      periodStart,
      periodEnd,
      paretoFilter,
    });
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * Rich preview that runs the full driving-aware planGenerator without
 * persisting. Returns assignments with ETAs and polylines so the Plan
 * Editor map can draw the routes.
 */
async function previewFull(req, res, next) {
  try {
    const {
      scope_user_ids: scopeUserIds,
      granularity,
      period_start: periodStart,
      period_end: periodEnd,
      pareto_filter: paretoFilter,
      branch_id: branchId,
      name,
      route_start_hhmm: routeStartHHMM,
    } = req.body || {};
    if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
      return res.status(400).json({ error: 'scope_user_ids is required' });
    }
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'period_start, period_end required' });
    }
    const result = await service.previewFull({
      ownerUserId: req.user.id,
      scopeUserIds: scopeUserIds.map((id) => accessDirectory.toCanonicalId(id)),
      granularity: granularity || 'weekly',
      periodStart,
      periodEnd,
      paretoFilter,
      branchId,
      name,
      routeStartHHMM,
    });
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * Routing sandbox — runs the full routing pipeline on caller-supplied
 * users + stops without touching the DB. Safe for demo users.
 *
 * Body: { users: [{id, home_lat, home_lng}], stops: [{id, user_id, lat, lng, name?, pareto?}], date: "YYYY-MM-DD" }
 */
async function previewRouting(req, res, next) {
  try {
    const { users, stops, date, service_minutes_per_stop } = req.body || {};
    const result = await service.routePreview({ users, stops, date, service_minutes_per_stop });
    res.json(result);
  } catch (err) { next(err); }
}

async function postMortem(req, res, next) {
  try {
    const result = await service.postMortem(req.params.id, {
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function replayRepDay(req, res, next) {
  try {
    const repId = accessDirectory.toCanonicalId(req.params.repId);
    const result = await service.replayRepDay(req.params.id, repId, req.params.day, {
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function reassignStop(req, res, next) {
  try {
    const planId = req.params.id;
    const { assignment_id: assignmentId, new_visitor_user_id: newVisitorUserId } = req.body || {};
    if (!assignmentId || !newVisitorUserId) {
      return res.status(400).json({ error: 'assignment_id and new_visitor_user_id are required' });
    }
    const result = await service.reassignStop({
      planId,
      assignmentId,
      newVisitorUserId: accessDirectory.toCanonicalId(newVisitorUserId),
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function publish(req, res, next) {
  try {
    const updated = await service.publish(req.params.id, req.user.id);
    res.json(updated);
  } catch (err) { next(err); }
}

async function archive(req, res, next) {
  try {
    const updated = await service.archive(req.params.id, req.user.id);
    res.json(updated);
  } catch (err) { next(err); }
}

async function startAssignment(req, res, next) {
  try {
    const updated = await service.startAssignment({
      assignmentId: req.params.id,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(updated);
  } catch (err) { next(err); }
}

async function deviateAssignment(req, res, next) {
  try {
    const updated = await service.deviateAssignment({
      assignmentId: req.params.id,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
      reason: req.body?.reason,
    });
    res.json(updated);
  } catch (err) { next(err); }
}

async function myAssignments(req, res, next) {
  try {
    const targetUserId = accessDirectory.toCanonicalId(
      req.query.user_id || req.user.id,
    );
    if (targetUserId !== req.user.id && !req.user.is_global) {
      const { canActorManage } = require('../../services/teamScope');
      if (!await canActorManage(req.user.id, targetUserId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    const rows = await service.listAssignmentsForUser({
      visitorUserId: targetUserId,
      dateFrom: req.query.from,
      dateTo: req.query.to,
    });
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = {
  list,
  show,
  create,
  preview,
  previewFull,
  previewRouting,
  reassignStop,
  publish,
  archive,
  myAssignments,
  startAssignment,
  deviateAssignment,
  postMortem,
  replayRepDay,
};
