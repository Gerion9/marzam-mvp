const db = require('../../config/database');
const planGenerator = require('./planGenerator');
const { canActorManage } = require('../../services/teamScope');
const routesMatrix = require('../../services/routesMatrix');
const securityPolygons = require('../../services/securityPolygons');
const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');

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
async function previewFull({ ownerUserId, scopeUserIds, granularity = 'weekly', periodStart, periodEnd, paretoFilter, branchId, name, routeStartHHMM }) {
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
  });
}

/**
 * Move a single stop from its current assignee to a different rep WITHOUT
 * re-running the whole plan generation. Used by the drag-and-drop UX in the
 * Plan Editor. Re-sequences both source and destination reps' day so ETAs
 * stay accurate, and returns the deltas for the UI to animate.
 */
async function reassignStop({ planId, assignmentId, newVisitorUserId, actorId, isGlobal }) {
  const plan = await db('visit_plans').where({ id: planId }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (plan.status !== 'draft') {
    const err = new Error('Only draft plans can be edited');
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

  return { changed: true, source: oldVisitorId, destination: newVisitorUserId };
}

/**
 * Recompute route_order + ETAs for a single (rep, day) without touching other
 * users or other days. Used by reassignStop and by manual reorder endpoints.
 */
async function resequenceUserDay(trx, planId, visitorUserId, scheduledDate) {
  const routesMatrix = require('../../services/routesMatrix');
  const securityPolygons = require('../../services/securityPolygons');
  const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');

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
  if (home && stops.length >= 2) {
    const points = [home, ...stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
    try {
      const matrix = await routesMatrix.computeMatrixCached(points, points, { preference: 'TRAFFIC_UNAWARE' });
      const dur = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
      for (const r of matrix) dur[r.originIndex][r.destinationIndex] = r.durationSeconds;
      stops.forEach((s, i) => { s.__seqIdx = i + 1; });
      const depotMarker = { __seqIdx: 0, lat: home.lat, lng: home.lng, __depot: true };
      const costFn = (a, b) => dur[a.__seqIdx ?? 0][b.__seqIdx ?? 0];
      const nn = orderStopsFromDepot(depotMarker, stops, costFn);
      const opt = twoOptImprove([depotMarker, ...nn], costFn);
      ordered = opt.slice(1).map((s) => stops.find((x) => x.__seqIdx === s.__seqIdx));
    } catch (err) {
      console.warn(`[resequenceUserDay] matrix failed: ${err.message}`);
    }
  }

  // Compute per-arc travel + polylines, write back.
  let cursor = new Date(`${scheduledDate}T08:00:00.000Z`);
  let prev = home;
  let routeOrder = 1;
  for (let idx = 0; idx < ordered.length; idx += 1) {
    const s = ordered[idx];
    const stopPoint = { lat: s.lat, lng: s.lng };
    let travelSeconds = 0;
    let polyline = null;
    if (prev) {
      try {
        const route = await routesMatrix.computeRoute(prev, stopPoint);
        if (route) {
          travelSeconds = route.durationSeconds;
          polyline = route.polyline;
          if (polyline && await securityPolygons.polylineIntersectsCaution(polyline)) {
            travelSeconds = Math.round(travelSeconds * securityPolygons.CAUTION_PENALTY);
          }
        }
      } catch (err) {
        console.warn(`[resequenceUserDay] route failed: ${err.message}`);
      }
    }
    const travelMinutes = Math.round(travelSeconds / 60);
    cursor = new Date(cursor.getTime() + travelSeconds * 1000);
    const arrival = new Date(cursor);
    cursor = new Date(cursor.getTime() + serviceMinutes * 60 * 1000);

    await trx('visit_plan_assignments').where({ id: s.id }).update({
      route_order: routeOrder,
      expected_arrival_time: arrival,
      expected_start_time: arrival,
      expected_travel_minutes: travelMinutes,
      expected_service_minutes: serviceMinutes,
    });
    if (idx > 0) {
      // Update previous row's polyline_to_next to this arc's polyline.
      await trx('visit_plan_assignments').where({ id: ordered[idx - 1].id }).update({
        polyline_to_next: polyline,
      });
    }
    prev = stopPoint;
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
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (plan.owner_user_id !== userId) {
    const err = new Error('Only owner can publish');
    err.status = 403;
    throw err;
  }
  const [updated] = await db('visit_plans').where({ id }).update({
    status: 'published',
    updated_at: db.fn.now(),
  }).returning('*');
  return updated;
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

  const rows = await db('visit_plan_assignments as vpa')
    .where({ visit_plan_id: planId })
    .leftJoin('users as v', 'v.id', 'vpa.visitor_user_id')
    .select(
      'vpa.visitor_user_id',
      'v.full_name as visitor_name',
      'v.role as visitor_role',
      db.raw('COUNT(*)::int AS assignments_planned'),
      db.raw("SUM(CASE WHEN vpa.status='done' THEN 1 ELSE 0 END)::int AS assignments_done"),
      db.raw("SUM(CASE WHEN vpa.status='skipped' THEN 1 ELSE 0 END)::int AS assignments_skipped"),
      db.raw('SUM(COALESCE(vpa.expected_travel_minutes,0))::int AS estimated_drive_minutes'),
      db.raw('SUM(COALESCE(vpa.expected_service_minutes,0))::int AS estimated_service_minutes'),
      db.raw('MIN(vpa.actual_start_time) AS first_actual_start'),
      db.raw('MAX(vpa.actual_start_time) AS last_actual_start'),
    )
    .groupBy('vpa.visitor_user_id', 'v.full_name', 'v.role');

  const totals = rows.reduce((acc, r) => {
    acc.planned += r.assignments_planned;
    acc.done += r.assignments_done;
    acc.skipped += r.assignments_skipped;
    acc.estimated_minutes += (r.estimated_drive_minutes || 0) + (r.estimated_service_minutes || 0);
    return acc;
  }, { planned: 0, done: 0, skipped: 0, estimated_minutes: 0 });

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
    },
    per_rep: rows.map((r) => ({
      ...r,
      completion_pct: r.assignments_planned ? +(r.assignments_done / r.assignments_planned * 100).toFixed(1) : 0,
    })),
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
        } catch (_err) { /* intentional fallthrough */ }

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
  listForUser,
  getById,
  publish,
  archive,
  listAssignmentsForUser,
  startAssignment,
  deviateAssignment,
  postMortem,
  replayRepDay,
};
