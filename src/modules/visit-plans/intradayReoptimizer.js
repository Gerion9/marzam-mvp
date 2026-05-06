/**
 * Intraday reoptimizer for a published plan's single day.
 *
 * Lock kinds (see migration 075):
 *   'hard'     — assignment.status IN ('done','in_progress'). Never moved.
 *   'soft'     — next 1-2 'planned' stops per rep. Stay with their rep but may
 *                be re-sequenced internally. Manager doesn't see surprise moves.
 *   'released' — everything else. Free to redistribute.
 *
 * Triggers (see plan-editor emergency drawer):
 *   - 'rep_breakdown' { broken_user_id }
 *       All 'released' stops of broken_user_id are freed to other reps' pools.
 *   - 'urgent_insert' { pharmacy_id?|marzam_client_id?, preferred_user_id?, after_assignment_id? }
 *       Inserts a new assignment, classifies as 'released', re-distributes.
 *   - 'cap_exceed' { user_id }
 *       Releases the tail of user_id's day until they fall under cap.
 *   - 'manual'
 *       Caller-driven payload. Used for retroactive corrections.
 *
 * Output: { ok, summary, diff, audit_id }
 *
 * IMPORTANT: scope_hash and the unique-published-plan invariant are preserved.
 * This module never INSERTS / UPDATES `visit_plans`. It only mutates
 * `visit_plan_assignments` rows of the day and writes one audit row to
 * `visit_plan_reoptimizations`.
 */

const routesMatrix = require('../../services/routesMatrix');
const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');
const { localDayHHMMToUTC } = require('../../utils/timezone');

const DEFAULT_DAILY_MINUTES_CAP = 480;
const DEFAULT_TRAVEL_MINUTES_CAP = 360;
const DEFAULT_SERVICE_MINUTES = 45;
const SOFT_LOCK_NEXT_N = 2;     // próximas N stops planned se preservan en su rep

function haversineKm(a, b) {
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
 * Load assignments + rep + stop coordinates for one (plan, date).
 */
async function loadDay(trx, planId, date) {
  const rows = await trx('visit_plan_assignments as vpa')
    .where({ 'vpa.visit_plan_id': planId, 'vpa.scheduled_date': date })
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.id', 'vpa.visitor_user_id', 'vpa.route_order', 'vpa.status',
      'vpa.expected_arrival_time', 'vpa.expected_travel_minutes',
      'vpa.expected_service_minutes', 'vpa.actual_start_time',
      'vpa.marzam_client_id', 'vpa.pharmacy_id',
      trx.raw('COALESCE(mc.farmacia_nombre, pp.name) AS farmacia_nombre'),
      trx.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      trx.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    )
    .orderBy('vpa.visitor_user_id')
    .orderBy('vpa.route_order');
  return rows;
}

/**
 * Load active reps relevant to the day. We pull every distinct visitor_user_id
 * already in the day plus, optionally, the preferred_user_id for urgent_insert.
 */
async function loadReps(trx, userIds) {
  if (!userIds.length) return [];
  // Defensive: 068 columns may not exist yet (travel_minutes_cap, daily_km_cap).
  const has068 = await trx.schema.hasColumn('users', 'travel_minutes_cap').catch(() => false);
  const cols = ['id', 'role', 'full_name',
    'home_lat', 'home_lng', 'daily_minutes_cap', 'service_minutes_per_stop'];
  if (has068) cols.push('travel_minutes_cap', 'daily_km_cap');
  const rows = await trx('users')
    .select(...cols)
    .whereIn('id', userIds)
    .andWhere({ is_active: true });
  return rows.map((u) => ({
    ...u,
    daily_minutes_cap: u.daily_minutes_cap || DEFAULT_DAILY_MINUTES_CAP,
    travel_minutes_cap: u.travel_minutes_cap != null ? Number(u.travel_minutes_cap) : DEFAULT_TRAVEL_MINUTES_CAP,
    service_minutes_per_stop: u.service_minutes_per_stop || DEFAULT_SERVICE_MINUTES,
  }));
}

/**
 * Classify each row by lock kind. Stamps an in-memory __lock field.
 *
 * For each rep: walk in route_order. Hard-lock done/in_progress. Soft-lock
 * the first SOFT_LOCK_NEXT_N planned. Release the rest.
 */
function classifyLocks(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.visitor_user_id)) byUser.set(r.visitor_user_id, []);
    byUser.get(r.visitor_user_id).push(r);
  }
  const stats = { hard: 0, soft: 0, released: 0 };
  for (const list of byUser.values()) {
    list.sort((a, b) => a.route_order - b.route_order);
    let softLeft = SOFT_LOCK_NEXT_N;
    for (const r of list) {
      if (r.status === 'done' || r.status === 'in_progress' || r.actual_start_time) {
        r.__lock = 'hard'; stats.hard += 1;
      } else if (r.status === 'planned' && softLeft > 0) {
        r.__lock = 'soft'; stats.soft += 1; softLeft -= 1;
      } else {
        r.__lock = 'released'; stats.released += 1;
      }
    }
  }
  return { byUser, stats };
}

/**
 * Compute current minutes used by a rep that day given hard+soft locks.
 * Released stops are excluded — those are about to be moved.
 */
function lockedMinutesByRep(byUser) {
  const out = new Map();
  for (const [uid, list] of byUser.entries()) {
    let totalMin = 0;
    let travelMin = 0;
    for (const r of list) {
      if (r.__lock === 'released') continue;
      const t = Number(r.expected_travel_minutes) || 0;
      const s = Number(r.expected_service_minutes) || DEFAULT_SERVICE_MINUTES;
      totalMin += t + s;
      travelMin += t;
    }
    out.set(uid, { totalMin, travelMin });
  }
  return out;
}

/**
 * Pick the best rep for a given released stop. Score:
 *   score = headroom_minutes * 0.6 + (1 / distance_km) * 0.4
 * with veto when projected total exceeds cap.
 */
function pickBestRep(stop, candidateReps, lockedByRep) {
  const stopPoint = { lat: Number(stop.lat), lng: Number(stop.lng) };
  let best = null;
  for (const u of candidateReps) {
    if (!u.home_lat || !u.home_lng) continue;
    const home = { lat: Number(u.home_lat), lng: Number(u.home_lng) };
    const locked = lockedByRep.get(u.id) || { totalMin: 0, travelMin: 0 };
    const projectedHeadroom = u.daily_minutes_cap - locked.totalMin - u.service_minutes_per_stop;
    if (projectedHeadroom < u.service_minutes_per_stop) continue;  // basic veto
    const distKm = haversineKm(home, stopPoint);
    const score = projectedHeadroom * 0.6 + (1 / Math.max(distKm, 0.5)) * 4;  // 0.4*10 weight
    if (!best || score > best.score) best = { user: u, score, distKm, projectedHeadroom };
  }
  return best;
}

/**
 * Fetch driving matrix for one (rep, day) home + stops. Returns durationsMatrix
 * indexed [0=depot, 1..N=stops]. Falls back to null on error.
 */
async function fetchMatrix(home, stops) {
  if (!home || stops.length < 1) return null;
  const points = [home, ...stops.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
  try {
    const matrix = await routesMatrix.computeMatrixCached(points, points, { preference: 'TRAFFIC_UNAWARE' });
    const m = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
    for (const r of matrix) m[r.originIndex][r.destinationIndex] = r.durationSeconds;
    return m;
  } catch {
    return null;
  }
}

/**
 * Re-sequence a rep's day given new stop list. Updates DB in trx.
 */
async function resequenceRep(trx, planId, repId, date, rep, stops, dayStartHHMM = '08:00') {
  if (!stops.length) return;
  const home = (rep.home_lat != null && rep.home_lng != null)
    ? { lat: Number(rep.home_lat), lng: Number(rep.home_lng) }
    : null;
  let ordered = stops.slice();
  let durationsMatrix = null;
  if (home && stops.length >= 2) {
    durationsMatrix = await fetchMatrix(home, stops);
    if (durationsMatrix) {
      stops.forEach((s, i) => { s.__seqIdx = i + 1; });
      const depot = { __seqIdx: 0, lat: home.lat, lng: home.lng };
      const costFn = (a, b) => durationsMatrix[a.__seqIdx ?? 0][b.__seqIdx ?? 0];
      const nn = orderStopsFromDepot(depot, stops, costFn);
      const opt = twoOptImprove([depot, ...nn], costFn);
      ordered = opt.slice(1).map((s) => stops.find((x) => x.__seqIdx === s.__seqIdx)).filter(Boolean);
    }
  }

  let cursor = localDayHHMMToUTC(date, dayStartHHMM);
  let prevSeqIdx = 0;
  let routeOrder = 1;
  const serviceMin = rep.service_minutes_per_stop || DEFAULT_SERVICE_MINUTES;

  for (const s of ordered) {
    let travelSeconds = 0;
    if (durationsMatrix && s.__seqIdx != null) {
      const ms = durationsMatrix[prevSeqIdx][s.__seqIdx];
      if (Number.isFinite(ms)) travelSeconds = ms;
    }
    const travelMinutes = Math.round(travelSeconds / 60);
    cursor = new Date(cursor.getTime() + travelSeconds * 1000);
    const arrival = new Date(cursor);
    cursor = new Date(cursor.getTime() + serviceMin * 60 * 1000);
    await trx('visit_plan_assignments').where({ id: s.id }).update({
      route_order: routeOrder,
      expected_arrival_time: arrival,
      expected_start_time: arrival,
      expected_travel_minutes: travelMinutes,
      expected_service_minutes: serviceMin,
      polyline_to_next: null,
    });
    prevSeqIdx = s.__seqIdx ?? 0;
    routeOrder += 1;
  }
}

/**
 * Capture per-row "before" snapshot for diff output.
 */
function snapshotRow(r) {
  return {
    visitor_user_id: r.visitor_user_id,
    route_order: r.route_order,
    expected_arrival_time: r.expected_arrival_time,
    expected_travel_minutes: r.expected_travel_minutes,
    expected_service_minutes: r.expected_service_minutes,
  };
}

async function reoptimize({
  planId, date, brokenUserId = null, urgentStop = null, capExceedUserId = null,
  triggerKind, triggeredBy, trx,
}) {
  const startedAt = Date.now();

  // Step 1: load day and classify locks.
  const rows = await loadDay(trx, planId, date);
  if (!rows.length) {
    return { ok: false, error: 'no_assignments_for_day' };
  }
  // Snapshot "before" state for diff.
  const beforeMap = new Map(rows.map((r) => [r.id, snapshotRow(r)]));

  const { byUser, stats } = classifyLocks(rows);

  // Step 2: handle trigger-specific releases.
  if (triggerKind === 'rep_breakdown' && brokenUserId) {
    const list = byUser.get(brokenUserId) || [];
    for (const r of list) {
      if (r.__lock !== 'hard') {
        r.__lock = 'released';
        r.__forceReassign = true;     // must NOT stay with brokenUserId
      }
    }
  }

  if (triggerKind === 'cap_exceed' && capExceedUserId) {
    // Already handled by classification — released tail.
    // No-op for now; future: also penalize headroom of capExceedUserId.
  }

  // Step 3: pool of stops to (re)place.
  const releasedStops = [];
  for (const list of byUser.values()) {
    for (const r of list) {
      if (r.__lock === 'released' && r.lat != null && r.lng != null) {
        releasedStops.push(r);
      }
    }
  }

  // Step 4: handle urgent_insert. Insert a new assignment row with status=planned,
  // urgent_inserted_at stamp, and add it to the released pool.
  let urgentInserted = null;
  if (triggerKind === 'urgent_insert' && urgentStop) {
    const isProspect = !!urgentStop.pharmacy_id;
    let coords = null;
    let name = null;
    if (urgentStop.pharmacy_id) {
      const p = await trx('pharmacies').where({ id: urgentStop.pharmacy_id })
        .select('id', 'name', trx.raw('ST_X(coordinates::geometry) AS lng'), trx.raw('ST_Y(coordinates::geometry) AS lat'))
        .first();
      if (!p) throw Object.assign(new Error('pharmacy_id not found'), { status: 404 });
      coords = { lat: Number(p.lat), lng: Number(p.lng) };
      name = p.name;
    } else if (urgentStop.marzam_client_id) {
      const mc = await trx('marzam_clients as mc')
        .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
        .where('mc.id', urgentStop.marzam_client_id)
        .select('mc.id', 'mc.farmacia_nombre',
          trx.raw('ST_X(p.coordinates::geometry) AS lng'),
          trx.raw('ST_Y(p.coordinates::geometry) AS lat'))
        .first();
      if (!mc) throw Object.assign(new Error('marzam_client_id not found'), { status: 404 });
      if (mc.lat == null || mc.lng == null) {
        throw Object.assign(new Error('marzam_client_id has no geo coordinates'), { status: 422 });
      }
      coords = { lat: Number(mc.lat), lng: Number(mc.lng) };
      name = mc.farmacia_nombre;
    } else {
      throw Object.assign(new Error('urgent_stop requires pharmacy_id or marzam_client_id'), { status: 400 });
    }

    const [inserted] = await trx('visit_plan_assignments').insert({
      visit_plan_id: planId,
      visitor_user_id: urgentStop.preferred_user_id || rows[0].visitor_user_id, // temp; reassigned below
      marzam_client_id: isProspect ? null : urgentStop.marzam_client_id,
      pharmacy_id: isProspect ? urgentStop.pharmacy_id : null,
      scheduled_date: date,
      route_order: 9999,
      channel: 'visit',
      status: 'planned',
      expected_service_minutes: DEFAULT_SERVICE_MINUTES,
      urgent_inserted_at: trx.fn.now(),
      reopt_lock_kind: 'released',
    }).returning('*');

    urgentInserted = {
      ...inserted,
      lat: coords.lat,
      lng: coords.lng,
      farmacia_nombre: name,
      __lock: 'released',
      __forceReassign: !!urgentStop.preferred_user_id ? false : true,
    };
    releasedStops.push(urgentInserted);
  }

  // Step 5: candidate reps (active + has home). Exclude broken rep.
  const allRepIds = [...new Set(rows.map((r) => r.visitor_user_id))];
  if (urgentInserted && urgentInserted.visitor_user_id && !allRepIds.includes(urgentInserted.visitor_user_id)) {
    allRepIds.push(urgentInserted.visitor_user_id);
  }
  const reps = await loadReps(trx, allRepIds);
  const activeReps = reps.filter((u) => u.id !== brokenUserId);

  // Step 6: greedy reassignment of released stops.
  const lockedByRep = lockedMinutesByRep(byUser);
  // Track minutes additions per rep as we add stops (mutated copy).
  const projectedAdditions = new Map();
  for (const u of activeReps) projectedAdditions.set(u.id, 0);

  const moves = [];   // { stop, fromUserId, toUserId }
  for (const stop of releasedStops) {
    // Sort released processing by distance to centroid of all reps' homes
    // (heuristic: handle outermost stops first).
    if (stop.__forceReassign === false && stop.visitor_user_id) {
      // urgent with preferred_user_id: keep as-is if rep has headroom.
      const u = activeReps.find((x) => x.id === stop.visitor_user_id);
      if (u) {
        const headroom = u.daily_minutes_cap - (lockedByRep.get(u.id)?.totalMin || 0) - (projectedAdditions.get(u.id) || 0);
        if (headroom >= u.service_minutes_per_stop) {
          projectedAdditions.set(u.id, (projectedAdditions.get(u.id) || 0) + u.service_minutes_per_stop + 20);
          continue;
        }
      }
    }
    // Apply projected additions when picking.
    const repsWithProjected = activeReps.map((u) => ({
      ...u,
      daily_minutes_cap: u.daily_minutes_cap - (projectedAdditions.get(u.id) || 0),
    }));
    const pick = pickBestRep(stop, repsWithProjected, lockedByRep);
    if (!pick) {
      // No rep with capacity. Mark unassigned (status='deviated' with reason).
      await trx('visit_plan_assignments').where({ id: stop.id }).update({
        status: 'deviated',
        deviation_reason: 'reopt_no_capacity',
        deviated_at: trx.fn.now(),
        reopt_lock_kind: 'released',
      });
      moves.push({ stop_id: stop.id, fromUserId: stop.visitor_user_id, toUserId: null, reason: 'no_capacity' });
      continue;
    }
    const newRepId = pick.user.id;
    if (newRepId !== stop.visitor_user_id) {
      moves.push({ stop_id: stop.id, fromUserId: stop.visitor_user_id, toUserId: newRepId });
      stop.visitor_user_id = newRepId;
    }
    projectedAdditions.set(newRepId, (projectedAdditions.get(newRepId) || 0) + pick.user.service_minutes_per_stop + 20);
  }

  // Step 7: persist visitor_user_id changes for moved stops.
  for (const m of moves) {
    if (m.toUserId) {
      await trx('visit_plan_assignments').where({ id: m.stop_id }).update({
        visitor_user_id: m.toUserId,
        route_order: 9999,
        polyline_to_next: null,
        reopt_lock_kind: 'released',
      });
    }
  }

  // Step 8: re-sequence each rep that gained stops or had releases (active reps only).
  const repsToResequence = new Set();
  for (const m of moves) {
    if (m.toUserId) repsToResequence.add(m.toUserId);
    if (m.fromUserId && m.fromUserId !== brokenUserId) repsToResequence.add(m.fromUserId);
  }
  for (const list of byUser.values()) {
    for (const r of list) if (r.__lock === 'released') repsToResequence.add(r.visitor_user_id);
  }
  repsToResequence.delete(brokenUserId);

  for (const repId of repsToResequence) {
    const rep = reps.find((u) => u.id === repId);
    if (!rep) continue;
    const repStops = await trx('visit_plan_assignments as vpa')
      .where({ 'vpa.visit_plan_id': planId, 'vpa.visitor_user_id': repId, 'vpa.scheduled_date': date })
      .whereNot('vpa.status', 'deviated')
      .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
      .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
      .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
      .select(
        'vpa.id',
        trx.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
        trx.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
      );
    const stopsForResequence = repStops.filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, lat: Number(s.lat), lng: Number(s.lng) }));
    await resequenceRep(trx, planId, repId, date, rep, stopsForResequence);
  }

  // Step 9: gather "after" snapshot for diff.
  const afterRows = await trx('visit_plan_assignments')
    .where({ visit_plan_id: planId, scheduled_date: date })
    .select('id', 'visitor_user_id', 'route_order', 'expected_arrival_time',
      'expected_travel_minutes', 'expected_service_minutes', 'status');
  const diff = [];
  for (const a of afterRows) {
    const before = beforeMap.get(a.id);
    if (!before) {
      diff.push({ assignment_id: a.id, was: null, now: a, kind: 'inserted' });
      continue;
    }
    const changed = (
      before.visitor_user_id !== a.visitor_user_id
      || before.route_order !== a.route_order
      || (before.expected_arrival_time?.getTime?.() ?? null) !== (a.expected_arrival_time?.getTime?.() ?? null)
    );
    if (changed) diff.push({ assignment_id: a.id, was: before, now: a, kind: 'modified' });
  }

  // Step 10: stamp last_reopt_id on touched rows AFTER inserting the audit row,
  // and clear reopt_lock_kind back to NULL (transient state).
  const affectedIds = diff.map((d) => d.assignment_id);
  const summary = {
    locked_hard: stats.hard,
    locked_soft: stats.soft,
    released_initial: stats.released,
    released_after_breakdown: releasedStops.length,
    moved: moves.filter((m) => m.toUserId).length,
    no_capacity: moves.filter((m) => !m.toUserId).length,
    resequenced_reps: repsToResequence.size,
    ms_elapsed: Date.now() - startedAt,
  };

  return {
    ok: true,
    summary,
    diff,
    affectedIds,
    moves,
    urgentAssignmentId: urgentInserted ? urgentInserted.id : null,
  };
}

module.exports = { reoptimize, SOFT_LOCK_NEXT_N };
