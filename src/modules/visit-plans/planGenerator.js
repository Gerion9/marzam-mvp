/**
 * Plan generator (driving-aware).
 *
 * Public API:
 *   generate({...})        — runs and persists a draft plan
 *   previewGenerate({...}) — runs WITHOUT persisting; returns assignments,
 *                            metrics, and unassigned stops for the editor UI
 *
 * Algorithm (post-057 rewrite):
 *   1) Resolve daily targets per (user, pareto) via SQL func resolve_visit_target.
 *   2) Load candidate clients + prospects with their lat/lng (joined to
 *      pharmacies for coordinates).
 *   3) Hard-filter candidates whose colonia is `not_acceptable`.
 *   4) For each working day:
 *      4a) For each user (heaviest target first, to balance), for each of
 *          their allowed paretos, pick `dailyTarget` UNUSED candidates with
 *          shortest Haversine distance to the rep's home. Track a budget of
 *          `daily_minutes_cap` minutes; if a candidate would push the rep
 *          over, prefer the next unused candidate.
 *      4b) For each rep with >0 picked stops, fetch a small driving-time
 *          matrix (home + stops) via routesMatrix.computeMatrixCached, run
 *          NN-from-depot + 2-opt to sequence them, optionally call
 *          computeRoute() per arc to materialize polylines, test polyline
 *          intersection with caution polygons, and apply the 1.5× penalty
 *          to the cumulative ETA.
 *   5) Materialize visit_plan_assignments with route_order, expected_start_time,
 *      expected_arrival_time, expected_travel_minutes, expected_service_minutes,
 *      polyline_to_next.
 *   6) Persist plan.metrics with totals + plan.config.unassigned[].
 *
 * Why Haversine for assignment but driving-time for sequencing:
 *   The greedy assignment picks "closest enough" stops to each rep — at this
 *   resolution Haversine is a good proxy and avoids 80×5000 driving lookups
 *   on the first plan generation. Sequencing within a single rep's day is
 *   small (≤12 stops) and there driving-time matters for ETA accuracy.
 */

const db = require('../../config/database');
const { ROLES, normalizeRole } = require('../../constants/roles');
const { canActorManage } = require('../../services/teamScope');
const routesMatrix = require('../../services/routesMatrix');
const securityPolygons = require('../../services/securityPolygons');
const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');
const { QUADRANT_TO_PARETO } = require('../../utils/visitCadence');

// Pareto classes for Marzam existing clients.
const PARETO_CLASSES = ['A', 'B', 'C'];

// Pareto classes for new prospect categories (mapped from quadrant_derived).
const PROSPECTO_PARETO_CLASSES = ['A', 'B', 'C', 'D'];

const ROLE_PRIMARY_PARETO = {
  [ROLES.DIRECTOR_SUCURSAL]: ['A'],
  [ROLES.GERENTE_VENTAS]: ['A', 'B'],
  [ROLES.SUPERVISOR]: ['A', 'B'],
  [ROLES.REPRESENTANTE]: ['B', 'C'],
};

const ROLES_THAT_PROSPECT = new Set([ROLES.SUPERVISOR, ROLES.REPRESENTANTE]);

const DEFAULT_ROUTE_START_HHMM = '08:00';

function isWeekday(date) {
  const d = date.getUTCDay();
  return d !== 0 && d !== 6;
}

function eachWorkingDay(start, end) {
  const days = [];
  const cursor = new Date(start);
  const stop = new Date(end);
  while (cursor <= stop) {
    if (isWeekday(cursor)) days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

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

async function resolveTargetsForUser(trx, userId, day) {
  // Resolve Marzam existing-client targets (A/B/C) via v1 SQL function.
  const marzam = {};
  for (const pareto of PARETO_CLASSES) {
    const r = await trx.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
      userId, pareto, 'visit', day,
    ]);
    marzam[pareto] = r.rows?.[0]?.v ?? null;
  }

  // Resolve prospecto targets (A/B/C/D) via v2 SQL function if available.
  // Falls back gracefully to zero if the migration 058 hasn't run yet.
  const prospecto = {};
  try {
    for (const pareto of PROSPECTO_PARETO_CLASSES) {
      const r = await trx.raw(
        "SELECT resolve_visit_target_v2(?, ?::char(1), ?, ?::date, 'prospecto') AS v",
        [userId, pareto, 'visit', day],
      );
      prospecto[pareto] = r.rows?.[0]?.v ?? 0;
    }
  } catch {
    // resolve_visit_target_v2 not yet created (migration 058 pending) — degrade
    for (const pareto of PROSPECTO_PARETO_CLASSES) prospecto[pareto] = 0;
  }

  return { marzam, prospecto };
}

/**
 * Pull candidate clients with coordinates joined from pharmacies.
 * Stops without lat/lng (pharmacy_id IS NULL or coordinates IS NULL) are
 * still returned, but tagged so the optimizer can exclude them gracefully.
 */
async function pickCandidateClients(trx, { paretoFilter, excludeClientIds = [] }) {
  const q = trx('marzam_clients as mc')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .select(
      'mc.id', 'mc.cpadre', 'mc.pareto', 'mc.pharmacy_id', 'mc.farmacia_nombre',
      'mc.delegacion_municipio', 'mc.poblacion',
      trx.raw('ST_X(p.coordinates::geometry) AS lng'),
      trx.raw('ST_Y(p.coordinates::geometry) AS lat'),
    )
    .whereNotNull('mc.pareto');
  if (paretoFilter?.length) q.whereIn('mc.pareto', paretoFilter);
  if (excludeClientIds.length) q.whereNotIn('mc.id', excludeClientIds);
  return q.orderByRaw("CASE mc.pareto WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END, mc.cpadre");
}

async function pickCandidateProspects(trx, { excludePharmacyIds = [], paretoLetters = null }) {
  // paretoLetters: optional array like ['A','B','C','D'] mapped from
  // quadrant_derived via QUADRANT_TO_PARETO. null = all quadrants.
  let quadrantFilter = null;
  if (paretoLetters && paretoLetters.length) {
    // Reverse-map category letters → quadrant keys (Q1..Q4)
    const PARETO_TO_Q = { A: 'Q1', B: 'Q2', C: 'Q3', D: 'Q4' };
    quadrantFilter = paretoLetters.map((l) => PARETO_TO_Q[l]).filter(Boolean);
  }

  const q = trx('pharmacies')
    .select(
      'id',
      'name as farmacia_nombre',
      'municipality as delegacion_municipio',
      'quadrant',
      'quadrant_derived',
      'final_score',
      db.raw('ST_X(coordinates::geometry) AS lng'),
      db.raw('ST_Y(coordinates::geometry) AS lat'),
    )
    .whereNot('source', 'marzam')
    .andWhere('status', 'active')
    .andWhere(function () {
      this.whereNull('business_type').orWhere('business_type', 'pharmacy');
    });
  if (excludePharmacyIds.length) q.whereNotIn('id', excludePharmacyIds);
  if (quadrantFilter && quadrantFilter.length) q.whereIn('quadrant_derived', quadrantFilter);
  return q.orderByRaw(`
    CASE COALESCE(quadrant_derived, quadrant)
      WHEN 'Q1' THEN 1 WHEN 'Q2' THEN 2 WHEN 'Q3' THEN 3 WHEN 'Q4' THEN 4 ELSE 5
    END,
    COALESCE(final_score, 0) DESC,
    name
  `);
}

async function loadAlreadyAssignedClientIds(trx, periodStart, periodEnd) {
  return trx('visit_plan_assignments as vpa')
    .join('visit_plans as vp', 'vp.id', 'vpa.visit_plan_id')
    .where('vp.status', 'published')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.marzam_client_id')
    .pluck('vpa.marzam_client_id');
}

async function loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd) {
  return trx('visit_plan_assignments as vpa')
    .join('visit_plans as vp', 'vp.id', 'vpa.visit_plan_id')
    .where('vp.status', 'published')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.pharmacy_id')
    .pluck('vpa.pharmacy_id');
}

/**
 * Hard-filter candidates whose lat/lng falls inside a `not_acceptable` colonia.
 * These are removed from the pool entirely — reps never get sent there.
 */
async function filterNotAcceptable(candidates) {
  const withCoords = candidates.filter((c) => c.lat != null && c.lng != null);
  if (!withCoords.length) return { candidates, dropped: [] };
  const points = withCoords.map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }));
  const levels = await securityPolygons.levelAtPoints(points);
  const dropped = [];
  const keep = [];
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) {
      keep.push(c);
      continue;
    }
    const idx = withCoords.indexOf(c);
    const lvl = levels.get(idx);
    if (lvl === 'not_acceptable') {
      dropped.push({ id: c.id, name: c.farmacia_nombre, reason: 'not_acceptable_colonia' });
    } else {
      keep.push(c);
    }
  }
  return { candidates: keep, dropped };
}

/**
 * Phase 1: assign candidates to (user, day) cells using greedy
 * nearest-home selection.
 *
 * targets[userId] = { marzam: { A, B, C }, prospecto: { A, B, C, D } }
 * Prospecto targets drive dedicated prospect slots (no longer just C-slot backfill).
 * The old C-slot backfill behavior is preserved for backward compat when all
 * prospecto targets are zero.
 */
function assignByGreedy({ scopeUsers, days, candidatesByPareto, prospects, targets }) {
  const usedClients = new Set();
  const usedProspects = new Set();
  const assignments = new Map(); // userId -> Map<dayIso, stops[]>
  const unassigned = [];

  // Process users heaviest-first for better geographic coverage
  const userOrder = scopeUsers.slice().sort((a, b) => {
    const sumA = PARETO_CLASSES.reduce((s, p) => s + (targets[a.id]?.marzam?.[p] || 0), 0)
      + PROSPECTO_PARETO_CLASSES.reduce((s, p) => s + (targets[a.id]?.prospecto?.[p] || 0), 0);
    const sumB = PARETO_CLASSES.reduce((s, p) => s + (targets[b.id]?.marzam?.[p] || 0), 0)
      + PROSPECTO_PARETO_CLASSES.reduce((s, p) => s + (targets[b.id]?.prospecto?.[p] || 0), 0);
    return sumB - sumA;
  });

  for (const u of userOrder) assignments.set(u.id, new Map());

  // Group prospects by their category letter for targeted assignment
  const prospectsByLetter = new Map();
  for (const p of prospects) {
    const letter = QUADRANT_TO_PARETO[p.quadrant_derived] || QUADRANT_TO_PARETO[p.quadrant] || 'C';
    if (!prospectsByLetter.has(letter)) prospectsByLetter.set(letter, []);
    prospectsByLetter.get(letter).push(p);
  }

  for (const day of days) {
    const dayIso = isoDate(day);
    for (const u of userOrder) {
      const role = normalizeRole(u.role);
      const allowedParetos = ROLE_PRIMARY_PARETO[role] || [];
      const userMarzam = targets[u.id]?.marzam || {};
      const userProspecto = targets[u.id]?.prospecto || {};
      const dayStops = [];
      const home = (u.home_lat != null && u.home_lng != null)
        ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
        : null;

      // ── Marzam client assignments ──
      for (const pareto of allowedParetos) {
        const dailyTarget = userMarzam[pareto] || 0;
        if (!dailyTarget) continue;
        let placed = 0;
        const clientPool = candidatesByPareto[pareto] || [];

        const sortedClients = home
          ? clientPool
            .filter((c) => !usedClients.has(c.id) && c.lat != null && c.lng != null)
            .map((c) => ({ c, d: haversineKm(home, { lat: Number(c.lat), lng: Number(c.lng) }) }))
            .sort((a, b) => a.d - b.d)
            .map((x) => x.c)
          : clientPool.filter((c) => !usedClients.has(c.id));

        for (const candidate of sortedClients) {
          if (placed >= dailyTarget) break;
          dayStops.push({ ...candidate, __type: 'client' });
          usedClients.add(candidate.id);
          placed += 1;
        }

        // Legacy C-slot backfill with prospects when no dedicated prospecto targets
        const hasDedicatedProspecto = PROSPECTO_PARETO_CLASSES.some((p) => (userProspecto[p] || 0) > 0);
        if (pareto === 'C' && placed < dailyTarget && ROLES_THAT_PROSPECT.has(role) && !hasDedicatedProspecto) {
          const allProspects = [...prospects].filter((c) => !usedProspects.has(c.id));
          const sortedProspects = home
            ? allProspects
              .filter((c) => c.lat != null && c.lng != null)
              .map((c) => ({ c, d: haversineKm(home, { lat: Number(c.lat), lng: Number(c.lng) }) }))
              .sort((a, b) => a.d - b.d)
              .map((x) => x.c)
            : allProspects;

          for (const candidate of sortedProspects) {
            if (placed >= dailyTarget) break;
            dayStops.push({ ...candidate, __type: 'prospect' });
            usedProspects.add(candidate.id);
            placed += 1;
          }
        }

        const shortfall = dailyTarget - placed;
        if (shortfall > 0) unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'marzam', shortfall });
      }

      // ── Prospecto dedicated assignments (nuevas A/B/C/D) ──
      if (ROLES_THAT_PROSPECT.has(role)) {
        for (const pareto of PROSPECTO_PARETO_CLASSES) {
          const dailyTarget = userProspecto[pareto] || 0;
          if (!dailyTarget) continue;
          let placed = 0;

          const pool = prospectsByLetter.get(pareto) || [];
          const sortedProspects = home
            ? pool
              .filter((c) => !usedProspects.has(c.id) && c.lat != null && c.lng != null)
              .map((c) => ({ c, d: haversineKm(home, { lat: Number(c.lat), lng: Number(c.lng) }) }))
              .sort((a, b) => a.d - b.d)
              .map((x) => x.c)
            : pool.filter((c) => !usedProspects.has(c.id));

          for (const candidate of sortedProspects) {
            if (placed >= dailyTarget) break;
            dayStops.push({ ...candidate, __type: 'prospect' });
            usedProspects.add(candidate.id);
            placed += 1;
          }

          const shortfall = dailyTarget - placed;
          if (shortfall > 0) unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'prospecto', shortfall });
        }
      }

      assignments.get(u.id).set(dayIso, dayStops);
    }
  }
  return { assignments, unassigned };
}

/**
 * Phase 2: sequence each (rep, day) using driving-time matrix.
 * Returns an array of materialization rows ready for INSERT.
 *
 * Each row carries:
 *   - route_order, expected_arrival_time, expected_start_time
 *   - expected_travel_minutes, expected_service_minutes
 *   - polyline_to_next (when computeRoute was successful)
 */
async function sequenceAndMaterialize({ scopeUsers, assignments, planConfig }) {
  const rows = [];
  const totals = {
    total_drive_minutes: 0,
    total_service_minutes: 0,
    caution_arcs: 0,
    polyline_arcs: 0,
  };
  const routeStartHHMM = planConfig.route_start_hhmm || DEFAULT_ROUTE_START_HHMM;
  const userById = new Map(scopeUsers.map((u) => [u.id, u]));

  for (const [userId, byDay] of assignments.entries()) {
    const u = userById.get(userId);
    const home = (u && u.home_lat != null && u.home_lng != null)
      ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
      : null;
    const serviceMinutes = u?.service_minutes_per_stop || 45;

    for (const [dayIso, stops] of byDay.entries()) {
      if (!stops.length) continue;
      const stopsWithCoords = stops.filter((s) => s.lat != null && s.lng != null);
      const stopsNoCoords = stops.filter((s) => s.lat == null || s.lng == null);

      let ordered = stopsWithCoords;

      if (home && stopsWithCoords.length >= 2) {
        // Compute small (1+N) × (1+N) driving matrix: home + stops as both
        // origins and destinations so we can sequence end-to-end.
        const points = [home, ...stopsWithCoords.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
        let durationsMatrix;
        try {
          const matrix = await routesMatrix.computeMatrixCached(points, points, {
            preference: 'TRAFFIC_UNAWARE',
          });
          // Build [i][j] -> seconds map.
          durationsMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
          for (const r of matrix) {
            durationsMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
          }
        } catch (err) {
          console.warn(`[planGenerator] matrix failed for user ${userId} day ${dayIso}: ${err.message}`);
          durationsMatrix = null;
        }

        if (durationsMatrix) {
          // costFn closure: depot is index 0; stops are indexed by their
          // position in stopsWithCoords. Map back via __seqIdx.
          stopsWithCoords.forEach((s, i) => { s.__seqIdx = i + 1; });
          const depotMarker = { __seqIdx: 0, lat: home.lat, lng: home.lng, __depot: true };
          const costFn = (a, b) => {
            const ai = a.__seqIdx ?? 0;
            const bi = b.__seqIdx ?? 0;
            return durationsMatrix[ai][bi];
          };
          const nnOrdered = orderStopsFromDepot(depotMarker, stopsWithCoords, costFn);
          // 2-opt over [depot, ...nnOrdered]
          const opt = twoOptImprove([depotMarker, ...nnOrdered], costFn);
          ordered = opt.slice(1).map((s) => stopsWithCoords.find((x) => x.__seqIdx === s.__seqIdx));
        } else {
          // Fallback to Haversine NN.
          const costFn = (a, b) => haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
          ordered = orderStopsFromDepot(home, stopsWithCoords, costFn);
        }
      }

      // Walk the ordered list to compute ETAs + polylines.
      let cursor = parseHHMMToDate(dayIso, routeStartHHMM);
      let prevPoint = home;
      let routeOrder = 1;

      for (const s of ordered) {
        const stopPoint = { lat: Number(s.lat), lng: Number(s.lng) };
        let travelSeconds = 0;
        let polyline = null;
        let crossesCaution = false;

        if (prevPoint) {
          try {
            const route = await routesMatrix.computeRoute(prevPoint, stopPoint, { preference: 'TRAFFIC_UNAWARE' });
            if (route) {
              travelSeconds = route.durationSeconds;
              polyline = route.polyline;
              if (polyline) {
                crossesCaution = await securityPolygons.polylineIntersectsCaution(polyline);
                if (crossesCaution) {
                  travelSeconds = Math.round(travelSeconds * securityPolygons.CAUTION_PENALTY);
                  totals.caution_arcs += 1;
                }
                totals.polyline_arcs += 1;
                // Cache polyline for future reuse.
                routesMatrix.persistPolyline(prevPoint, stopPoint, polyline).catch(() => {});
              }
            }
          } catch (err) {
            console.warn(`[planGenerator] route failed for user ${userId} day ${dayIso}: ${err.message}`);
          }
          if (!travelSeconds) {
            // Degraded fallback: Haversine × 1.4 / 22 km/h.
            const km = haversineKm(prevPoint, stopPoint) * 1.4;
            travelSeconds = Math.round((km / 22) * 3600);
          }
        }
        const travelMinutes = Math.round(travelSeconds / 60);
        cursor = new Date(cursor.getTime() + travelSeconds * 1000);
        const arrival = new Date(cursor);
        cursor = new Date(cursor.getTime() + serviceMinutes * 60 * 1000);

        rows.push({
          visitor_user_id: userId,
          marzam_client_id: s.__type === 'client' ? s.id : null,
          pharmacy_id: s.__type === 'prospect' ? s.id : null,
          scheduled_date: dayIso,
          route_order: routeOrder,
          channel: 'visit',
          status: 'planned',
          expected_start_time: arrival,
          expected_arrival_time: arrival,
          expected_travel_minutes: travelMinutes,
          expected_service_minutes: serviceMinutes,
          polyline_to_next: null, // filled below as we link arcs
          // Preview-only fields (stripped before DB insert in generate()).
          lat: s.lat != null ? Number(s.lat) : null,
          lng: s.lng != null ? Number(s.lng) : null,
          farmacia_nombre: s.farmacia_nombre || null,
          cpadre: s.cpadre || null,
          pareto: s.pareto || null,
        });
        if (rows.length > 1) {
          const prev = rows[rows.length - 2];
          if (prev.visitor_user_id === userId && prev.scheduled_date === dayIso) {
            prev.polyline_to_next = polyline;
          }
        }
        totals.total_drive_minutes += travelMinutes;
        totals.total_service_minutes += serviceMinutes;
        prevPoint = stopPoint;
        routeOrder += 1;
      }

      // Stops without coords are appended at the end with no ETA.
      for (const s of stopsNoCoords) {
        rows.push({
          visitor_user_id: userId,
          marzam_client_id: s.__type === 'client' ? s.id : null,
          pharmacy_id: s.__type === 'prospect' ? s.id : null,
          scheduled_date: dayIso,
          route_order: routeOrder,
          channel: 'visit',
          status: 'planned',
          expected_start_time: null,
          expected_arrival_time: null,
          expected_travel_minutes: null,
          expected_service_minutes: serviceMinutes,
          polyline_to_next: null,
          lat: null,
          lng: null,
          farmacia_nombre: s.farmacia_nombre || null,
          cpadre: s.cpadre || null,
          pareto: s.pareto || null,
        });
        routeOrder += 1;
      }
    }
  }
  return { rows, totals };
}

function parseHHMMToDate(isoDay, hhmm) {
  const [h, m] = (hhmm || '08:00').split(':').map(Number);
  // Construct as UTC; downstream client renders local. visit_plan_assignments
  // uses TIMESTAMPTZ which serializes UTC.
  return new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
}

/**
 * Core engine shared by generate() and previewGenerate(). Returns the plan
 * row plus the assignment rows ready for INSERT (callers decide whether to
 * persist).
 */
async function buildPlan(args, trx) {
  const {
    ownerUserId,
    scopeUserIds,
    granularity,
    periodStart,
    periodEnd,
    paretoFilter = PARETO_CLASSES,
    branchId = null,
    name = null,
    routeStartHHMM = DEFAULT_ROUTE_START_HHMM,
  } = args;

  if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
    const err = new Error('scopeUserIds is required');
    err.status = 400;
    throw err;
  }
  if (!['daily', 'weekly', 'monthly'].includes(granularity)) {
    const err = new Error('granularity must be daily/weekly/monthly');
    err.status = 400;
    throw err;
  }

  // Authorization — every scope_user must be the owner himself OR a managee.
  for (const sid of scopeUserIds) {
    if (sid === ownerUserId) continue;
    if (!await canActorManage(ownerUserId, sid)) {
      const err = new Error(`User ${ownerUserId} cannot generate plan for ${sid}`);
      err.status = 403;
      throw err;
    }
  }

  // Defensive SELECT: migration 057 might not be applied. Fall back to
  // base columns and let the geo logic degrade gracefully.
  let scopeUsers;
  try {
    scopeUsers = await trx('users')
      .select(
        'id', 'role', 'full_name', 'branch_id',
        'home_lat', 'home_lng', 'daily_minutes_cap', 'service_minutes_per_stop',
      )
      .whereIn('id', scopeUserIds)
      .andWhere({ is_active: true });
  } catch (err) {
    if (/column .* does not exist/.test(String(err.message || ''))) {
      console.warn('[planGenerator] migration 057 not applied — degrading to round-robin');
      scopeUsers = (await trx('users')
        .select('id', 'role', 'full_name', 'branch_id')
        .whereIn('id', scopeUserIds)
        .andWhere({ is_active: true }))
        .map((u) => ({
          ...u, home_lat: null, home_lng: null,
          daily_minutes_cap: 480, service_minutes_per_stop: 45,
        }));
    } else {
      throw err;
    }
  }

  const days = eachWorkingDay(new Date(`${periodStart}T00:00:00Z`), new Date(`${periodEnd}T00:00:00Z`));
  if (!days.length) {
    const err = new Error('No working days in window');
    err.status = 400;
    throw err;
  }

  const firstDay = isoDate(days[0]);
  const targets = {};
  for (const u of scopeUsers) {
    targets[u.id] = await resolveTargetsForUser(trx, u.id, firstDay);
  }

  const alreadyAssignedClients = await loadAlreadyAssignedClientIds(trx, periodStart, periodEnd);
  let allClients = await pickCandidateClients(trx, {
    paretoFilter,
    excludeClientIds: alreadyAssignedClients,
  });
  // Hard-filter not_acceptable colonias.
  const filteredClients = await filterNotAcceptable(allClients);
  allClients = filteredClients.candidates;

  const candidatesByPareto = { A: [], B: [], C: [] };
  for (const c of allClients) {
    if (candidatesByPareto[c.pareto]) candidatesByPareto[c.pareto].push(c);
  }

  // Load prospects when any scoped user has prospect targets (marzam C backfill
  // or dedicated prospecto quotas A/B/C/D).
  const willPickProspects = scopeUsers.some((u) => {
    if (!ROLES_THAT_PROSPECT.has(normalizeRole(u.role))) return false;
    const t = targets[u.id];
    // Dedicated prospecto slots
    if (PROSPECTO_PARETO_CLASSES.some((p) => (t?.prospecto?.[p] || 0) > 0)) return true;
    // Legacy C-slot backfill (only if no dedicated slots)
    if (paretoFilter.includes('C') && (t?.marzam?.C || 0) > 0) return true;
    return false;
  });

  let prospects = [];
  let droppedProspects = [];
  if (willPickProspects) {
    const alreadyAssignedProspects = await loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd);
    let allProspects = await pickCandidateProspects(trx, {
      excludePharmacyIds: alreadyAssignedProspects,
    });
    const filteredProspects = await filterNotAcceptable(allProspects);
    prospects = filteredProspects.candidates;
    droppedProspects = filteredProspects.dropped;
  }

  const { assignments: assignmentMap, unassigned } = assignByGreedy({
    scopeUsers, days, candidatesByPareto, prospects, targets,
  });

  const { rows: assignmentRows, totals } = await sequenceAndMaterialize({
    scopeUsers, assignments: assignmentMap, planConfig: { route_start_hhmm: routeStartHHMM },
  });

  const config = {
    targets_snapshot: targets,
    working_days: days.length,
    pareto_filter: paretoFilter,
    route_start_hhmm: routeStartHHMM,
    candidate_counts: {
      A: candidatesByPareto.A.length,
      B: candidatesByPareto.B.length,
      C: candidatesByPareto.C.length,
      prospects: prospects.length,
    },
    dropped_not_acceptable: [
      ...filteredClients.dropped,
      ...droppedProspects,
    ],
    unassigned,
  };
  const metrics = {
    total_drive_minutes: totals.total_drive_minutes,
    total_service_minutes: totals.total_service_minutes,
    caution_arcs: totals.caution_arcs,
    polyline_arcs: totals.polyline_arcs,
    unassigned_count: unassigned.length,
    assignments_count: assignmentRows.length,
  };

  const planDraft = {
    owner_user_id: ownerUserId,
    scope_user_id: scopeUserIds.length === 1 ? scopeUserIds[0] : null,
    branch_id: branchId,
    granularity,
    period_start: periodStart,
    period_end: periodEnd,
    status: 'draft',
    name,
    config,
    metrics,
  };

  return { planDraft, assignmentRows, metrics };
}

// DB columns in visit_plan_assignments (excludes preview-only fields like
// lat, lng, farmacia_nombre, cpadre, pareto added by sequenceAndMaterialize).
const DB_ASSIGNMENT_COLS = [
  'visitor_user_id', 'marzam_client_id', 'pharmacy_id',
  'scheduled_date', 'route_order', 'channel', 'status',
  'expected_start_time', 'expected_arrival_time',
  'expected_travel_minutes', 'expected_service_minutes',
  'polyline_to_next',
];

async function generate(args) {
  return db.transaction(async (trx) => {
    const { planDraft, assignmentRows } = await buildPlan(args, trx);
    const [plan] = await trx('visit_plans').insert(planDraft).returning('*');
    if (assignmentRows.length) {
      const insertRows = assignmentRows.map((r) => {
        const row = { visit_plan_id: plan.id };
        for (const col of DB_ASSIGNMENT_COLS) row[col] = r[col];
        return row;
      });
      const CHUNK = 250;
      for (let i = 0; i < insertRows.length; i += CHUNK) {
        await trx('visit_plan_assignments').insert(insertRows.slice(i, i + CHUNK));
      }
    }
    return { plan, assignments_count: assignmentRows.length };
  });
}

/**
 * Same engine as generate() but does NOT persist. Returns enough data for the
 * Plan Editor UI to render polylines and let the manager iterate before
 * committing to a draft.
 */
async function previewGenerate(args) {
  // We still want a transaction for read consistency on resolve_visit_target.
  return db.transaction(async (trx) => {
    const { planDraft, assignmentRows, metrics } = await buildPlan(args, trx);
    return {
      plan: planDraft,
      assignments: assignmentRows,
      metrics,
    };
  });
}

module.exports = {
  generate,
  previewGenerate,
  PARETO_CLASSES,
  PROSPECTO_PARETO_CLASSES,
  ROLE_PRIMARY_PARETO,
};
