const service = require('./visitTargets.service');
const accessDirectory = require('../../services/accessDirectory');

async function list(req, res, next) {
  try {
    const branchId = req.query.branch_id || null;
    const channel = req.query.channel || 'visit';
    const rows = await service.listEffective({ branchId, channel });
    res.json(rows);
  } catch (err) { next(err); }
}

async function listExpanded(req, res, next) {
  try {
    const branchId = req.query.branch_id || null;
    const channel = req.query.channel || 'visit';
    const result = await service.listExpandedMatrix({ branchId, channel });
    res.json(result);
  } catch (err) { next(err); }
}

async function listOverrides(req, res, next) {
  try {
    const rows = await service.listOverrides({
      subordinateUserId: accessDirectory.toCanonicalId(req.params.userId),
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function upsert(req, res, next) {
  try {
    const {
      branch_id: branchId,
      pareto_class: paretoClass,
      channel,
      role,
      category_kind: categoryKind,
      days_share: daysShare,
      daily_contacts_per_person: dailyContactsPerPerson,
      head_count: headCount,
      monthly_target: monthlyTarget,
      effective_from: effectiveFrom,
    } = req.body || {};

    if (!paretoClass || !role || dailyContactsPerPerson === undefined) {
      return res.status(400).json({ error: 'pareto_class, role, daily_contacts_per_person required' });
    }
    const row = await service.upsertTarget({
      actor: req.user,
      branchId,
      paretoClass,
      channel,
      role,
      categoryKind,
      daysShare,
      dailyContactsPerPerson,
      headCount,
      monthlyTarget,
      effectiveFrom,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
}

async function bulkUpsert(req, res, next) {
  try {
    const branchId = req.body.branch_id || req.query.branch_id || null;
    const cells = req.body.cells || req.body;
    const channel = req.body.channel || 'visit';

    if (!Array.isArray(cells) || !cells.length) {
      return res.status(400).json({ error: 'cells array required' });
    }
    const results = await service.bulkUpsert({ actor: req.user, branchId, cells, channel });
    res.status(200).json(results);
  } catch (err) { next(err); }
}

async function override(req, res, next) {
  try {
    const {
      subordinate_user_id: subordinateUserIdRaw,
      pareto_class: paretoClass,
      channel,
      daily_contacts_per_person: dailyContactsPerPerson,
      reason,
      effective_from: effectiveFrom,
    } = req.body || {};
    if (!subordinateUserIdRaw || !paretoClass || dailyContactsPerPerson === undefined) {
      return res.status(400).json({ error: 'subordinate_user_id, pareto_class, daily_contacts_per_person required' });
    }
    const row = await service.createOverride({
      actor: req.user,
      subordinateUserId: accessDirectory.toCanonicalId(subordinateUserIdRaw),
      paretoClass,
      channel,
      dailyContactsPerPerson,
      reason,
      effectiveFrom,
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
}

async function resolve(req, res, next) {
  try {
    // Accept `pareto_class`, `pareto`, or `paretoClass` for backward/forward compat
    // with frontend callers (views.js sends `pareto`, OpenAPI doc says `pareto_class`).
    const paretoClass = req.query.pareto_class
      || req.query.pareto
      || req.query.paretoClass
      || null;
    const userIdRaw = req.query.user_id || req.query.userId || null;
    if (!userIdRaw || !paretoClass) {
      return res.status(400).json({
        error: 'user_id and pareto_class (or pareto) query params are required',
      });
    }
    const v = await service.resolveForUser({
      userId: accessDirectory.toCanonicalId(userIdRaw),
      paretoClass,
      channel: req.query.channel || 'visit',
      date: req.query.date || null,
    });
    res.json({ daily_contacts_per_person: v });
  } catch (err) { next(err); }
}

module.exports = {
  list,
  listExpanded,
  listOverrides,
  upsert,
  bulkUpsert,
  override,
  resolve,
};
