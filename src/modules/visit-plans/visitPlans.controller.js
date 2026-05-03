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
  publish,
  archive,
  myAssignments,
};
