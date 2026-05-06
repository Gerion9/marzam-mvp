/**
 * Plan generator (driving-aware) — Fase A + B rewrite.
 *
 * Public API:
 *   generate({...})        — runs and persists a draft plan (calls computeRoute)
 *   previewGenerate({...}) — runs WITHOUT persisting AND WITHOUT computeRoute
 *                            (matrix-only). Returns assignments, metrics, and
 *                            unassigned[] stops for the editor UI.
 *   estimateCost({...})    — runs the assignment phase only, counts how many
 *                            matrix elements + arc calls would be needed,
 *                            without ever calling Google.
 *
 * Algorithm:
 *   1) Resolve daily targets per (user, day, pareto, kind) via SQL function
 *      resolve_visit_target_v2 — done PER DAY now, not just firstDay, so
 *      override boundaries inside the period are respected.
 *   2) Load candidate clients + prospects with their lat/lng (joined to
 *      pharmacies for coordinates).
 *   3) Hard-filter candidates whose colonia is `not_acceptable` AND tag the
 *      ones whose colonia is `caution` so they get a 1.5× distance penalty
 *      DURING assignment (not just sequencing).
 *   4) Cluster candidates per rep using k-means anchored on home_lat/lng.
 *   5) For each working day, for each user, for each Pareto class:
 *      pick `dailyTarget` UNUSED candidates from the cluster with shortest
 *      penalized Haversine distance to home. Track an accumulated minutes
 *      budget per (user, day) and reject candidates that would push the rep
 *      over `daily_minutes_cap` — those go to unassigned[] with reason.
 *   6) For each (rep, day), fetch a small driving-time matrix (home + stops)
 *      via routesMatrix.computeMatrixCached, run NN-from-depot + 2-opt to
 *      sequence them, plus an extra leg back to home. In `generate()` only,
 *      call computeRoute() per arc to materialize polylines and test caution
 *      polygon intersections. In `previewGenerate()` we only have the matrix
 *      duration — no polyline materialization.
 *   7) Materialize visit_plan_assignments with route_order, expected_arrival_time,
 *      expected_start_time (= arrival), expected_travel_minutes,
 *      expected_service_minutes, polyline_to_next.
 *   8) Persist plan.metrics with totals + plan.config.unassigned[] +
 *      last_leg_minutes_per_user.
 */

const db = require('../../config/database');
const { ROLES, normalizeRole } = require('../../constants/roles');
const { canActorManage } = require('../../services/teamScope');
const routesMatrix = require('../../services/routesMatrix');
const securityPolygons = require('../../services/securityPolygons');
const { orderStopsFromDepot, twoOptImprove } = require('../../utils/routeOrdering');
const { QUADRANT_TO_PARETO } = require('../../utils/visitCadence');
const { clusterByHome } = require('../../utils/kmeans');
const { localDayHHMMToUTC } = require('../../utils/timezone');

const PARETO_CLASSES = ['A', 'B', 'C'];
const PROSPECTO_PARETO_CLASSES = ['A', 'B', 'C', 'D'];

const ROLE_PRIMARY_PARETO = {
  [ROLES.DIRECTOR_SUCURSAL]: ['A'],
  [ROLES.GERENTE_VENTAS]: ['A', 'B'],
  [ROLES.SUPERVISOR]: ['A', 'B'],
  [ROLES.REPRESENTANTE]: ['B', 'C'],
};

const ROLES_THAT_PROSPECT = new Set([ROLES.SUPERVISOR, ROLES.REPRESENTANTE]);

const DEFAULT_ROUTE_START_HHMM = '08:00';
const DEFAULT_DAILY_MINUTES_CAP = 480;
const DEFAULT_SERVICE_MINUTES = 45;
const RETURN_LEG_KMH = 22;
const RETURN_LEG_HAVERSINE_FACTOR = 1.4;
const PER_USER_CONCURRENCY = 8;

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

function isoDate(d) { return d.toISOString().slice(0, 10); }

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
 * Estimate the round-trip travel minutes between two points without spending
 * a Google call. Used in the daily-cap budget check before we know the real
 * matrix value.
 */
function estimateMinutes(a, b) {
  const km = haversineKm(a, b) * RETURN_LEG_HAVERSINE_FACTOR;
  return Math.round((km / RETURN_LEG_KMH) * 60);
}

/**
 * Run an async fn over an array with bounded concurrency. Used so that we
 * don't open 80 simultaneous matrix lookups but also don't serialize them.
 */
async function pMapBounded(items, fn, limit = PER_USER_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next; next += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function resolveTargetsForUser(trx, userId, day) {
  const marzam = {};
  for (const pareto of PARETO_CLASSES) {
    const r = await trx.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
      userId, pareto, 'visit', day,
    ]);
    marzam[pareto] = r.rows?.[0]?.v ?? null;
  }
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
    for (const pareto of PROSPECTO_PARETO_CLASSES) prospecto[pareto] = 0;
  }
  return { marzam, prospecto };
}

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

async function pickCandidateProspects(trx, { excludePharmacyIds = [], paretoLetters = null, periodStart = null }) {
  let quadrantFilter = null;
  if (paretoLetters && paretoLetters.length) {
    const PARETO_TO_Q = { A: 'Q1', B: 'Q2', C: 'Q3', D: 'Q4' };
    quadrantFilter = paretoLetters.map((l) => PARETO_TO_Q[l]).filter(Boolean);
  }

  // Prefer the most recent quadrant_snapshot whose period_start <= periodStart.
  // Falls back to live `quadrant_derived` if no snapshot exists yet (e.g.,
  // the snapshot cron hasn't run for the first time).
  let snapshotPeriod = null;
  try {
    const snap = await trx('quadrant_snapshot')
      .where('period_start', '<=', periodStart || new Date().toISOString().slice(0, 10))
      .max({ p: 'period_start' })
      .first();
    snapshotPeriod = snap?.p || null;
  } catch {
    // table missing (pre-063) — degrade silently
  }

  if (snapshotPeriod) {
    const q = trx('pharmacies as p')
      .innerJoin('quadrant_snapshot as qs', function () {
        this.on('qs.pharmacy_id', '=', 'p.id').andOn('qs.period_start', '=', trx.raw('?', [snapshotPeriod]));
      })
      .select(
        'p.id', 'p.name as farmacia_nombre', 'p.municipality as delegacion_municipio',
        'p.quadrant', 'qs.quadrant as quadrant_derived', 'qs.final_score',
        db.raw('ST_X(p.coordinates::geometry) AS lng'),
        db.raw('ST_Y(p.coordinates::geometry) AS lat'),
      )
      .whereNot('p.source', 'marzam')
      .andWhere('p.status', 'active')
      .andWhere(function () {
        this.whereNull('p.business_type').orWhere('p.business_type', 'pharmacy');
      });
    if (excludePharmacyIds.length) q.whereNotIn('p.id', excludePharmacyIds);
    if (quadrantFilter && quadrantFilter.length) q.whereIn('qs.quadrant', quadrantFilter);
    return q.orderByRaw(`
      CASE qs.quadrant
        WHEN 'Q1' THEN 1 WHEN 'Q2' THEN 2 WHEN 'Q3' THEN 3 WHEN 'Q4' THEN 4 ELSE 5
      END,
      COALESCE(qs.final_score, 0) DESC,
      p.name
    `);
  }

  // Fallback: live data (legacy behaviour).
  const q = trx('pharmacies')
    .select(
      'id', 'name as farmacia_nombre', 'municipality as delegacion_municipio',
      'quadrant', 'quadrant_derived', 'final_score',
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
    .whereNull('vp.archived_at')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.marzam_client_id')
    .pluck('vpa.marzam_client_id');
}

async function loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd) {
  return trx('visit_plan_assignments as vpa')
    .join('visit_plans as vp', 'vp.id', 'vpa.visit_plan_id')
    .where('vp.status', 'published')
    .whereNull('vp.archived_at')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.pharmacy_id')
    .pluck('vpa.pharmacy_id');
}

/**
 * Hard-filter not_acceptable colonias AND tag caution colonias on each candidate
 * (so the assignment phase can apply a 1.5× distance penalty).
 */
async function classifyCandidatesByPolygon(candidates) {
  const withCoords = candidates.filter((c) => c.lat != null && c.lng != null);
  if (!withCoords.length) {
    return { candidates, dropped: [] };
  }
  const points = withCoords.map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }));
  const levels = await securityPolygons.levelAtPoints(points);
  const dropped = [];
  const keep = [];
  let withCoordIdx = 0;
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) {
      keep.push({ ...c, __caution: false });
      continue;
    }
    const lvl = levels.get(withCoordIdx);
    withCoordIdx += 1;
    if (lvl === 'not_acceptable') {
      dropped.push({ id: c.id, name: c.farmacia_nombre, reason: 'not_acceptable_colonia' });
    } else {
      keep.push({ ...c, __caution: lvl === 'caution' });
    }
  }
  return { candidates: keep, dropped };
}

/**
 * Phase 1 — assign candidates to (user, day) cells using cluster-then-greedy
 * with a daily-minutes-cap budget enforced.
 *
 * targets[userId][dayIso] = { marzam: { A, B, C }, prospecto: { A, B, C, D } }
 */
function assignByGreedy({ scopeUsers, days, candidatesByPareto, prospects, targets }) {
  const usedClients = new Set();
  const usedProspects = new Set();
  const assignments = new Map(); // userId -> Map<dayIso, stops[]>
  const unassigned = [];

  for (const u of scopeUsers) assignments.set(u.id, new Map());

  // Cluster ALL candidates (clients + prospects) once per role's eligible set
  // by user home. We do clustering globally so each rep gets a coherent
  // territory around their home; then we filter each cluster by Pareto inside
  // the per-day loop.
  const clusterableUsers = scopeUsers.filter(
    (u) => Number.isFinite(Number(u.home_lat)) && Number.isFinite(Number(u.home_lng)),
  );
  const allCandidates = [
    ...Object.values(candidatesByPareto).flat().map((c) => ({ ...c, __kind: 'client' })),
    ...prospects.map((c) => ({ ...c, __kind: 'prospect' })),
  ];
  const { byRep: clusterByRepId } = clusterByHome(clusterableUsers, allCandidates, { iterations: 4 });

  // Pre-index clusters by repId / Pareto / kind so the per-day loop is O(1).
  // Map<userId, { client: { A: [], B: [], C: [] }, prospect: { A, B, C, D } }>
  const indexed = new Map();
  for (const u of scopeUsers) {
    indexed.set(u.id, {
      client: { A: [], B: [], C: [] },
      prospect: { A: [], B: [], C: [], D: [] },
    });
  }
  for (const u of scopeUsers) {
    const myCluster = clusterByRepId.get(u.id) || [];
    const home = (u.home_lat != null && u.home_lng != null)
      ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
      : null;
    // Sort each Pareto bucket by penalized Haversine distance to home so the
    // pop order is stable and "closest first".
    for (const c of myCluster) {
      const lat = Number(c.lat); const lng = Number(c.lng);
      const baseD = home ? haversineKm(home, { lat, lng }) : 0;
      const penalty = c.__caution ? securityPolygons.CAUTION_PENALTY : 1;
      c.__distScore = baseD * penalty;
      const pareto = c.__kind === 'client'
        ? c.pareto
        : (QUADRANT_TO_PARETO[c.quadrant_derived] || QUADRANT_TO_PARETO[c.quadrant] || 'C');
      const bucket = indexed.get(u.id)[c.__kind][pareto];
      if (bucket) bucket.push(c);
    }
    for (const kind of ['client', 'prospect']) {
      for (const p of Object.keys(indexed.get(u.id)[kind])) {
        indexed.get(u.id)[kind][p].sort((a, b) => a.__distScore - b.__distScore);
      }
    }
  }

  // Per-(user,day) budget tracker: cumulative minutes including drive estimates.
  const dayBudgetUsed = new Map(); // key `${userId}|${dayIso}` -> minutes used

  function budgetKey(u, d) { return `${u}|${d}`; }
  function tryFit(u, dayIso, candidate, prevPoint) {
    const key = budgetKey(u.id, dayIso);
    const used = dayBudgetUsed.get(key) || 0;
    const cap = u.daily_minutes_cap || DEFAULT_DAILY_MINUTES_CAP;
    const service = u.service_minutes_per_stop || DEFAULT_SERVICE_MINUTES;
    const home = (u.home_lat != null && u.home_lng != null)
      ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
      : null;
    const candPoint = { lat: Number(candidate.lat), lng: Number(candidate.lng) };
    const fromPrev = prevPoint ? estimateMinutes(prevPoint, candPoint) : (home ? estimateMinutes(home, candPoint) : 0);
    const returnLeg = home ? estimateMinutes(candPoint, home) : 0;
    const optimisticTotal = used + fromPrev + service + returnLeg;
    if (optimisticTotal > cap) return null;
    return { fromPrev, service, returnLeg };
  }

  for (const day of days) {
    const dayIso = isoDate(day);
    for (const u of scopeUsers) {
      const role = normalizeRole(u.role);
      const allowedParetos = ROLE_PRIMARY_PARETO[role] || [];
      const dayMarzam = targets[u.id]?.[dayIso]?.marzam || {};
      const dayProspecto = targets[u.id]?.[dayIso]?.prospecto || {};
      const dayStops = [];
      const home = (u.home_lat != null && u.home_lng != null)
        ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
        : null;
      const userBuckets = indexed.get(u.id);
      // Track the previous accepted stop's coords so the cap accounting reflects
      // sequencing (approximately — we'll re-sequence with real driving in phase 2).
      let prevPoint = home;
      const fitOrUnassign = (candidate, kind) => {
        const fit = tryFit(u, dayIso, candidate, prevPoint);
        if (!fit) return false;
        dayStops.push({ ...candidate, __type: kind });
        if (kind === 'client') usedClients.add(candidate.id); else usedProspects.add(candidate.id);
        const key = budgetKey(u.id, dayIso);
        dayBudgetUsed.set(key, (dayBudgetUsed.get(key) || 0) + fit.fromPrev + fit.service);
        prevPoint = { lat: Number(candidate.lat), lng: Number(candidate.lng) };
        return true;
      };

      // ── Marzam clients ──
      for (const pareto of allowedParetos) {
        const dailyTarget = dayMarzam[pareto] || 0;
        if (!dailyTarget) continue;
        let placed = 0;
        const pool = (userBuckets?.client?.[pareto] || []).filter((c) => !usedClients.has(c.id));
        for (const candidate of pool) {
          if (placed >= dailyTarget) break;
          if (fitOrUnassign(candidate, 'client')) placed += 1;
          else {
            unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'marzam', reason: 'cap_exceeded', stop_id: candidate.id });
          }
        }

        // Legacy C-slot backfill with prospects when no dedicated prospecto targets
        const hasDedicatedProspecto = PROSPECTO_PARETO_CLASSES.some((p) => (dayProspecto[p] || 0) > 0);
        if (pareto === 'C' && placed < dailyTarget && ROLES_THAT_PROSPECT.has(role) && !hasDedicatedProspecto) {
          // Pull from any Pareto bucket of prospects ordered by distance.
          const prospectPool = PROSPECTO_PARETO_CLASSES
            .flatMap((p) => userBuckets.prospect[p])
            .filter((c) => !usedProspects.has(c.id))
            .sort((a, b) => a.__distScore - b.__distScore);
          for (const candidate of prospectPool) {
            if (placed >= dailyTarget) break;
            if (fitOrUnassign(candidate, 'prospect')) placed += 1;
          }
        }

        const shortfall = dailyTarget - placed;
        if (shortfall > 0) {
          unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'marzam', reason: 'pool_exhausted', shortfall });
        }
      }

      // ── Prospecto dedicated assignments ──
      if (ROLES_THAT_PROSPECT.has(role)) {
        for (const pareto of PROSPECTO_PARETO_CLASSES) {
          const dailyTarget = dayProspecto[pareto] || 0;
          if (!dailyTarget) continue;
          let placed = 0;
          const pool = (userBuckets?.prospect?.[pareto] || []).filter((c) => !usedProspects.has(c.id));
          for (const candidate of pool) {
            if (placed >= dailyTarget) break;
            if (fitOrUnassign(candidate, 'prospect')) placed += 1;
            else {
              unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'prospecto', reason: 'cap_exceeded', stop_id: candidate.id });
            }
          }
          const shortfall = dailyTarget - placed;
          if (shortfall > 0) {
            unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'prospecto', reason: 'pool_exhausted', shortfall });
          }
        }
      }

      assignments.get(u.id).set(dayIso, dayStops);
    }
  }
  return { assignments, unassigned };
}

/**
 * Phase 2 — sequence each (rep, day) using driving-time matrix.
 *
 * Modes:
 *   'persist' (default in generate)  — calls computeRoute per arc to get real
 *                                       polylines, tests caution polygon
 *                                       intersection, and applies 1.5× penalty.
 *   'preview' (default in previewGenerate) — uses ONLY the cached/just-fetched
 *                                       matrix. No computeRoute calls. Polyline
 *                                       comes from cache when present, else null.
 */
async function sequenceAndMaterialize({ scopeUsers, assignments, planConfig, mode = 'persist' }) {
  const rows = [];
  const totals = {
    total_drive_minutes: 0,
    total_service_minutes: 0,
    caution_arcs: 0,
    polyline_arcs: 0,
    last_leg_minutes_per_user: {},
  };
  const routeStartHHMM = planConfig.route_start_hhmm || DEFAULT_ROUTE_START_HHMM;
  const userById = new Map(scopeUsers.map((u) => [u.id, u]));

  // Process users with bounded concurrency.
  const userIds = [...assignments.keys()];
  await pMapBounded(userIds, async (userId) => {
    const u = userById.get(userId);
    const home = (u && u.home_lat != null && u.home_lng != null)
      ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
      : null;
    const serviceMinutes = u?.service_minutes_per_stop || DEFAULT_SERVICE_MINUTES;
    const byDay = assignments.get(userId);

    for (const [dayIso, stops] of byDay.entries()) {
      if (!stops.length) continue;
      const stopsWithCoords = stops.filter((s) => s.lat != null && s.lng != null);
      const stopsNoCoords = stops.filter((s) => s.lat == null || s.lng == null);

      let ordered = stopsWithCoords;
      let durationsMatrix = null;

      if (home && stopsWithCoords.length >= 2) {
        const points = [home, ...stopsWithCoords.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
        try {
          const matrix = await routesMatrix.computeMatrixCached(points, points, {
            preference: 'TRAFFIC_UNAWARE',
          });
          durationsMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
          for (const r of matrix) {
            durationsMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
          }
        } catch (err) {
          console.warn(`[planGenerator] matrix failed for user ${userId} day ${dayIso}: ${err.message}`);
          durationsMatrix = null;
        }

        if (durationsMatrix) {
          stopsWithCoords.forEach((s, i) => { s.__seqIdx = i + 1; });
          const depotMarker = { __seqIdx: 0, lat: home.lat, lng: home.lng, __depot: true };
          const costFn = (a, b) => {
            const ai = a.__seqIdx ?? 0;
            const bi = b.__seqIdx ?? 0;
            return durationsMatrix[ai][bi];
          };
          const nnOrdered = orderStopsFromDepot(depotMarker, stopsWithCoords, costFn);
          const opt = twoOptImprove([depotMarker, ...nnOrdered], costFn);
          ordered = opt.slice(1).map((s) => stopsWithCoords.find((x) => x.__seqIdx === s.__seqIdx));
        } else {
          const costFn = (a, b) => haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
          ordered = orderStopsFromDepot(home, stopsWithCoords, costFn);
        }
      }

      // Walk the ordered list to compute ETAs + polylines.
      let cursor = localDayHHMMToUTC(dayIso, routeStartHHMM);
      let prevPoint = home;
      let prevSeqIdx = 0; // depot
      let routeOrder = 1;
      const dayRows = [];

      for (const s of ordered) {
        const stopPoint = { lat: Number(s.lat), lng: Number(s.lng) };
        let travelSeconds = 0;
        let polyline = null;
        let crossesCaution = false;

        if (durationsMatrix && s.__seqIdx != null) {
          const ms = durationsMatrix[prevSeqIdx][s.__seqIdx];
          if (Number.isFinite(ms)) travelSeconds = ms;
        }

        if (mode === 'persist' && prevPoint) {
          // Real polyline materialization — only at publish time.
          try {
            const route = await routesMatrix.computeRoute(prevPoint, stopPoint, { preference: 'TRAFFIC_UNAWARE' });
            if (route) {
              travelSeconds = route.durationSeconds || travelSeconds;
              polyline = route.polyline;
              if (polyline) {
                crossesCaution = await securityPolygons.polylineIntersectsCaution(polyline);
                if (crossesCaution) {
                  travelSeconds = Math.round(travelSeconds * securityPolygons.CAUTION_PENALTY);
                  totals.caution_arcs += 1;
                }
                totals.polyline_arcs += 1;
                routesMatrix.persistPolylineSafe(prevPoint, stopPoint, polyline);
              }
            }
          } catch (err) {
            console.warn(`[planGenerator] route failed for user ${userId} day ${dayIso}: ${err.message}`);
          }
        }

        if (!travelSeconds) {
          // Degraded fallback when neither matrix nor computeRoute produced.
          const km = haversineKm(prevPoint || home || stopPoint, stopPoint) * RETURN_LEG_HAVERSINE_FACTOR;
          travelSeconds = Math.round((km / RETURN_LEG_KMH) * 3600);
        }
        const travelMinutes = Math.round(travelSeconds / 60);
        cursor = new Date(cursor.getTime() + travelSeconds * 1000);
        const arrival = new Date(cursor);
        cursor = new Date(cursor.getTime() + serviceMinutes * 60 * 1000);

        const row = {
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
          polyline_to_next: null,
          // Preview-only fields (stripped before DB insert in generate()).
          lat: s.lat != null ? Number(s.lat) : null,
          lng: s.lng != null ? Number(s.lng) : null,
          farmacia_nombre: s.farmacia_nombre || null,
          cpadre: s.cpadre || null,
          pareto: s.pareto || null,
          __crossesCaution: crossesCaution,
        };
        dayRows.push(row);
        if (dayRows.length > 1) {
          dayRows[dayRows.length - 2].polyline_to_next = polyline;
        }
        totals.total_drive_minutes += travelMinutes;
        totals.total_service_minutes += serviceMinutes;
        prevPoint = stopPoint;
        prevSeqIdx = s.__seqIdx ?? 0;
        routeOrder += 1;
      }

      // Append return leg duration (no row, just metric) — closes the day.
      let lastLegMinutes = 0;
      if (home && prevPoint && prevPoint !== home) {
        let returnSeconds = 0;
        if (durationsMatrix && prevSeqIdx > 0) {
          const m = durationsMatrix[prevSeqIdx][0];
          if (Number.isFinite(m)) returnSeconds = m;
        }
        if (!returnSeconds) {
          const km = haversineKm(prevPoint, home) * RETURN_LEG_HAVERSINE_FACTOR;
          returnSeconds = Math.round((km / RETURN_LEG_KMH) * 3600);
        }
        lastLegMinutes = Math.round(returnSeconds / 60);
        totals.total_drive_minutes += lastLegMinutes;
      }
      totals.last_leg_minutes_per_user[userId] = (totals.last_leg_minutes_per_user[userId] || 0) + lastLegMinutes;

      // Stops without coords are appended at the end with no ETA.
      for (const s of stopsNoCoords) {
        dayRows.push({
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
          lat: null, lng: null,
          farmacia_nombre: s.farmacia_nombre || null,
          cpadre: s.cpadre || null,
          pareto: s.pareto || null,
        });
        routeOrder += 1;
      }

      rows.push(...dayRows);
    }
  });
  return { rows, totals };
}

/**
 * Core engine shared by generate() / previewGenerate() / estimateCost().
 */
async function buildPlan(args, trx, mode) {
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
    err.status = 400; throw err;
  }
  if (!['daily', 'weekly', 'monthly'].includes(granularity)) {
    const err = new Error('granularity must be daily/weekly/monthly');
    err.status = 400; throw err;
  }

  // Authorization — every scope_user must be the owner himself OR a managee.
  for (const sid of scopeUserIds) {
    if (sid === ownerUserId) continue;
    if (!await canActorManage(ownerUserId, sid)) {
      const err = new Error(`User ${ownerUserId} cannot generate plan for ${sid}`);
      err.status = 403; throw err;
    }
  }

  // Defensive SELECT: migration 057 might not be applied. Fall back to base
  // columns and let the geo logic degrade gracefully.
  let scopeUsers;
  try {
    scopeUsers = await trx('users')
      .select('id', 'role', 'full_name', 'branch_id',
        'home_lat', 'home_lng', 'daily_minutes_cap', 'service_minutes_per_stop')
      .whereIn('id', scopeUserIds)
      .andWhere({ is_active: true });
  } catch (err) {
    if (/column .* does not exist/.test(String(err.message || ''))) {
      console.warn('[planGenerator] migration 057 not applied — degrading');
      scopeUsers = (await trx('users')
        .select('id', 'role', 'full_name', 'branch_id')
        .whereIn('id', scopeUserIds)
        .andWhere({ is_active: true }))
        .map((u) => ({
          ...u, home_lat: null, home_lng: null,
          daily_minutes_cap: DEFAULT_DAILY_MINUTES_CAP,
          service_minutes_per_stop: DEFAULT_SERVICE_MINUTES,
        }));
    } else { throw err; }
  }

  const days = eachWorkingDay(new Date(`${periodStart}T00:00:00Z`), new Date(`${periodEnd}T00:00:00Z`));
  if (!days.length) {
    const err = new Error('No working days in window');
    err.status = 400; throw err;
  }

  // Resolve targets PER DAY (not just firstDay) so override boundaries inside
  // the period are respected. Cache by `${userId}|${dayIso}`.
  const targets = {};
  for (const u of scopeUsers) targets[u.id] = {};
  await pMapBounded(scopeUsers, async (u) => {
    for (const day of days) {
      const dayIso = isoDate(day);
      targets[u.id][dayIso] = await resolveTargetsForUser(trx, u.id, dayIso);
    }
  });

  const alreadyAssignedClients = await loadAlreadyAssignedClientIds(trx, periodStart, periodEnd);
  let allClients = await pickCandidateClients(trx, {
    paretoFilter,
    excludeClientIds: alreadyAssignedClients,
  });
  // Hard-filter not_acceptable + tag caution.
  const filteredClients = await classifyCandidatesByPolygon(allClients);
  allClients = filteredClients.candidates;

  const candidatesByPareto = { A: [], B: [], C: [] };
  for (const c of allClients) {
    if (candidatesByPareto[c.pareto]) candidatesByPareto[c.pareto].push(c);
  }

  // Load prospects when ANY day has prospect quotas.
  const willPickProspects = scopeUsers.some((u) => {
    if (!ROLES_THAT_PROSPECT.has(normalizeRole(u.role))) return false;
    return Object.values(targets[u.id] || {}).some((t) => {
      if (PROSPECTO_PARETO_CLASSES.some((p) => (t?.prospecto?.[p] || 0) > 0)) return true;
      if (paretoFilter.includes('C') && (t?.marzam?.C || 0) > 0) return true;
      return false;
    });
  });

  let prospects = [];
  let droppedProspects = [];
  if (willPickProspects) {
    const alreadyAssignedProspects = await loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd);
    let allProspects = await pickCandidateProspects(trx, {
      excludePharmacyIds: alreadyAssignedProspects,
      periodStart,
    });
    const filteredProspects = await classifyCandidatesByPolygon(allProspects);
    prospects = filteredProspects.candidates;
    droppedProspects = filteredProspects.dropped;
  }

  const { assignments: assignmentMap, unassigned } = assignByGreedy({
    scopeUsers, days, candidatesByPareto, prospects, targets,
  });

  const { rows: assignmentRows, totals } = await sequenceAndMaterialize({
    scopeUsers, assignments: assignmentMap, planConfig: { route_start_hhmm: routeStartHHMM },
    mode,
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
    last_leg_minutes_per_user: totals.last_leg_minutes_per_user,
  };

  // Stable scope_hash so the unique index in 059 catches duplicates.
  const sortedIds = [...scopeUserIds].sort();
  const scopeHash = require('crypto').createHash('md5').update(sortedIds.join(',')).digest('hex');

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
    scope_hash: scopeHash,
  };

  return { planDraft, assignmentRows, metrics };
}

const DB_ASSIGNMENT_COLS = [
  'visitor_user_id', 'marzam_client_id', 'pharmacy_id',
  'scheduled_date', 'route_order', 'channel', 'status',
  'expected_start_time', 'expected_arrival_time',
  'expected_travel_minutes', 'expected_service_minutes',
  'polyline_to_next',
];

async function generate(args) {
  return db.transaction(async (trx) => {
    const { planDraft, assignmentRows } = await buildPlan(args, trx, 'persist');
    // Idempotency: serialize concurrent generates against the same scope+period
    // with a transaction-scoped advisory lock. Two concurrent calls now block
    // instead of both passing the SELECT-then-INSERT race and surfacing a raw
    // unique_violation. The lock key is hashed from scope_hash+period so it is
    // deterministic and bounded to a 64-bit int.
    const lockKey = require('crypto')
      .createHash('md5')
      .update(`${planDraft.scope_hash}|${planDraft.period_start}|${planDraft.period_end}`)
      .digest();
    // Use the first 8 bytes of the md5 as a signed bigint for pg_advisory_xact_lock.
    const lockBig = lockKey.readBigInt64BE(0);
    await trx.raw('SELECT pg_advisory_xact_lock(?::bigint)', [lockBig.toString()]);

    const existing = await trx('visit_plans')
      .where({ scope_hash: planDraft.scope_hash, period_start: planDraft.period_start, period_end: planDraft.period_end })
      .whereNull('archived_at')
      .whereIn('status', ['draft', 'published'])
      .first();
    if (existing) {
      const err = new Error(`Plan already exists for this scope and period (id=${existing.id}, status=${existing.status})`);
      err.status = 409;
      err.existing_plan_id = existing.id;
      throw err;
    }
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
 * Same engine as generate() but does NOT persist and does NOT call
 * computeRoute (matrix-only). The Plan Editor calls this on each iteration —
 * keeping it cheap is critical to staying within the daily Routes API budget.
 */
async function previewGenerate(args) {
  // No transaction — preview is read-only and we don't want to hold a tx
  // during async Routes API calls.
  const { planDraft, assignmentRows, metrics } = await buildPlan(args, db, 'preview');
  return {
    plan: planDraft,
    assignments: assignmentRows,
    metrics,
  };
}

/**
 * Cost estimator — runs the assignment phase only, then counts how many
 * unique geohash7 pairs would have to be looked up (matrix elements) and
 * how many arcs would need a computeRoute call at publish-time. Returns
 * an estimated USD cost without touching Google.
 */
async function estimateCost(args) {
  const { planDraft, assignmentRows } = await buildPlan(args, db, 'preview');
  // Group arcs by (user, day) to count how many matrix calls + arc calls
  // would be needed at publish time.
  const arcsByUser = new Map();
  for (const r of assignmentRows) {
    if (r.lat == null || r.lng == null) continue;
    if (!arcsByUser.has(r.visitor_user_id)) arcsByUser.set(r.visitor_user_id, []);
    arcsByUser.get(r.visitor_user_id).push(r);
  }
  const uniqMatrixPairs = new Set();
  let arcCount = 0;
  for (const [, list] of arcsByUser) {
    list.sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : a.scheduled_date > b.scheduled_date ? 1 : a.route_order - b.route_order));
    // Each (rep, day) needs a (N+1) × (N+1) matrix once, plus N arcs.
    let lastDate = null; let dayCount = 0;
    for (const r of list) {
      if (r.scheduled_date !== lastDate) {
        if (dayCount > 0) {
          // Approximate: 1 matrix call covers all arcs in the day.
          uniqMatrixPairs.add(`day:${r.visitor_user_id}:${lastDate}:${dayCount}`);
          arcCount += dayCount;
        }
        lastDate = r.scheduled_date; dayCount = 0;
      }
      dayCount += 1;
    }
    if (dayCount > 0) {
      uniqMatrixPairs.add(`day:${list[0].visitor_user_id}:${lastDate}:${dayCount}`);
      arcCount += dayCount;
    }
  }
  // Pricing (Google Routes API SKUs):
  //   Matrix Essentials: $5 / 1000 elements
  //   Routes single Essentials: $5 / 1000 calls
  // Matrix elements ≈ sum_{day} (N+1)^2 — we approximate with arcCount * 4
  // to stay simple and conservative (better to overestimate budget impact).
  const matrixElements = uniqMatrixPairs.size * 16; // average (N+1)² ≈ 16 for 3-stop days
  const estCostUsd = Math.round(((matrixElements + arcCount) / 1000 * 5) * 10000) / 10000;
  return {
    plan: planDraft,
    matrix_elements: matrixElements,
    route_calls: arcCount,
    est_cost_usd: estCostUsd,
  };
}

module.exports = {
  generate,
  previewGenerate,
  estimateCost,
  PARETO_CLASSES,
  PROSPECTO_PARETO_CLASSES,
  ROLE_PRIMARY_PARETO,
};
