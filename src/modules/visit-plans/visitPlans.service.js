const db = require('../../config/database');
const planGenerator = require('./planGenerator');
const { canActorManage } = require('../../services/teamScope');
const routesMatrix = require('../../services/routesMatrix');
const securityPolygons = require('../../services/securityPolygons');
const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');
const intradayReoptimizer = require('./intradayReoptimizer');
const branchPlanSettings = require('../../services/branchPlanSettings');

const ENABLE_CAP_VALIDATION_REASSIGN = process.env.PLAN_ENABLE_CAP_VALIDATION === 'true';

/**
 * Fórmula pura para el cómputo de cuota — testeable sin DB. Recibe el límite
 * configurado, los planes ya usados hoy, y un `now` (default Date.now()) y
 * devuelve el bloque que se le sirve al cliente.
 *
 * `reset_at` es la siguiente medianoche UTC: las cuotas son por día UTC para
 * evitar ambigüedades de DST. Si el cliente Marzam necesita "día Cd. de México"
 * en algún momento, basta con cambiar este cálculo y todo el stack hereda.
 */
function computeQuotaResult({ limit, used, now = new Date() }) {
  const lim = Math.max(0, Math.floor(Number(limit) || 0));
  const useNum = Math.max(0, Math.floor(Number(used) || 0));
  const remaining = Math.max(0, lim - useNum);
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
  ));
  return {
    daily_limit: lim,
    used_today: useNum,
    remaining,
    exceeded: useNum >= lim,
    reset_at: nextMidnight.toISOString(),
    // Hint estable para el frontend (no requiere config en cada vista):
    _hint: lim === 0
      ? 'Tu sucursal tiene la cuota deshabilitada (0). Pide al admin que la suba.'
      : `Las cuotas se resetean a media noche UTC (${nextMidnight.toISOString().slice(11, 16)} UTC).`,
  };
}

/**
 * Cuota diaria de planes del owner. Mira la branch del user (si tiene), lee
 * `plan_settings.daily_plans_limit` con validación + default 3, y cuenta los
 * planes generados HOY (UTC) por ese owner que no estén archived.
 *
 * Plans con status `archived` no cuentan: la idea del límite es prevenir que
 * un manager queme presupuesto con drafts infinitos, pero si ya descartó el
 * draft no debería seguir penalizando.
 */
async function getRemainingPlanQuota({ userId }) {
  if (!userId) {
    return computeQuotaResult({ limit: branchPlanSettings.DEFAULTS.daily_plans_limit, used: 0 });
  }

  // Branch del owner. Puede ser NULL para virtuales — en ese caso usamos default.
  const owner = await db('users').where({ id: userId }).select('branch_id').first();
  const branchId = owner?.branch_id || null;
  const settings = await branchPlanSettings.get(branchId);
  const limit = Number.isFinite(settings.daily_plans_limit)
    ? settings.daily_plans_limit
    : branchPlanSettings.DEFAULTS.daily_plans_limit;

  const row = await db('visit_plans')
    .where('owner_user_id', userId)
    .whereNot('status', 'archived')
    .whereRaw("created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')")
    .count('* as n')
    .first();
  const used = Number(row?.n || 0);
  return computeQuotaResult({ limit, used });
}

function haversineKmService(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Compute current minutes used by a rep on a given day (sum of expected_travel +
 * expected_service across non-deviated assignments). Used by tryFitForReassign.
 */
async function currentMinutesByRep(planId, repId, date) {
  const r = await db('visit_plan_assignments')
    .where({ visit_plan_id: planId, visitor_user_id: repId, scheduled_date: date })
    .whereNot('status', 'deviated')
    .sum({
      total_travel: db.raw('COALESCE(expected_travel_minutes, 0)'),
      total_service: db.raw('COALESCE(expected_service_minutes, 0)'),
    })
    .first();
  return {
    totalMin: Number(r?.total_travel || 0) + Number(r?.total_service || 0),
    travelMin: Number(r?.total_travel || 0),
  };
}

/**
 * Find top-N alternative reps for a stop that can't fit in its current rep's cap.
 *
 * Score = headroom_min × 0.6 + (1 / distance_km) × 4. Vetoes reps that would still
 * exceed cap after adding the stop's expected minutes.
 *
 * Returns [{ user_id, full_name, role, headroom_min, distance_km, score }] sorted desc.
 */
async function findReassignAlternatives({ planId, scheduledDate, assignmentId, excludeUserId, topN = 3 }) {
  const target = await db('visit_plan_assignments as vpa')
    .where('vpa.id', assignmentId)
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.expected_service_minutes',
      'vpa.expected_travel_minutes',
      db.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      db.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    )
    .first();
  if (!target || target.lat == null) return [];

  const stopPoint = { lat: Number(target.lat), lng: Number(target.lng) };
  const expectedAddMin = Number(target.expected_service_minutes || 45) + Number(target.expected_travel_minutes || 30);

  // Candidates: every distinct rep already in this plan that day except the excluded one.
  const candidateIds = await db('visit_plan_assignments')
    .where({ visit_plan_id: planId, scheduled_date: scheduledDate })
    .whereNot('visitor_user_id', excludeUserId)
    .distinct('visitor_user_id')
    .pluck('visitor_user_id');
  if (!candidateIds.length) return [];

  const reps = await db('users')
    .whereIn('id', candidateIds)
    .andWhere({ is_active: true })
    .select('id', 'full_name', 'role', 'home_lat', 'home_lng', 'daily_minutes_cap');

  const out = [];
  for (const rep of reps) {
    if (rep.home_lat == null || rep.home_lng == null) continue;
    const cap = rep.daily_minutes_cap || 480;
    const cur = await currentMinutesByRep(planId, rep.id, scheduledDate);
    const headroom = cap - cur.totalMin;
    if (headroom < expectedAddMin) continue;
    const home = { lat: Number(rep.home_lat), lng: Number(rep.home_lng) };
    const distKm = haversineKmService(home, stopPoint);
    const score = headroom * 0.6 + (1 / Math.max(distKm, 0.5)) * 4;
    out.push({
      user_id: rep.id,
      full_name: rep.full_name,
      role: rep.role,
      headroom_min: Math.round(headroom),
      distance_km: Math.round(distKm * 10) / 10,
      score: Math.round(score * 100) / 100,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}

async function listForUser({ userId, isGlobal = false }) {
  const q = db('visit_plans as vp')
    .select('vp.*')
    .leftJoin('users as o', 'o.id', 'vp.owner_user_id')
    .leftJoin('users as s', 's.id', 'vp.scope_user_id')
    .select('o.full_name as owner_name', 's.full_name as scope_user_name')
    .orderBy('vp.created_at', 'desc')
    .limit(200);
  if (!isGlobal) {
    q.where(function () {
      this.where('vp.owner_user_id', userId).orWhere('vp.scope_user_id', userId);
    });
  }
  return q;
}

async function getById(id, { userId, isGlobal }) {
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) return null;
  const ownerCanSee = isGlobal || plan.owner_user_id === userId || plan.scope_user_id === userId;
  if (!ownerCanSee) {
    if (plan.scope_user_id && !await canActorManage(userId, plan.scope_user_id)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  }
  // Post-migración 050 cada assignment apunta a UN cliente Marzam (mc) O a UNA
  // farmacia prospecto (pp).  Resolvemos ambos con LEFT JOINs y devolvemos
  // los campos coalescidos para que el FE pinte la fila igual sin importar
  // el origen.  El campo `target_type` deja explícito el tipo para badges.
  const assignments = await db('visit_plan_assignments as vpa')
    .where({ visit_plan_id: id })
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .leftJoin('users as v', 'v.id', 'vpa.visitor_user_id')
    .select(
      'vpa.*',
      'mc.cpadre',
      db.raw('COALESCE(mc.farmacia_nombre, pp.name) AS farmacia_nombre'),
      // Prospectos NO tienen pareto formal — los marcamos como 'C' (regla negocio).
      db.raw("COALESCE(mc.pareto, pp.pareto, CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'C' ELSE NULL END) AS pareto"),
      db.raw('COALESCE(mc.delegacion_municipio, pp.municipality) AS delegacion_municipio'),
      db.raw("CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'prospect' ELSE 'client' END AS target_type"),
      'v.full_name as visitor_name',
      'v.role as visitor_role',
    )
    .orderBy('vpa.scheduled_date')
    .orderBy('vpa.route_order');
  return { ...plan, assignments };
}

/**
 * Full preview: runs the full driving-aware planGenerator without persisting.
 * Returns plan + assignments (with ETAs and polylines) + metrics so the Plan
 * Editor UI can render polylines on the map and let the manager iterate
 * before committing.
 */
async function previewFull({ ownerUserId, scopeUserIds, granularity = 'weekly', periodStart, periodEnd, paretoFilter, branchId, name, routeStartHHMM, actorIsGlobal = false }) {
  return planGenerator.previewGenerate({
    ownerUserId,
    scopeUserIds,
    granularity,
    periodStart,
    periodEnd,
    paretoFilter,
    branchId,
    name,
    routeStartHHMM,
    actorIsGlobal,
  });
}

/**
 * Move a single stop from its current assignee to a different rep WITHOUT
 * re-running the whole plan generation. Used by the drag-and-drop UX in the
 * Plan Editor. Re-sequences both source and destination reps' day so ETAs
 * stay accurate, and returns the deltas for the UI to animate.
 */
async function reassignStop({ planId, assignmentId, newVisitorUserId, actorId, isGlobal, force = false }) {
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  // Drag-drop is allowed on draft AND published plans (Fase B verification:
  // gerente_ventas reassigning a stop on a published plan and the rep seeing
  // it on /my-route). Archived plans are immutable.
  if (plan.status === 'archived') {
    const err = new Error('Cannot edit an archived plan');
    err.status = 409;
    throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId) {
    const err = new Error('Only owner can edit plan');
    err.status = 403;
    throw err;
  }

  const target = await db('visit_plan_assignments').where({ id: assignmentId, visit_plan_id: planId }).first();
  if (!target) {
    const err = new Error('Assignment not found in this plan');
    err.status = 404;
    throw err;
  }
  const oldVisitorId = target.visitor_user_id;
  if (oldVisitorId === newVisitorUserId) return { changed: false };

  const newUser = await db('users').where({ id: newVisitorUserId, is_active: true }).first();
  if (!newUser) {
    const err = new Error('Target user not found or inactive');
    err.status = 404;
    throw err;
  }

  // Cap pre-flight (PLAN_ENABLE_CAP_VALIDATION). When forced (force=true) we skip
  // the check but stamp metrics.balance.over_cap_count for observability.
  if (ENABLE_CAP_VALIDATION_REASSIGN && !force) {
    const cap = newUser.daily_minutes_cap || 480;
    const cur = await currentMinutesByRep(planId, newVisitorUserId, target.scheduled_date);
    const projected = cur.totalMin
      + Number(target.expected_service_minutes || 45)
      + Number(target.expected_travel_minutes || 30);
    if (projected > cap) {
      const alternatives = await findReassignAlternatives({
        planId, scheduledDate: target.scheduled_date, assignmentId,
        excludeUserId: newVisitorUserId,
      });
      const err = new Error('Reassign would exceed daily cap of target rep');
      err.status = 409;
      err.code = 'cap_exceeded';
      err.payload = {
        code: 'cap_exceeded',
        rep: {
          id: newUser.id, full_name: newUser.full_name,
          cap_minutes: cap,
          current_minutes: cur.totalMin,
          projected_minutes: projected,
        },
        alternatives,
      };
      throw err;
    }
  }

  await db.transaction(async (trx) => {
    await trx('visit_plan_assignments')
      .where({ id: assignmentId })
      .update({
        visitor_user_id: newVisitorUserId,
        // Force resequencing by clearing route_order; the helper below will
        // restamp both reps' days for that scheduled_date.
        route_order: 9999,
        polyline_to_next: null,
      });

    // Re-sequence each affected (rep, day).
    for (const visitorId of [oldVisitorId, newVisitorUserId]) {
      await resequenceUserDay(trx, planId, visitorId, target.scheduled_date);
    }
  });

  return {
    changed: true, source: oldVisitorId, destination: newVisitorUserId,
    forced: force === true,
  };
}

/**
 * Intraday reoptimization wrapper. Validates auth + plan status, runs the
 * reoptimizer in a transaction, writes audit row, returns diff for UI.
 */
async function reoptimizeDay({
  planId, date, brokenUserId, urgentStop, capExceedUserId, triggerKind,
  actorId, isGlobal,
}) {
  if (!planId || !date) {
    const err = new Error('planId and date are required');
    err.status = 400; throw err;
  }
  if (!triggerKind) {
    const err = new Error('trigger_kind is required (rep_breakdown|urgent_insert|cap_exceed|manual)');
    err.status = 400; throw err;
  }
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404; throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId) {
    const err = new Error('Only owner can reoptimize');
    err.status = 403; throw err;
  }
  if (plan.status !== 'published') {
    const err = new Error(`Plan must be published (current status: ${plan.status})`);
    err.status = 409; throw err;
  }

  return db.transaction(async (trx) => {
    const result = await intradayReoptimizer.reoptimize({
      planId, date,
      brokenUserId: brokenUserId || null,
      urgentStop: urgentStop || null,
      capExceedUserId: capExceedUserId || null,
      triggerKind, triggeredBy: actorId, trx,
    });

    if (!result.ok) {
      const err = new Error(result.error || 'reoptimize_failed');
      err.status = 422; err.code = result.error;
      throw err;
    }

    // Persist audit row.
    const [audit] = await trx('visit_plan_reoptimizations').insert({
      visit_plan_id: planId,
      scheduled_date: date,
      triggered_by: actorId,
      trigger_kind: triggerKind,
      payload: JSON.stringify({
        broken_user_id: brokenUserId || null,
        urgent_stop: urgentStop || null,
        cap_exceed_user_id: capExceedUserId || null,
      }),
      affected_assignment_ids: result.affectedIds,
      locked_count: result.summary.locked_hard + result.summary.locked_soft,
      released_count: result.summary.released_after_breakdown,
      ms_elapsed: result.summary.ms_elapsed,
      outcome: result.summary.no_capacity > 0 ? 'partial' : 'success',
    }).returning('id');

    // Stamp last_reopt_id on touched rows.
    if (result.affectedIds.length) {
      await trx('visit_plan_assignments')
        .whereIn('id', result.affectedIds)
        .update({ last_reopt_id: audit.id, reopt_lock_kind: null });
    }

    return {
      ok: true,
      audit_id: audit.id,
      summary: result.summary,
      diff: result.diff,
      moves: result.moves,
      urgent_assignment_id: result.urgentAssignmentId,
    };
  });
}

async function listReoptimizations(planId, { actorId, isGlobal }) {
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404; throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId
    && plan.scope_user_id !== actorId
    && (!plan.scope_user_id || !await canActorManage(actorId, plan.scope_user_id))) {
    const err = new Error('Forbidden');
    err.status = 403; throw err;
  }
  return db('visit_plan_reoptimizations as vpr')
    .where({ visit_plan_id: planId })
    .leftJoin('users as u', 'u.id', 'vpr.triggered_by')
    .select(
      'vpr.*',
      'u.full_name as triggered_by_name',
    )
    .orderBy('vpr.created_at', 'desc');
}

/**
 * Recompute route_order + ETAs for a single (rep, day) using the cached
 * driving-time matrix (NN + 2-opt). Polylines are pulled from cache when
 * available — we DO NOT call computeRoute per arc here because this runs on
 * every drag-drop and would burn the daily Routes API budget.
 *
 * On publish-time (planGenerator.generate), the polylines do get materialized
 * via computeRoute — that's when the user has committed to spending money.
 */
async function resequenceUserDay(trx, planId, visitorUserId, scheduledDate) {
  const routesMatrix = require('../../services/routesMatrix');
  const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');
  const { localDayHHMMToUTC } = require('../../utils/timezone');
  const multiStartSolver = require('../../utils/multiStart');

  const SOLVER_STRATEGY = process.env.PLAN_SOLVER || 'legacy';
  const SOLVER_DEADLINE_MS = Number(process.env.PLAN_SOLVER_DEADLINE_MS) || 450;

  const u = await trx('users')
    .select('id', 'home_lat', 'home_lng', 'service_minutes_per_stop')
    .where({ id: visitorUserId })
    .first();
  if (!u) return;

  const rows = await trx('visit_plan_assignments as vpa')
    .where({ visit_plan_id: planId, visitor_user_id: visitorUserId, scheduled_date: scheduledDate })
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.id',
      trx.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      trx.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    );
  const stops = rows.filter((r) => r.lat != null && r.lng != null).map((r) => ({
    id: r.id, lat: Number(r.lat), lng: Number(r.lng),
  }));
  if (!stops.length) return;

  const home = (u.home_lat != null && u.home_lng != null)
    ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
    : null;
  const serviceMinutes = u.service_minutes_per_stop || 45;

  let ordered = stops;
  let durationsMatrix = null;
  if (home && stops.length >= 2) {
    const points = [home, ...stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
    try {
      const matrix = await routesMatrix.computeMatrixCached(points, points, { preference: 'TRAFFIC_UNAWARE' });
      durationsMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
      for (const r of matrix) durationsMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
      stops.forEach((s, i) => { s.__seqIdx = i + 1; });
      const depotMarker = { __seqIdx: 0, lat: home.lat, lng: home.lng, __depot: true };
      const costFn = (a, b) => durationsMatrix[a.__seqIdx ?? 0][b.__seqIdx ?? 0];
      const solverResult = multiStartSolver.solve({
        depot: depotMarker, stops, costFn,
        repId: visitorUserId, dayIso: scheduledDate,
        deadline: Date.now() + SOLVER_DEADLINE_MS,
        strategy: SOLVER_STRATEGY,
      });
      ordered = solverResult.ordered.map((s) => stops.find((x) => x.__seqIdx === s.__seqIdx)).filter(Boolean);
    } catch (err) {
      console.warn(`[resequenceUserDay] matrix failed: ${err.message}`);
    }
  }

  // Use the matrix duration only — no computeRoute per arc.
  // Cambio 4 — when PLAN_OPEN_ROUTE_BUDGET ON, the first stop arrives EXACTLY
  // at routeStartHHMM. Reps without home naturally also get open-route timing
  // when PLAN_HOMELESS_OPEN_ROUTE is ON.
  const ENABLE_OPEN_ROUTE_BUDGET = process.env.PLAN_OPEN_ROUTE_BUDGET === 'true';
  const ENABLE_HOMELESS_OPEN_ROUTE = process.env.PLAN_HOMELESS_OPEN_ROUTE === 'true';
  const openRouteSeq = ENABLE_OPEN_ROUTE_BUDGET || (ENABLE_HOMELESS_OPEN_ROUTE && !home);

  let cursor = localDayHHMMToUTC(scheduledDate, '08:00');
  let prevSeqIdx = 0;
  let routeOrder = 1;
  for (let idx = 0; idx < ordered.length; idx += 1) {
    const s = ordered[idx];
    const isFirstStop = (idx === 0);
    let travelSeconds = 0;
    if (durationsMatrix && s.__seqIdx != null) {
      const ms = durationsMatrix[prevSeqIdx][s.__seqIdx];
      if (Number.isFinite(ms)) travelSeconds = ms;
    }
    const travelMinutes = Math.round(travelSeconds / 60);
    const skipFirstLeg = openRouteSeq && isFirstStop;
    if (!skipFirstLeg) {
      cursor = new Date(cursor.getTime() + travelSeconds * 1000);
    }
    const arrival = new Date(cursor);
    cursor = new Date(cursor.getTime() + serviceMinutes * 60 * 1000);

    await trx('visit_plan_assignments').where({ id: s.id }).update({
      route_order: routeOrder,
      expected_arrival_time: arrival,
      expected_start_time: arrival,
      expected_travel_minutes: travelMinutes,
      expected_service_minutes: serviceMinutes,
      // Clear polyline_to_next; will be repopulated next time the plan is
      // materialized via generate() or via an explicit re-publish.
      polyline_to_next: null,
    });
    prevSeqIdx = s.__seqIdx ?? 0;
    routeOrder += 1;
  }
}

async function preview({ ownerUserId: _ownerUserId, scopeUserIds, periodStart, periodEnd, paretoFilter }) {
  // Lightweight preview: same target resolution as generate, but no inserts.
  const trx = db;
  const scopeUsers = await trx('users')
    .select('id', 'role', 'full_name', 'branch_id')
    .whereIn('id', scopeUserIds)
    .andWhere({ is_active: true });

  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  let workingDays = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const d = cursor.getUTCDay();
    if (d !== 0 && d !== 6) workingDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const targetsByUser = {};
  let totalDailyVisits = 0;
  const firstDay = periodStart;
  for (const u of scopeUsers) {
    targetsByUser[u.id] = {};
    for (const pareto of (paretoFilter || ['A', 'B', 'C'])) {
      const r = await trx.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
        u.id, pareto, 'visit', firstDay,
      ]);
      const v = r.rows?.[0]?.v ?? 0;
      targetsByUser[u.id][pareto] = v;
      totalDailyVisits += v;
    }
  }
  return {
    working_days: workingDays,
    estimated_total_visits: totalDailyVisits * workingDays,
    daily_visits_total: totalDailyVisits,
    per_user: targetsByUser,
  };
}

async function publish(id, userId) {
  const result = await db.transaction(async (trx) => {
    const plan = await trx('visit_plans').where({ id }).first();
    if (!plan) {
      const err = new Error('Plan not found');
      err.status = 404; throw err;
    }
    if (plan.owner_user_id !== userId) {
      const err = new Error('Only owner can publish');
      err.status = 403; throw err;
    }
    if (plan.status === 'archived') {
      const err = new Error('Cannot publish an archived plan');
      err.status = 409; throw err;
    }
    // Serialize publishes against the same scope+period — a concurrent publish
    // of two drafts must not leave both in 'published'. Same lock key as
    // planGenerator.generate so generate-then-publish stays serialized too.
    if (plan.scope_hash) {
      const lockKey = require('crypto')
        .createHash('md5')
        .update(`${plan.scope_hash}|${plan.period_start instanceof Date ? plan.period_start.toISOString().slice(0, 10) : plan.period_start}|${plan.period_end instanceof Date ? plan.period_end.toISOString().slice(0, 10) : plan.period_end}`)
        .digest();
      const lockBig = lockKey.readBigInt64BE(0);
      await trx.raw('SELECT pg_advisory_xact_lock(?::bigint)', [lockBig.toString()]);
    }
    // Atomically archive any other non-archived plan with the same scope+period.
    // Without this, listAssignmentsForUser and the alerts engine would scan
    // multiple "published" plans for the same rep+day and double-count.
    if (plan.scope_hash) {
      await trx('visit_plans')
        .where({ scope_hash: plan.scope_hash, period_start: plan.period_start, period_end: plan.period_end })
        .whereNot({ id })
        .whereNull('archived_at')
        .whereIn('status', ['draft', 'published'])
        .update({ status: 'archived', archived_at: trx.fn.now(), updated_at: trx.fn.now() });
    }
    const [updated] = await trx('visit_plans').where({ id }).update({
      status: 'published',
      updated_at: trx.fn.now(),
    }).returning('*');

    // Detect partial-period conflicts with other still-published plans for the
    // same scope (e.g. publishing a weekly while a monthly is active). Records
    // alerts AND auto-rescheduled the colliding monthly assignments inside the
    // weekly's window to preserve the "1 plan vigente por rep+día" invariant.
    let conflictResult = { alerts: [], rescheduled_count: 0 };
    try {
      const conflictDetector = require('./conflictDetector');
      conflictResult = await conflictDetector.detectAndRecordConflicts(trx, updated);
    } catch (cdErr) {
      // Don't break publish if conflict detection fails — log & move on.
      // We surface the failure in the response so the manager knows the
      // alerts table wasn't updated.
      conflictResult.error = cdErr.message;
    }

    // Per-rep SSE notification: list distinct visitors + their stop counts so
    // the rep's UI can show "Te asignaron N paradas para HOY" and refresh.
    const audience = await trx('visit_plan_assignments')
      .where({ visit_plan_id: id })
      .select('visitor_user_id')
      .count({ stops: '*' })
      .min({ first_day: 'scheduled_date' })
      .max({ last_day: 'scheduled_date' })
      .groupBy('visitor_user_id');

    return { updated, audience, conflicts: conflictResult };
  });

  // Emit AFTER the transaction commits so subscribers see a row that actually
  // exists. Best-effort: a bus publish failure must not break the publish call.
  const liveBus = require('../live/live.service');
  for (const row of result.audience) {
    try {
      await liveBus.publish({
        type: 'plan_published',
        audienceUserId: row.visitor_user_id,
        payload: {
          plan_id: id,
          plan_name: result.updated.name || null,
          period_start: result.updated.period_start instanceof Date
            ? result.updated.period_start.toISOString().slice(0, 10)
            : String(result.updated.period_start || '').slice(0, 10),
          period_end: result.updated.period_end instanceof Date
            ? result.updated.period_end.toISOString().slice(0, 10)
            : String(result.updated.period_end || '').slice(0, 10),
          first_day: row.first_day instanceof Date
            ? row.first_day.toISOString().slice(0, 10)
            : String(row.first_day || '').slice(0, 10),
          last_day: row.last_day instanceof Date
            ? row.last_day.toISOString().slice(0, 10)
            : String(row.last_day || '').slice(0, 10),
          stops: Number(row.stops) || 0,
        },
      });
    } catch (err) {
      console.warn(`[visitPlans.publish] live publish failed for ${row.visitor_user_id}: ${err.message}`);
    }
  }

  // Emit plan_superseded for any plan auto-archived by partial conflict so
  // the rep frontend invalidates its cached plan_id mappings.
  if (result.conflicts?.alerts?.length) {
    for (const alert of result.conflicts.alerts) {
      try {
        await liveBus.publish({
          type: 'plan_superseded',
          audienceUserId: null, // broadcast — TODO filter to affected reps when team scoping lands
          payload: {
            new_plan_id: id,
            conflicting_plan_id: alert.conflicting_plan_id,
            conflict_type: alert.conflict_type,
            affected_period_start: alert.affected_period_start,
            affected_period_end: alert.affected_period_end,
          },
        });
      } catch (_) { /* best-effort */ }
    }
  }

  // Attach conflict summary so the UI can show "N alerts created" toast.
  return Object.assign({}, result.updated, { _conflicts: result.conflicts });
}

async function archive(id, userId) {
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (plan.owner_user_id !== userId) {
    const err = new Error('Only owner can archive');
    err.status = 403;
    throw err;
  }
  const [updated] = await db('visit_plans').where({ id }).update({
    status: 'archived',
    updated_at: db.fn.now(),
  }).returning('*');
  return updated;
}

async function listAssignmentsForUser({ visitorUserId, dateFrom, dateTo }) {
  // Cada assignment puede venir de:
  //   (A) cliente Marzam   → vpa.marzam_client_id → mc → mc.pharmacy_id → p (geo)
  //   (B) prospecto         → vpa.pharmacy_id → pp directo (geo)
  // El COALESCE colapsa ambos casos en una sola fila plana para el FE.
  // pharmacy_id se devuelve como `geo_pharmacy_id` para no chocar con la
  // columna real `vpa.pharmacy_id` (que el SELECT * arrastra).
  const q = db('visit_plan_assignments as vpa')
    .where('vpa.visitor_user_id', visitorUserId)
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p',  'p.id',  'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.*',
      'mc.cpadre',
      db.raw('COALESCE(mc.farmacia_nombre, pp.name) AS farmacia_nombre'),
      db.raw("COALESCE(mc.pareto, pp.pareto, CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'C' ELSE NULL END) AS pareto"),
      db.raw('COALESCE(mc.delegacion_municipio, pp.municipality) AS delegacion_municipio'),
      'mc.poblacion',
      db.raw("CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'prospect' ELSE 'client' END AS target_type"),
      db.raw('COALESCE(p.id, pp.id) AS geo_pharmacy_id'),
      db.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      db.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    )
    .orderBy('vpa.scheduled_date')
    .orderBy('vpa.route_order');
  if (dateFrom) q.andWhere('vpa.scheduled_date', '>=', dateFrom);
  if (dateTo) q.andWhere('vpa.scheduled_date', '<=', dateTo);
  return q;
}

// Marzam Execution Doc §6.2/§6.3 — hard schedule:
//   - Reps must explicitly start a stop. We stamp `actual_start_time` here and
//     also surface it for the alerts engine (route_not_started_by_X).
//   - Deviations (skipping out of order, abandoning a stop) require a reason.
async function startAssignment({ assignmentId, actorId, isGlobal }) {
  const row = await db('visit_plan_assignments').where({ id: assignmentId }).first();
  if (!row) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }
  // Only the assigned visitor (or a manager / admin) may start.
  if (!isGlobal && row.visitor_user_id !== actorId && !await canActorManage(actorId, row.visitor_user_id)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  if (row.actual_start_time) return row; // idempotent

  const [updated] = await db('visit_plan_assignments')
    .where({ id: assignmentId })
    .update({ actual_start_time: db.fn.now() })
    .returning('*');
  return updated;
}

async function deviateAssignment({ assignmentId, actorId, isGlobal, reason }) {
  if (!reason || !String(reason).trim()) {
    const err = new Error('deviation_reason is required');
    err.status = 422;
    err.code = 'deviation_reason_required';
    throw err;
  }
  const row = await db('visit_plan_assignments').where({ id: assignmentId }).first();
  if (!row) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }
  if (!isGlobal && row.visitor_user_id !== actorId && !await canActorManage(actorId, row.visitor_user_id)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  const [updated] = await db('visit_plan_assignments')
    .where({ id: assignmentId })
    .update({
      deviation_reason: String(reason).trim(),
      deviated_at: db.fn.now(),
      status: 'skipped',
    })
    .returning('*');
  return updated;
}

/**
 * Post-mortem: per-rep and per-plan stats comparing planned vs executed.
 *
 * Computes for each rep in the plan:
 *   - assignments_planned, assignments_done, assignments_skipped
 *   - first_actual_start, last_actual_start (stamped at /assignments/:id/start)
 *   - estimated_total_minutes (sum of expected_travel + expected_service)
 *   - actual_visits_count (joined from visits table by rep + scheduled_date)
 *   - alerts_fired (count from alerts where subject = rep, period overlap)
 *   - completion_pct, on_time_pct
 */
async function postMortem(planId, { actorId, isGlobal }) {
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId
    && plan.scope_user_id !== actorId
    && (!plan.scope_user_id || !await canActorManage(actorId, plan.scope_user_id))) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }

  // Per-rep aggregates: assignment status counts, expected vs actual minutes,
  // on_time_pct (arrival within 15 min of expected), alerts fired, actual
  // visits count (rows in visit_reports / visits in the window).
  const rows = await db('visit_plan_assignments as vpa')
    .where({ visit_plan_id: planId })
    .leftJoin('users as v', 'v.id', 'vpa.visitor_user_id')
    .select(
      'vpa.visitor_user_id',
      'v.full_name as visitor_name',
      'v.role as visitor_role',
      db.raw('COUNT(*)::int AS assignments_planned'),
      db.raw("SUM(CASE WHEN vpa.status='done' THEN 1 ELSE 0 END)::int AS assignments_done"),
      db.raw("SUM(CASE WHEN vpa.status IN ('skipped','deviated') THEN 1 ELSE 0 END)::int AS assignments_skipped"),
      db.raw('SUM(COALESCE(vpa.expected_travel_minutes,0))::int AS estimated_drive_minutes'),
      db.raw('SUM(COALESCE(vpa.expected_service_minutes,0))::int AS estimated_service_minutes'),
      db.raw('MIN(vpa.actual_start_time) AS first_actual_start'),
      db.raw('MAX(vpa.actual_start_time) AS last_actual_start'),
      db.raw(`
        SUM(CASE
          WHEN vpa.actual_start_time IS NOT NULL
           AND vpa.expected_start_time IS NOT NULL
           AND vpa.actual_start_time <= vpa.expected_start_time + INTERVAL '15 minutes'
          THEN 1 ELSE 0 END
        )::int AS on_time_count
      `),
      db.raw(`
        SUM(CASE WHEN vpa.actual_start_time IS NOT NULL THEN 1 ELSE 0 END)::int AS started_count
      `),
    )
    .groupBy('vpa.visitor_user_id', 'v.full_name', 'v.role');

  // Actual visits + alerts by rep within the plan period.
  const repIds = rows.map((r) => r.visitor_user_id);
  let visitsByRep = new Map();
  let alertsByRep = new Map();
  if (repIds.length) {
    // visit_reports: optional table — guard with information_schema check.
    try {
      const v = await db('visit_reports as vr')
        .whereIn('vr.rep_id', repIds)
        .andWhere('vr.visited_at', '>=', plan.period_start)
        .andWhere('vr.visited_at', '<=', `${plan.period_end} 23:59:59`)
        .select('vr.rep_id', db.raw('COUNT(*)::int AS n'))
        .groupBy('vr.rep_id');
      for (const r of v) visitsByRep.set(r.rep_id, r.n);
    } catch (err) {
      console.warn(`[postMortem] visit_reports lookup skipped: ${err.message}`);
    }
    try {
      const a = await db('alerts')
        .whereIn('subject_user_id', repIds)
        .andWhere('created_at', '>=', plan.period_start)
        .andWhere('created_at', '<=', `${plan.period_end} 23:59:59`)
        .select('subject_user_id', db.raw('COUNT(*)::int AS n'))
        .groupBy('subject_user_id');
      for (const r of a) alertsByRep.set(r.subject_user_id, r.n);
    } catch (err) {
      console.warn(`[postMortem] alerts lookup skipped: ${err.message}`);
    }
  }

  const enriched = rows.map((r) => {
    const actualVisits = visitsByRep.get(r.visitor_user_id) || 0;
    const alertsFired = alertsByRep.get(r.visitor_user_id) || 0;
    return {
      ...r,
      actual_visits_count: actualVisits,
      alerts_fired: alertsFired,
      completion_pct: r.assignments_planned ? +(r.assignments_done / r.assignments_planned * 100).toFixed(1) : 0,
      on_time_pct: r.started_count ? +(r.on_time_count / r.started_count * 100).toFixed(1) : 0,
    };
  });

  const totals = enriched.reduce((acc, r) => {
    acc.planned += r.assignments_planned;
    acc.done += r.assignments_done;
    acc.skipped += r.assignments_skipped;
    acc.actual_visits += r.actual_visits_count;
    acc.alerts_fired += r.alerts_fired;
    acc.estimated_minutes += (r.estimated_drive_minutes || 0) + (r.estimated_service_minutes || 0);
    acc.on_time_count += r.on_time_count;
    acc.started_count += r.started_count;
    return acc;
  }, { planned: 0, done: 0, skipped: 0, actual_visits: 0, alerts_fired: 0, estimated_minutes: 0, on_time_count: 0, started_count: 0 });

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      status: plan.status,
      period_start: plan.period_start,
      period_end: plan.period_end,
      metrics: plan.metrics,
    },
    totals: {
      ...totals,
      completion_pct: totals.planned ? +(totals.done / totals.planned * 100).toFixed(1) : 0,
      on_time_pct: totals.started_count ? +(totals.on_time_count / totals.started_count * 100).toFixed(1) : 0,
    },
    per_rep: enriched,
  };
}

/**
 * Public wrapper around resequenceUserDay that handles auth + multi-day +
 * polyline materialization for a single rep (used by the Plan Editor's
 * "Recalcular ruta de este rep" button).
 */
async function resequenceUser({ planId, visitorUserId, actorId, isGlobal }) {
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found'); err.status = 404; throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId) {
    const err = new Error('Only owner can resequence'); err.status = 403; throw err;
  }
  if (plan.status === 'archived') {
    const err = new Error('Cannot edit archived plan'); err.status = 409; throw err;
  }
  // Get distinct scheduled_dates this rep has in this plan.
  const dates = await db('visit_plan_assignments')
    .where({ visit_plan_id: planId, visitor_user_id: visitorUserId })
    .distinct('scheduled_date')
    .pluck('scheduled_date');
  if (!dates.length) return { resequenced_days: 0 };
  await db.transaction(async (trx) => {
    for (const d of dates) {
      await resequenceUserDay(trx, planId, visitorUserId, d);
    }
  });
  return { resequenced_days: dates.length };
}

/**
 * Cost estimator — wraps planGenerator.estimateCost and includes a budget
 * remaining check. Used by the Plan Editor before "Generar" / "Publicar".
 */
async function estimateCost(args) {
  const planGenerator = require('./planGenerator');
  const routesMatrix = require('../../services/routesMatrix');
  const result = await planGenerator.estimateCost(args);
  const budget = await routesMatrix.getDailyBudgetStatus();
  return {
    ...result,
    budget,
    can_afford: result.est_cost_usd <= budget.remaining_usd,
  };
}

/**
 * Cambio 1 — National estimate without spending Google Routes API.
 *
 * Runs the greedy assignment + Haversine-based time/km estimates, groups by
 * Entidad Federativa (= `marzam_clients.poblacion`, the user-facing label that
 * already drives the plan-editor's "Entidad federativa" filter), and returns a
 * per-EF breakdown plus a recommendation on which EF to start with.
 *
 * Cache-first behavior: if `route_matrix_cache` has hits for relevant geohash7
 * pairs, those are used (more accurate); otherwise Haversine×1.4 fallback.
 * Never calls Google Routes API — `no_google_calls: true` in the response.
 *
 * Manager-Marzam friendly: USD redacted in controller (only blackprint_admin
 * sees est_cost_usd; everyone else sees matrix_elements + recommendation).
 */
async function previewNationalEstimate({
  ownerUserId, scopeUserIds, periodStart, periodEnd, paretoFilter, actorIsGlobal = false,
}) {
  const planGenerator = require('./planGenerator');
  // Run the SAME assignment phase as estimateCost (no Google, just greedy + Haversine).
  const costResult = await planGenerator.estimateCost({
    ownerUserId,
    scopeUserIds,
    granularity: 'weekly',
    periodStart,
    periodEnd,
    paretoFilter,
    actorIsGlobal,
  });
  const plan = costResult.plan || {};
  // Pull the assignmentRows that were used to count matrix elements. We need
  // them joined with marzam_clients.poblacion / pharmacies.municipality so we
  // can group by EF.
  // The plan draft from estimateCost doesn't include assignmentRows directly;
  // we re-run a lightweight query joining the unassigned/assigned info.
  // Simpler path: re-call buildPlan with mode='preview' to get assignmentRows.
  const buildArgs = {
    ownerUserId,
    scopeUserIds,
    granularity: 'weekly',
    periodStart,
    periodEnd,
    paretoFilter,
    actorIsGlobal,
  };
  const { planDraft, assignmentRows } = await planGenerator.buildPlan(buildArgs, db, 'preview');

  // Hydrate each row with its EF (poblacion) via a single batch query.
  const clientIds = [...new Set(assignmentRows.map((r) => r.marzam_client_id).filter(Boolean))];
  const pharmacyIds = [...new Set(assignmentRows.map((r) => r.pharmacy_id).filter(Boolean))];
  const clientEFMap = new Map();
  if (clientIds.length) {
    const rows = await db('marzam_clients').whereIn('id', clientIds).select('id', 'poblacion');
    for (const r of rows) clientEFMap.set(r.id, r.poblacion || 'Sin clasificar');
  }
  const pharmacyEFMap = new Map();
  if (pharmacyIds.length) {
    const rows = await db('pharmacies').whereIn('id', pharmacyIds).select('id', 'state', 'municipality');
    for (const r of rows) {
      // For prospects, prefer state; fall back to municipality.
      pharmacyEFMap.set(r.id, r.state || r.municipality || 'Sin clasificar');
    }
  }

  // Aggregate stops + minutes + km per EF, plus distinct reps that captured candidates there.
  const byEF = new Map();
  const HAVERSINE = (a, b) => {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat); const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  // Walk per (rep, day) so inter-stop Haversine is meaningful.
  const groupKey = (r) => `${r.visitor_user_id}|${r.scheduled_date}`;
  const byRepDay = new Map();
  for (const r of assignmentRows) {
    if (!byRepDay.has(groupKey(r))) byRepDay.set(groupKey(r), []);
    byRepDay.get(groupKey(r)).push(r);
  }
  for (const [, stops] of byRepDay) {
    stops.sort((a, b) => a.route_order - b.route_order);
    let prev = null;
    for (const s of stops) {
      const ef = s.marzam_client_id
        ? (clientEFMap.get(s.marzam_client_id) || 'Sin clasificar')
        : (pharmacyEFMap.get(s.pharmacy_id) || 'Sin clasificar');
      if (!byEF.has(ef)) byEF.set(ef, { stops: 0, est_minutes: 0, est_km: 0, reps: new Set() });
      const bucket = byEF.get(ef);
      bucket.stops += 1;
      bucket.reps.add(s.visitor_user_id);
      // Service time (default 45 min) — always counted.
      bucket.est_minutes += s.expected_service_minutes || 45;
      // Inter-stop travel (Haversine × 1.4 / 22 km/h).
      if (prev && s.lat != null && s.lng != null && prev.lat != null && prev.lng != null) {
        const km = HAVERSINE(prev, s) * 1.4;
        bucket.est_km += km;
        bucket.est_minutes += Math.round((km / 22) * 60);
      }
      prev = s;
    }
  }

  // Build response.
  const efOut = {};
  let totalStops = 0;
  let totalMinutes = 0;
  let totalKm = 0;
  const efRanking = [];
  for (const [ef, bucket] of byEF) {
    efOut[ef] = {
      stops: bucket.stops,
      est_minutes: bucket.est_minutes,
      est_km: Math.round(bucket.est_km * 10) / 10,
      reps_capable: bucket.reps.size,
    };
    totalStops += bucket.stops;
    totalMinutes += bucket.est_minutes;
    totalKm += bucket.est_km;
    efRanking.push({ ef, stops: bucket.stops, reps: bucket.reps.size });
  }
  efRanking.sort((a, b) => b.stops - a.stops);
  const topEF = efRanking[0];
  const recommendation = topEF
    ? `Sugerencia: genera el plan EF por EF. Empieza por "${topEF.ef}" (${topEF.stops} farmacias, ${topEF.reps} rep${topEF.reps === 1 ? '' : 's'} disponible${topEF.reps === 1 ? '' : 's'}).`
    : 'No hay farmacias para asignar en el periodo seleccionado.';

  // Unassignable: total candidates that didn't make it into the greedy phase.
  const unassignedCount = (planDraft?.config?.unassigned || []).length;

  return {
    by_ef: efOut,
    totals: {
      stops: totalStops,
      est_minutes: totalMinutes,
      est_km: Math.round(totalKm * 10) / 10,
      reps_in_scope: scopeUserIds.length,
    },
    recommendation,
    unassignable_count: unassignedCount,
    no_google_calls: true,
    cost_estimate_usd: costResult.est_cost_usd, // redacted for non-bp-admin in controller
    matrix_elements: costResult.matrix_elements,
    period: { start: periodStart, end: periodEnd },
  };
}

/**
 * Replay polyline + breadcrumbs for a single (rep, day) within a plan.
 * Drives the time scrubber in the Post-mortem view.
 */
async function replayRepDay(planId, repId, day, { actorId, isGlobal }) {
  // Authorization: same rules as postMortem.
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (!isGlobal && plan.owner_user_id !== actorId && repId !== actorId
    && !await canActorManage(actorId, repId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }

  const stops = await db('visit_plan_assignments as vpa')
    .where({ visit_plan_id: planId, visitor_user_id: repId, scheduled_date: day })
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.id', 'vpa.route_order', 'vpa.status',
      'vpa.expected_arrival_time', 'vpa.actual_start_time',
      'vpa.polyline_to_next',
      db.raw('COALESCE(mc.farmacia_nombre, pp.name) AS name'),
      db.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      db.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    )
    .orderBy('vpa.route_order');

  const breadcrumbs = await db('rep_tracking_points')
    .where({ rep_id: repId })
    .andWhere('recorded_at', '>=', `${day}T00:00:00Z`)
    .andWhere('recorded_at', '<', `${day}T23:59:59Z`)
    .orderBy('recorded_at')
    .select('lat', 'lng', 'recorded_at')
    .limit(5000);

  return {
    plan_id: planId,
    rep_id: repId,
    day,
    stops,
    breadcrumbs,
  };
}

/**
 * Routing sandbox — no DB reads or writes.
 *
 * Accepts users (with home depots) and stops (already assigned per user)
 * directly in the request body. Runs the full routing pipeline:
 *   computeMatrixCached → NN-from-depot → 2-opt → computeRoute per arc
 *   → caution-polygon penalty → ETAs.
 *
 * Returns routes with polylines + a cost breakdown so callers (including
 * demo mode) can evaluate Google API quality and billing before committing
 * to a real plan generation.
 *
 * @param {{
 *   users: Array<{id:string, home_lat:number, home_lng:number, service_minutes_per_stop?:number}>,
 *   stops: Array<{id:string, user_id:string, lat:number, lng:number, name?:string, pareto?:string, type?:string}>,
 *   date: string,  // ISO date e.g. "2026-05-07"
 *   service_minutes_per_stop?: number
 * }} args
 */
async function routePreview({ users, stops, date, service_minutes_per_stop: defaultService = 45 }) {
  if (!Array.isArray(users) || !users.length) throw Object.assign(new Error('users[] required'), { status: 400 });
  if (!Array.isArray(stops)) throw Object.assign(new Error('stops[] required'), { status: 400 });
  if (!date) throw Object.assign(new Error('date required (ISO format)'), { status: 400 });

  const ROUTE_START = '08:00';
  const [hh, mm] = ROUTE_START.split(':').map(Number);

  function haversineKm(a, b) {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Cost tracking: only 'fresh' elements are billed by Google.
  const cost = { matrixTotal: 0, fresh: 0, cached: 0, estimated: 0, routeCalls: 0 };
  const routes = [];

  for (const user of users) {
    const userStops = stops
      .filter((s) => s.user_id === user.id && s.lat != null && s.lng != null)
      .map((s) => ({ ...s, lat: Number(s.lat), lng: Number(s.lng) }));
    if (!userStops.length) continue;

    const home = (user.home_lat != null && user.home_lng != null)
      ? { lat: Number(user.home_lat), lng: Number(user.home_lng) }
      : null;
    const serviceMin = user.service_minutes_per_stop || defaultService;

    let ordered = userStops;

    if (home && userStops.length >= 2) {
      const points = [home, ...userStops.map((s) => ({ lat: s.lat, lng: s.lng }))];
      cost.matrixTotal += points.length * points.length;

      let durMatrix = null;
      try {
        const matrix = await routesMatrix.computeMatrixCached(points, points, { preference: 'TRAFFIC_UNAWARE' });
        for (const r of matrix) {
          if (r.flag === 'fresh') cost.fresh++;
          else if (r.flag === 'cached') cost.cached++;
          else cost.estimated++;
        }
        durMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
        for (const r of matrix) durMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
      } catch (err) {
        console.warn(`[routePreview] matrix failed user ${user.id}: ${err.message}`);
      }

      if (durMatrix) {
        userStops.forEach((s, i) => { s.__seqIdx = i + 1; });
        const depot = { __seqIdx: 0, lat: home.lat, lng: home.lng };
        const costFn = (a, b) => durMatrix[a.__seqIdx ?? 0][b.__seqIdx ?? 0];
        const nn = orderStopsFromDepot(depot, userStops, costFn);
        const opt = twoOptImprove([depot, ...nn], costFn);
        ordered = opt.slice(1).map((s) => userStops.find((x) => x.__seqIdx === s.__seqIdx)).filter(Boolean);
      } else {
        ordered = orderStopsFromDepot(home, userStops, (a, b) => haversineKm(a, b));
      }
    }

    let cursor = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
    let prevPoint = home;
    let routeOrder = 1;
    let totalDriveMin = 0;
    const routeStops = [];

    for (const s of ordered) {
      const stopPoint = { lat: s.lat, lng: s.lng };
      let travelSeconds = 0;
      let polyline = null;
      let usedRealRoute = false;

      if (prevPoint) {
        try {
          const route = await routesMatrix.computeRoute(prevPoint, stopPoint, { preference: 'TRAFFIC_UNAWARE' });
          cost.routeCalls++;
          usedRealRoute = true;
          if (route) {
            travelSeconds = route.durationSeconds;
            polyline = route.polyline;
            if (polyline) {
              const caution = await securityPolygons.polylineIntersectsCaution(polyline);
              if (caution) travelSeconds = Math.round(travelSeconds * securityPolygons.CAUTION_PENALTY);
              routesMatrix.persistPolyline(prevPoint, stopPoint, polyline).catch(() => {});
            }
          }
        } catch { /* intentional fallthrough */ }

        if (!travelSeconds) {
          const km = haversineKm(prevPoint, stopPoint) * 1.4;
          travelSeconds = Math.round((km / 22) * 3600);
        }
      }

      const travelMin = Math.round(travelSeconds / 60);
      cursor = new Date(cursor.getTime() + travelSeconds * 1000);
      const arrival = new Date(cursor);
      cursor = new Date(cursor.getTime() + serviceMin * 60 * 1000);

      routeStops.push({
        id: s.id,
        name: s.name || null,
        lat: s.lat,
        lng: s.lng,
        pareto: s.pareto || null,
        type: s.type || 'stop',
        route_order: routeOrder,
        expected_arrival_iso: arrival.toISOString(),
        travel_minutes: travelMin,
        service_minutes: serviceMin,
        polyline_to_next: null,       // filled in next iteration
        used_real_route: usedRealRoute,
      });
      if (routeStops.length > 1) {
        routeStops[routeStops.length - 2].polyline_to_next = polyline;
      }

      totalDriveMin += travelMin;
      prevPoint = stopPoint;
      routeOrder++;
    }

    routes.push({
      user_id: user.id,
      stops: routeStops,
      total_drive_minutes: totalDriveMin,
      total_service_minutes: serviceMin * routeStops.length,
      total_minutes: totalDriveMin + serviceMin * routeStops.length,
    });
  }

  // Only 'fresh' matrix elements + route calls are billed.
  const billedElements = cost.fresh + cost.routeCalls;
  const estimatedUsd = Math.round((billedElements / 1000) * 5 * 10000) / 10000;

  return {
    routes,
    cost_estimate: {
      matrix_elements_total: cost.matrixTotal,
      matrix_fresh: cost.fresh,
      matrix_cached: cost.cached,
      matrix_estimated_fallback: cost.estimated,
      route_calls: cost.routeCalls,
      billed_elements: billedElements,
      estimated_usd: estimatedUsd,
      note: 'TRAFFIC_UNAWARE Essentials = $5 / 1,000 elements. Cached elements are free.',
    },
  };
}

module.exports = {
  generate: planGenerator.generate,
  preview,
  previewFull,
  routePreview,
  reassignStop,
  resequenceUser,
  estimateCost,
  previewNationalEstimate,
  listForUser,
  getById,
  publish,
  archive,
  listAssignmentsForUser,
  startAssignment,
  deviateAssignment,
  postMortem,
  replayRepDay,
  reoptimizeDay,
  listReoptimizations,
  findReassignAlternatives,
  getRemainingPlanQuota,
  __computeQuotaResult: computeQuotaResult, // exported for tests
};
