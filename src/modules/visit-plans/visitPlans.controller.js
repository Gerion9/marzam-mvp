const service = require('./visitPlans.service');
const accessDirectory = require('../../services/accessDirectory');
const { ROLE_PRIMARY_PARETO, PARETO_CLASSES } = require('./planGenerator');
const { normalizeRole } = require('../../constants/roles');

/**
 * Audit Fix #3 — preview endpoints accept arbitrary `scope_user_ids` in the
 * body. They are allow-listed for demo users in `demoReadonly.js` (so the
 * Plan Editor sandbox works), but a curl client with a demo token can ask
 * for previews against ANY rep's scope and receive real plan data.
 *
 * Backend defense: when the actor is a demo user, force `scopeUserIds` to
 * just the demo user's own canonical id. The frontend `demoHierarchy.js`
 * already does this for the happy path; this is the backend net.
 */
function enforceDemoScope(req, scopeUserIds) {
  if (req.user?.data_scope !== 'demo') return scopeUserIds;
  // Demo users may only preview against themselves. Drop everything else
  // silently — returning a 403 would be more honest but would break the
  // demo UX flow described in `demoReadonly.js:42-49` (sandbox needs to
  // succeed without bouncing through error handlers).
  const own = req.user.id ? [req.user.id] : [];
  return own;
}

/**
 * Validate the pareto_filter array passed in the request.
 *
 * Rules:
 *   1. Must be a subset of PARETO_CLASSES (A/B/C). 'D' is prospecto-only and
 *      doesn't exist in marzam_clients.pareto.
 *   2. For non-admin actors, must intersect the union of allowed paretos for
 *      the scope users' roles (otherwise the plan would be guaranteed empty).
 *      Caller passes scopeUserRoles via the second arg.
 */
function validateParetoFilter(req, paretoFilter, scopeUserRoles = []) {
  if (!paretoFilter) return null;
  if (!Array.isArray(paretoFilter)) return 'pareto_filter must be an array';
  for (const p of paretoFilter) {
    if (!PARETO_CLASSES.includes(p)) {
      return `pareto_filter contains '${p}' which is not a valid Pareto class (must be one of ${PARETO_CLASSES.join(',')})`;
    }
  }
  if (req.user?.is_global) return null;
  if (!scopeUserRoles.length) return null;
  const allowedUnion = new Set();
  for (const role of scopeUserRoles) {
    const r = normalizeRole(role);
    for (const p of (ROLE_PRIMARY_PARETO[r] || [])) allowedUnion.add(p);
  }
  const intersects = paretoFilter.some((p) => allowedUnion.has(p));
  if (!intersects) {
    return `pareto_filter ${JSON.stringify(paretoFilter)} doesn't overlap with scope users' allowed paretos ${JSON.stringify([...allowedUnion])}`;
  }
  return null;
}

async function loadScopeUserRoles(scopeUserIds) {
  const db = require('../../config/database');
  const rows = await db('users').whereIn('id', scopeUserIds).select('role');
  return rows.map((r) => r.role);
}

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
    const canonicalIds = scopeUserIds.map((id) => accessDirectory.toCanonicalId(id));
    const scopeUserRoles = await loadScopeUserRoles(canonicalIds);
    const paretoErr = validateParetoFilter(req, paretoFilter, scopeUserRoles);
    if (paretoErr) return res.status(400).json({ error: paretoErr });
    const result = await service.generate({
      ownerUserId: req.user.id,
      scopeUserIds: canonicalIds,
      granularity,
      periodStart,
      periodEnd,
      paretoFilter,
      branchId,
      name,
      actorIsGlobal: !!req.user.is_global,
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
    const scopedIds = enforceDemoScope(req, scopeUserIds);
    const result = await service.preview({
      ownerUserId: req.user.id,
      scopeUserIds: scopedIds.map((id) => accessDirectory.toCanonicalId(id)),
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
    const scopedIds = enforceDemoScope(req, scopeUserIds);
    const canonicalIds = scopedIds.map((id) => accessDirectory.toCanonicalId(id));
    const scopeUserRoles = await loadScopeUserRoles(canonicalIds);
    const paretoErr = validateParetoFilter(req, paretoFilter, scopeUserRoles);
    if (paretoErr) return res.status(400).json({ error: paretoErr });
    const result = await service.previewFull({
      ownerUserId: req.user.id,
      scopeUserIds: canonicalIds,
      granularity: granularity || 'weekly',
      periodStart,
      periodEnd,
      paretoFilter,
      branchId,
      name,
      routeStartHHMM,
      // is_global del JWT: bypasses canActorManage en planGenerator. Necesario
      // para directores con UUID virtual del access directory que no tienen
      // row en `users` table — el check de scope ya se hizo en `authorize` y
      // los usuarios no-global tampoco pasarían el rbac de previewFull.
      actorIsGlobal: !!req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function costEstimate(req, res, next) {
  try {
    const {
      scope_user_ids: scopeUserIds,
      granularity,
      period_start: periodStart,
      period_end: periodEnd,
      pareto_filter: paretoFilter,
      branch_id: branchId,
      route_start_hhmm: routeStartHHMM,
    } = req.body || {};
    if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
      return res.status(400).json({ error: 'scope_user_ids is required' });
    }
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'period_start, period_end required' });
    }
    const scopedIds = enforceDemoScope(req, scopeUserIds);
    const canonicalIds = scopedIds.map((id) => accessDirectory.toCanonicalId(id));
    const scopeUserRoles = await loadScopeUserRoles(canonicalIds);
    const paretoErr = validateParetoFilter(req, paretoFilter, scopeUserRoles);
    if (paretoErr) return res.status(400).json({ error: paretoErr });
    const result = await service.estimateCost({
      ownerUserId: req.user.id,
      scopeUserIds: canonicalIds,
      granularity: granularity || 'weekly',
      periodStart,
      periodEnd,
      paretoFilter,
      branchId,
      routeStartHHMM,
      actorIsGlobal: !!req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function resequenceUser(req, res, next) {
  try {
    const planId = req.params.id;
    const userId = accessDirectory.toCanonicalId(req.params.userId);
    const result = await service.resequenceUser({
      planId,
      visitorUserId: userId,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
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

async function postMortemCsv(req, res, next) {
  try {
    const result = await service.postMortem(req.params.id, {
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    const headers = [
      'rep_id', 'rep_name', 'role',
      'planned', 'done', 'skipped',
      'actual_visits', 'alerts_fired',
      'expected_drive_min', 'expected_service_min',
      'first_actual_start', 'last_actual_start',
      'completion_pct', 'on_time_pct',
    ];
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines = [headers.join(',')];
    for (const r of (result.per_rep || [])) {
      lines.push([
        r.visitor_user_id, r.visitor_name, r.visitor_role,
        r.assignments_planned, r.assignments_done, r.assignments_skipped,
        r.actual_visits_count, r.alerts_fired,
        r.estimated_drive_minutes, r.estimated_service_minutes,
        r.first_actual_start, r.last_actual_start,
        r.completion_pct, r.on_time_pct,
      ].map(escape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="post-mortem-${req.params.id}.csv"`);
    res.send(lines.join('\n'));
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
    const { assignment_id: assignmentId, new_visitor_user_id: newVisitorUserId, force } = req.body || {};
    if (!assignmentId || !newVisitorUserId) {
      return res.status(400).json({ error: 'assignment_id and new_visitor_user_id are required' });
    }
    const result = await service.reassignStop({
      planId,
      assignmentId,
      newVisitorUserId: accessDirectory.toCanonicalId(newVisitorUserId),
      actorId: req.user.id,
      isGlobal: req.user.is_global,
      force: force === true || req.query.force === 'true',
    });
    res.json(result);
  } catch (err) {
    // Surface 409 cap_exceeded with structured payload for the FE alternatives modal.
    if (err.status === 409 && err.code === 'cap_exceeded' && err.payload) {
      return res.status(409).json(err.payload);
    }
    next(err);
  }
}

async function reoptimizeDay(req, res, next) {
  try {
    const planId = req.params.id;
    const {
      date,
      broken_user_id: brokenUserId,
      urgent_stop: urgentStop,
      cap_exceed_user_id: capExceedUserId,
      trigger_kind: triggerKindRaw,
    } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date (ISO YYYY-MM-DD) is required' });

    // Infer trigger_kind from payload when not explicit.
    let triggerKind = triggerKindRaw;
    if (!triggerKind) {
      if (brokenUserId) triggerKind = 'rep_breakdown';
      else if (urgentStop) triggerKind = 'urgent_insert';
      else if (capExceedUserId) triggerKind = 'cap_exceed';
      else triggerKind = 'manual';
    }
    if (!['rep_breakdown', 'urgent_insert', 'cap_exceed', 'manual'].includes(triggerKind)) {
      return res.status(400).json({ error: `invalid trigger_kind '${triggerKind}'` });
    }
    if (urgentStop && !urgentStop.pharmacy_id && !urgentStop.marzam_client_id) {
      return res.status(400).json({ error: 'urgent_stop must include pharmacy_id or marzam_client_id' });
    }

    const result = await service.reoptimizeDay({
      planId,
      date,
      brokenUserId: brokenUserId ? accessDirectory.toCanonicalId(brokenUserId) : null,
      urgentStop: urgentStop || null,
      capExceedUserId: capExceedUserId ? accessDirectory.toCanonicalId(capExceedUserId) : null,
      triggerKind,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function listReoptimizations(req, res, next) {
  try {
    const result = await service.listReoptimizations(req.params.id, {
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
  costEstimate,
  resequenceUser,
  postMortemCsv,
  reoptimizeDay,
  listReoptimizations,
};
