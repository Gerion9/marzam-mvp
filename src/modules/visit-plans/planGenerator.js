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
const multiStartSolver = require('../../utils/multiStart');
const routeOptimization = require('../../services/routeOptimization');
const { QUADRANT_TO_PARETO } = require('../../utils/visitCadence');
const { clusterByHome } = require('../../utils/kmeans');
const { localDayHHMMToUTC } = require('../../utils/timezone');
const branchPlanSettings = require('../../services/branchPlanSettings');
const log = require('../../utils/logger');

// Soft-constraint penalty para Pareto. Más alto = el solver es menos
// propenso a dejar el stop sin asignar. Calibrado para que A nunca se quede
// (1000) y D pueda quedarse si hay conflicto fuerte (50).
const PARETO_PENALTY = { A: 1000, B: 500, C: 200, D: 50 };
function paretoPenalty(p) {
  return PARETO_PENALTY[p] || 100;
}

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
const DEFAULT_TRAVEL_MINUTES_CAP = 360;
const DEFAULT_DAILY_KM_CAP = 200;
const RETURN_LEG_KMH = 22;
const RETURN_LEG_HAVERSINE_FACTOR = 1.4;
const PER_USER_CONCURRENCY = 8;

// Feature flags — see plan inicial/2026-05-05-routes-api-uso-completo.md and
// the implementation plan in C:\Users\gairo\.claude\plans\si-van-a-ser-elegant-scott.md
//   PLAN_USE_COST_COEFFS    — α/β-weighted costFn with cost_coefficients table.
//                             When false, costFn is duration-only (legacy behavior).
//   PLAN_ENABLE_CAP_VALIDATION — also enforce users.travel_minutes_cap and
//                             users.daily_km_cap during tryFit (in addition to
//                             daily_minutes_cap). When false, only daily cap is checked.
const ENABLE_COST_COEFFS = process.env.PLAN_USE_COST_COEFFS === 'true';
const ENABLE_CAP_VALIDATION = process.env.PLAN_ENABLE_CAP_VALIDATION === 'true';

// Identity coeffs used when ENABLE_COST_COEFFS=false or no row found in DB.
// alpha_duration=1, beta_distance=0 yields costFn(a,b) = duration_seconds — the
// exact behavior of the legacy 2-opt closure.
const FALLBACK_COEFFS = Object.freeze({
  alpha_duration: 1.0,
  beta_distance: 0.0,
  cost_per_km: 0,
  cost_per_hour: 0,
  fixed_cost_per_day: 0,
  source: 'fallback',
});

// PR3 flags
const ENABLE_BREAKS = process.env.PLAN_ENABLE_BREAKS === 'true';
const ENABLE_SOFT_WINDOWS = process.env.PLAN_ENABLE_SOFT_WINDOWS === 'true';
const ENABLE_PARETO_SERVICE = process.env.PLAN_ENABLE_PARETO_SERVICE === 'true';
// Audit Fix #6 — when true, runs a soft-window-aware swap-improve pass
// AFTER multiStart picks a sequence. Conservative: only swaps that strictly
// reduce window slip without growing drive time more than 5% are accepted.
// Default off until A/B benchmark validates impact on published plans.
const ENABLE_SOFT_WINDOW_SWAP = process.env.PLAN_SOFT_WINDOW_AWARE === 'true';
const { improveForSoftWindows } = require('../../utils/softWindowSwap');

// PR5 flag: 'legacy' (NN+2opt only — historical) | 'multistart' (escalonado por N)
const SOLVER_STRATEGY = process.env.PLAN_SOLVER || 'legacy';
// Per-(rep,day) deadline budget for multistart. SLA in plan §6: N=25 < 500ms.
const SOLVER_DEADLINE_MS = Number(process.env.PLAN_SOLVER_DEADLINE_MS) || 450;

// PR6 flags
//   ROUTES_INLINE_POLYLINE — request polylines in the matrix call so persist mode
//                            doesn't need a separate computeRoute per arc.
//   PLAN_TRAFFIC_AWARE     — use TRAFFIC_AWARE for the publish-time matrix with
//                            departureTime = route start of the day. Doubles SKU price
//                            (Pro $10/1k) but produces ETAs that respect real traffic.
const ENABLE_INLINE_POLYLINE = process.env.ROUTES_INLINE_POLYLINE === 'true';
const ENABLE_TRAFFIC_AWARE_ON_PUBLISH = process.env.PLAN_TRAFFIC_AWARE === 'true';

// PR7 flag: post-greedy variance balance step (swap stops between rep_max and
// rep_min when their estimated end-of-day differs by > BALANCE_GAP_THRESHOLD_MIN).
const ENABLE_BALANCE_STEP = process.env.PLAN_ENABLE_BALANCE === 'true';
const BALANCE_GAP_THRESHOLD_MIN = Number(process.env.PLAN_BALANCE_GAP_MIN) || 90;
const BALANCE_MAX_ITERATIONS = 3;
const BALANCE_MAX_SWAPS_PER_ITER = 2;

// Penalty in equivalent-seconds for arriving outside a pharmacy's soft window.
// Tuned so a 30-min slip costs as much as ~10 minutes of drive (i.e. solver will
// detour up to 10 min to honor the window). Per-stop multiplier when default_assumed.
const SOFT_WINDOW_PENALTY_SEC_PER_MIN = 20;
const SOFT_WINDOW_DEFAULT_ASSUMED_DAMPING = 0.3;

// Legacy default: lunes-viernes. New code paths should pass workingDays from
// branchPlanSettings. The compat shim keeps existing callers working until they
// thread branchSettings down (see Phase 2: visitPlans.service.publish + create).
const LEGACY_WORKING_DAYS = [1, 2, 3, 4, 5];

function isWeekday(date, workingDays = LEGACY_WORKING_DAYS) {
  return workingDays.includes(date.getUTCDay());
}

function eachWorkingDay(start, end, workingDays = LEGACY_WORKING_DAYS) {
  const days = [];
  const cursor = new Date(start);
  const stop = new Date(end);
  while (cursor <= stop) {
    if (isWeekday(cursor, workingDays)) days.push(new Date(cursor));
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
  // Defensive: pharmacies.opening_hours_v2 only exists post-mig 070.
  const hasOpeningHoursV2 = await trx.schema.hasColumn('pharmacies', 'opening_hours_v2').catch(() => false);
  const selectCols = [
    'mc.id', 'mc.cpadre', 'mc.pareto', 'mc.pharmacy_id', 'mc.farmacia_nombre',
    'mc.delegacion_municipio', 'mc.poblacion',
    trx.raw('ST_X(p.coordinates::geometry) AS lng'),
    trx.raw('ST_Y(p.coordinates::geometry) AS lat'),
  ];
  if (hasOpeningHoursV2) {
    selectCols.push('p.opening_hours_v2', 'p.opening_hours_parse_status');
  }
  const q = trx('marzam_clients as mc')
    .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
    .select(...selectCols)
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

  // Defensive: opening_hours_v2 only exists post-mig 070.
  const hasOpeningHoursV2 = await trx.schema.hasColumn('pharmacies', 'opening_hours_v2').catch(() => false);

  if (snapshotPeriod) {
    const selectCols = [
      'p.id', 'p.name as farmacia_nombre', 'p.municipality as delegacion_municipio',
      'p.quadrant', 'qs.quadrant as quadrant_derived', 'qs.final_score',
      db.raw('ST_X(p.coordinates::geometry) AS lng'),
      db.raw('ST_Y(p.coordinates::geometry) AS lat'),
    ];
    if (hasOpeningHoursV2) selectCols.push('p.opening_hours_v2', 'p.opening_hours_parse_status');
    const q = trx('pharmacies as p')
      .innerJoin('quadrant_snapshot as qs', function () {
        this.on('qs.pharmacy_id', '=', 'p.id').andOn('qs.period_start', '=', trx.raw('?', [snapshotPeriod]));
      })
      .select(...selectCols)
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
  const liveSelectCols = [
    'id', 'name as farmacia_nombre', 'municipality as delegacion_municipio',
    'quadrant', 'quadrant_derived', 'final_score',
    db.raw('ST_X(coordinates::geometry) AS lng'),
    db.raw('ST_Y(coordinates::geometry) AS lat'),
  ];
  if (hasOpeningHoursV2) liveSelectCols.push('opening_hours_v2', 'opening_hours_parse_status');
  const q = trx('pharmacies')
    .select(...liveSelectCols)
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
 * Resolve cost coefficients for a user with the hierarchy:
 *   user → role → global → FALLBACK_COEFFS
 *
 * Cached by buildPlan in a per-run map so two calls within the same plan get
 * stable values even if cost_coefficients is edited concurrently.
 *
 * Returns FALLBACK_COEFFS when ENABLE_COST_COEFFS=false (so the rest of the
 * pipeline can treat coeffs as always present).
 */
async function resolveCostCoeffs(trx, user) {
  if (!ENABLE_COST_COEFFS) return { ...FALLBACK_COEFFS, source: 'disabled' };
  // Defensive: if migration 069 hasn't been applied yet, table won't exist.
  try {
    let row = await trx('cost_coefficients')
      .where({ scope_kind: 'user', scope_value: user.id })
      .whereNull('effective_to')
      .first();
    if (row) return { ...row, source: 'user' };
    if (user.role) {
      row = await trx('cost_coefficients')
        .where({ scope_kind: 'role', scope_value: user.role })
        .whereNull('effective_to')
        .first();
      if (row) return { ...row, source: 'role' };
    }
    row = await trx('cost_coefficients')
      .where({ scope_kind: 'global' })
      .whereNull('effective_to')
      .first();
    if (row) return { ...row, source: 'global' };
  } catch (err) {
    if (/relation .* does not exist/.test(String(err.message || ''))) {
      log.warn({ event: 'plan.coeffs.table_missing', migration: '069', user_id: user.id });
    } else {
      throw err;
    }
  }
  return { ...FALLBACK_COEFFS };
}

/**
 * Load break rules with the same hierarchy as cost_coefficients (user → role → global).
 * Returns array of break rules (typically 0 or 1 lunch). Quiet fallback when migration
 * 071 not applied: returns [] so PR2 alone keeps working.
 */
async function loadBreakRules(trx, user) {
  if (!ENABLE_BREAKS) return [];
  try {
    const userRules = await trx('break_rules')
      .where({ scope_kind: 'user', scope_value: user.id, active: true })
      .orderBy('kind');
    if (userRules.length) return userRules;
    if (user.role) {
      const roleRules = await trx('break_rules')
        .where({ scope_kind: 'role', scope_value: user.role, active: true })
        .orderBy('kind');
      if (roleRules.length) return roleRules;
    }
    return trx('break_rules')
      .where({ scope_kind: 'global', active: true })
      .orderBy('kind');
  } catch (err) {
    if (/relation .* does not exist/.test(String(err.message || ''))) return [];
    throw err;
  }
}

/**
 * Returns Map<pareto, service_minutes>. Empty map when migration 072 not applied
 * or feature flag off — caller falls back to user.service_minutes_per_stop or
 * DEFAULT_SERVICE_MINUTES.
 */
async function loadParetoServiceOverrides(trx) {
  if (!ENABLE_PARETO_SERVICE) return new Map();
  try {
    const rows = await trx('pareto_service_overrides')
      .where({ active: true })
      .select('pareto', 'service_minutes', 'applies_to_kind');
    const out = new Map();
    for (const r of rows) out.set(r.pareto, { minutes: r.service_minutes, kind: r.applies_to_kind });
    return out;
  } catch (err) {
    if (/relation .* does not exist/.test(String(err.message || ''))) return new Map();
    throw err;
  }
}

/**
 * Resolve service minutes for a stop. Hierarchy:
 *   1. users.service_minutes_per_stop (if set explicitly per rep)
 *   2. pareto_service_overrides[stop.pareto] when ENABLE_PARETO_SERVICE
 *   3. DEFAULT_SERVICE_MINUTES (45)
 */
function resolveServiceMinutes(user, stop, paretoOverrides) {
  if (user.service_minutes_per_stop != null && Number(user.service_minutes_per_stop) > 0) {
    return Number(user.service_minutes_per_stop);
  }
  if (ENABLE_PARETO_SERVICE && paretoOverrides && stop?.pareto) {
    const override = paretoOverrides.get(stop.pareto);
    if (override) {
      const stopKind = stop.__type || stop.__kind;
      if (override.kind === 'both' || override.kind === stopKind) return override.minutes;
    }
  }
  return DEFAULT_SERVICE_MINUTES;
}

/**
 * Compute soft-window penalty in equivalent-seconds for arriving outside a pharmacy's
 * opening hours. Returns 0 when feature flag off, no v2 hours, or arrival is inside
 * the window. Default-assumed windows get reduced damping (we don't trust them enough
 * to fully penalize).
 *
 * arrivalDate: JS Date in UTC. dayIso: 'YYYY-MM-DD'.
 */
const { windowForDay } = require('../../services/openingHoursParser');

function softWindowPenaltySeconds(stop, arrivalDate, dayIso) {
  if (!ENABLE_SOFT_WINDOWS || !stop || !arrivalDate) return 0;
  const win = windowForDay(stop, dayIso);
  if (!win) {
    // Pharmacy closed on this day → very strong penalty (treat as 60-min slip).
    return SOFT_WINDOW_PENALTY_SEC_PER_MIN * 60;
  }
  const arrivalLocalMin = arrivalDate.getUTCHours() * 60 + arrivalDate.getUTCMinutes();
  // Note: opening_hours stored as local CDMX (UTC-6). arrival is UTC. Adjust by 6h.
  const localMin = (arrivalLocalMin - 6 * 60 + 24 * 60) % (24 * 60);
  const [oh, om] = win.open.split(':').map(Number);
  const [ch, cm] = win.close.split(':').map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  let slip = 0;
  if (localMin < openMin) slip = openMin - localMin;
  else if (localMin > closeMin) slip = localMin - closeMin;
  if (!slip) return 0;
  const damping = win.defaultAssumed ? SOFT_WINDOW_DEFAULT_ASSUMED_DAMPING : 1.0;
  return slip * SOFT_WINDOW_PENALTY_SEC_PER_MIN * damping;
}

/**
 * Build the cost function used by NN-from-depot and 2-opt over a duration matrix.
 *
 *   costFn(a, b) = α · duration_seconds[a][b] + β · distance_meters[a][b]
 *
 * When β=0 (legacy path) this collapses to pure-duration ordering, byte-equivalent
 * to the previous closure at planGenerator.js:515.
 *
 * distancesMatrix is optional: when null (e.g. matrix call returned only durations
 * because field mask omitted distance), β is ignored.
 */
/**
 * Hook hacia Google Route Optimization API. Activo SOLO cuando
 * PLAN_USE_OPTIMIZATION_API=true. Retorna un array de stops ordenados (con
 * __seqIdx preservado) o `null` si:
 *
 *   - hay menos de 2 stops (TSP trivial — el multiStart maneja bien y evita
 *     la latencia de la llamada externa).
 *   - el optimizer falla / timeout / lanza (el caller hace fallback).
 *   - el resultado no contiene una ruta válida.
 *
 * El optimizer recibe nuestra matriz de duraciones pre-calculada (cache local
 * + Routes API una vez) para que NO consuma Routes API por dentro y nos
 * cobre doble. Distance matrix se computa con Haversine × correction porque
 * el optimizer la requiere y solo tenemos duraciones reales.
 *
 * `_optimizer` permite inyectar un stub en tests sin tocar el require cache.
 */
async function tryOptimizationApi({
  user, stops, home, durationsMatrix, dayIso, paretoOverrides,
  routeStartHHMM, _optimizer = routeOptimization,
}) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  if (!home || home.lat == null || home.lng == null) return null;
  if (!Array.isArray(durationsMatrix) || durationsMatrix.length === 0) return null;

  const points = [home, ...stops.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
  const n = points.length;

  // Haversine fallback para distance matrix — el optimizer la requiere y
  // nuestra matriz raw solo carga duraciones (PR6+ podría sumar distancias).
  const HAVERSINE_CORRECTION = 1.4;
  const haversineKm = routesMatrix._haversineKm;
  const distanceMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    if (i === j) return 0;
    return Math.round(haversineKm(points[i], points[j]) * HAVERSINE_CORRECTION * 1000);
  }));

  const vehicles = [{
    id: user.id,
    startLocation: home,
    routeDurationLimitMin: user.daily_minutes_cap || 480,
    routeDistanceLimitKm: user.daily_km_cap || 200,
  }];

  const shipments = stops.map((s, i) => ({
    id: s.id || `stop-${i}`,
    deliveryLocation: { lat: Number(s.lat), lng: Number(s.lng) },
    durationMinutes: resolveServiceMinutes(user, s, paretoOverrides),
    penaltyCost: paretoPenalty(s.pareto),
    requiredCapabilities: Array.isArray(s.required_skills) ? s.required_skills : undefined,
  }));

  const opts = {
    timeoutSeconds: Number(process.env.GOOGLE_OPT_TIMEOUT) || undefined,
  };

  const result = await _optimizer.optimizeTours({
    vehicles, shipments,
    durationMatrix: durationsMatrix,
    distanceMatrix,
    options: opts,
    // Forward para diagnóstico en logs estructurados del optimizer.
    _meta: { day_iso: dayIso, route_start_hhmm: routeStartHHMM, user_id: user.id },
  });

  const route = result?.routes?.[0];
  if (!route || !Array.isArray(route.visits)) return null;

  // Cada visit referencia el shipmentIndex original — recuperamos el stop con
  // su __seqIdx intacto (lo necesita el resto de sequenceAndMaterialize para
  // indexar polylineMatrix más abajo).
  const ordered = [];
  for (const visit of route.visits) {
    if (typeof visit.shipmentIndex !== 'number') continue;
    const s = stops[visit.shipmentIndex];
    if (s) ordered.push(s);
  }
  return ordered.length ? ordered : null;
}

function buildCostFn(durationsMatrix, distancesMatrix, coeffs) {
  const alpha = Number(coeffs?.alpha_duration ?? 1.0);
  const beta = Number(coeffs?.beta_distance ?? 0.0);
  return (a, b) => {
    const ai = a.__seqIdx ?? 0;
    const bi = b.__seqIdx ?? 0;
    const d = durationsMatrix[ai][bi];
    if (!Number.isFinite(d)) return Infinity;
    if (!beta || !distancesMatrix) return alpha * d;
    const dist = distancesMatrix[ai][bi];
    if (!Number.isFinite(dist)) return alpha * d;
    return alpha * d + beta * dist;
  };
}

/**
 * Phase 1 — assign candidates to (user, day) cells using cluster-then-greedy
 * with a daily-minutes-cap budget enforced.
 *
 * targets[userId][dayIso] = { marzam: { A, B, C }, prospecto: { A, B, C, D } }
 *
 * When ENABLE_CAP_VALIDATION=true, also tracks per-day travel minutes and km
 * against users.travel_minutes_cap / daily_km_cap; rejected candidates surface
 * in unassigned[] with reason 'travel_cap_exceeded' or 'km_cap_exceeded'.
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

  // Per-(user,day) budget trackers — three independent dimensions because a
  // long-distance detour can pass the daily cap (jornada total) but blow the
  // travel cap (manejo) or distance cap (gasolina + desgaste).
  const dayBudgetUsed = new Map();   // `${userId}|${dayIso}` -> total minutes
  const dayTravelUsed = new Map();   // `${userId}|${dayIso}` -> driving minutes only
  const dayKmUsed = new Map();       // `${userId}|${dayIso}` -> driving km only

  function budgetKey(u, d) { return `${u}|${d}`; }

  /**
   * Returns either an accepted fit (`{fromPrev, fromPrevKm, service, returnLeg, returnKm}`)
   * or a rejection (`{rejected: 'cap_exceeded'|'travel_cap_exceeded'|'km_cap_exceeded'}`).
   *
   * Caller pushes accepted stops to dayStops and rejections (with reason) to unassigned[].
   */
  function tryFit(u, dayIso, candidate, prevPoint) {
    const key = budgetKey(u.id, dayIso);
    const used = dayBudgetUsed.get(key) || 0;
    const usedTravel = dayTravelUsed.get(key) || 0;
    const usedKm = dayKmUsed.get(key) || 0;

    const cap = u.daily_minutes_cap || DEFAULT_DAILY_MINUTES_CAP;
    const travelCap = u.travel_minutes_cap != null ? Number(u.travel_minutes_cap) : DEFAULT_TRAVEL_MINUTES_CAP;
    const kmCap = u.daily_km_cap != null ? Number(u.daily_km_cap) : DEFAULT_DAILY_KM_CAP;
    const service = u.service_minutes_per_stop || DEFAULT_SERVICE_MINUTES;

    const home = (u.home_lat != null && u.home_lng != null)
      ? { lat: Number(u.home_lat), lng: Number(u.home_lng) }
      : null;
    const candPoint = { lat: Number(candidate.lat), lng: Number(candidate.lng) };

    const fromOrigin = prevPoint || home;
    const fromPrev = fromOrigin ? estimateMinutes(fromOrigin, candPoint) : 0;
    const fromPrevKm = fromOrigin ? haversineKm(fromOrigin, candPoint) * RETURN_LEG_HAVERSINE_FACTOR : 0;
    const returnLeg = home ? estimateMinutes(candPoint, home) : 0;
    const returnKm = home ? haversineKm(candPoint, home) * RETURN_LEG_HAVERSINE_FACTOR : 0;

    const optimisticTotal = used + fromPrev + service + returnLeg;
    if (optimisticTotal > cap) return { rejected: 'cap_exceeded' };

    if (ENABLE_CAP_VALIDATION) {
      const optimisticTravel = usedTravel + fromPrev + returnLeg;
      const optimisticKm = usedKm + fromPrevKm + returnKm;
      if (optimisticTravel > travelCap) return { rejected: 'travel_cap_exceeded' };
      if (optimisticKm > kmCap) return { rejected: 'km_cap_exceeded' };
    }

    return { fromPrev, fromPrevKm, service, returnLeg, returnKm };
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
      // Returns:
      //   true  → candidate accepted
      //   string → rejection reason ('cap_exceeded'|'travel_cap_exceeded'|'km_cap_exceeded')
      const fitOrUnassign = (candidate, kind) => {
        const fit = tryFit(u, dayIso, candidate, prevPoint);
        if (fit.rejected) return fit.rejected;
        dayStops.push({ ...candidate, __type: kind });
        if (kind === 'client') usedClients.add(candidate.id); else usedProspects.add(candidate.id);
        const key = budgetKey(u.id, dayIso);
        dayBudgetUsed.set(key, (dayBudgetUsed.get(key) || 0) + fit.fromPrev + fit.service);
        dayTravelUsed.set(key, (dayTravelUsed.get(key) || 0) + fit.fromPrev);
        dayKmUsed.set(key, (dayKmUsed.get(key) || 0) + fit.fromPrevKm);
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
          const result = fitOrUnassign(candidate, 'client');
          if (result === true) placed += 1;
          else {
            unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'marzam', reason: result, stop_id: candidate.id });
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
            if (fitOrUnassign(candidate, 'prospect') === true) placed += 1;
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
            const result = fitOrUnassign(candidate, 'prospect');
            if (result === true) placed += 1;
            else {
              unassigned.push({ user_id: u.id, day: dayIso, pareto, kind: 'prospecto', reason: result, stop_id: candidate.id });
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
 * Estimate total minutes a rep will spend on a given day given their stops.
 * Uses Haversine×1.4 / 22 km/h estimates — same proxy used by tryFit. We don't
 * fetch real matrices here because the balance step runs before sequencing.
 */
function estimateDayMinutes(rep, stops, paretoOverrides) {
  if (!stops.length) return 0;
  const home = (rep.home_lat != null && rep.home_lng != null)
    ? { lat: Number(rep.home_lat), lng: Number(rep.home_lng) } : null;
  if (!home) return 0;
  let total = 0;
  let prev = home;
  for (const s of stops) {
    const stopPoint = { lat: Number(s.lat), lng: Number(s.lng) };
    total += estimateMinutes(prev, stopPoint);
    total += resolveServiceMinutes(rep, s, paretoOverrides);
    prev = stopPoint;
  }
  total += estimateMinutes(prev, home); // return leg
  return total;
}

/**
 * Post-greedy balance step. Reduces the gap between max(end_min) and min(end_min)
 * across reps for each day by trying single-stop transfers from the longest rep
 * to the shortest rep when:
 *   - Both reps are clustered geographically (haversine(home_max, stop) is comparable
 *     to haversine(home_min, stop)).
 *   - The transfer reduces overall variance.
 *   - Neither rep ends up over their daily_minutes_cap.
 *
 * This is a heuristic — exact min-makespan is NP-hard. The aim is to absorb the
 * "rep1 done at 13:00, rep2 done at 17:00" syndrome that bare greedy produces.
 *
 * Mutates `assignmentMap` in place. Returns metrics for telemetry.
 */
function balanceByVarianceSwap({ assignmentMap, scopeUsers, paretoOverrides, days }) {
  if (!ENABLE_BALANCE_STEP) {
    return { enabled: false, swaps_attempted: 0, swaps_accepted: 0, gap_before: 0, gap_after: 0 };
  }
  const userById = new Map(scopeUsers.map((u) => [u.id, u]));
  const stats = {
    enabled: true, swaps_attempted: 0, swaps_accepted: 0,
    gap_before: 0, gap_after: 0,
    iterations: 0,
  };

  for (const day of days) {
    const dayIso = isoDate(day);
    const minutesByRep = new Map();
    for (const u of scopeUsers) {
      const stops = (assignmentMap.get(u.id) || new Map()).get(dayIso) || [];
      minutesByRep.set(u.id, estimateDayMinutes(u, stops, paretoOverrides));
    }
    const initialGap = Math.max(...minutesByRep.values()) - Math.min(...minutesByRep.values());
    stats.gap_before = Math.max(stats.gap_before, initialGap);

    if (initialGap <= BALANCE_GAP_THRESHOLD_MIN) continue;

    for (let iter = 0; iter < BALANCE_MAX_ITERATIONS; iter += 1) {
      stats.iterations += 1;
      // Sort users by current minutes desc (longest first) and asc (shortest first).
      const sorted = [...minutesByRep.entries()].sort((a, b) => b[1] - a[1]);
      const longest = sorted[0];
      const shortest = sorted[sorted.length - 1];
      const gap = longest[1] - shortest[1];
      if (gap <= BALANCE_GAP_THRESHOLD_MIN) break;

      const longRep = userById.get(longest[0]);
      const shortRep = userById.get(shortest[0]);
      const longStops = (assignmentMap.get(longRep.id) || new Map()).get(dayIso) || [];
      const shortHome = (shortRep.home_lat != null && shortRep.home_lng != null)
        ? { lat: Number(shortRep.home_lat), lng: Number(shortRep.home_lng) } : null;
      if (!shortHome) break;

      // Try each stop of longRep — score by potential variance reduction.
      let acceptedThisIter = 0;
      const candidates = longStops.slice().sort((a, b) => {
        // Prefer stops geographically closer to shortRep's home.
        const da = haversineKm(shortHome, { lat: Number(a.lat), lng: Number(a.lng) });
        const db = haversineKm(shortHome, { lat: Number(b.lat), lng: Number(b.lng) });
        return da - db;
      });
      for (const stop of candidates) {
        if (acceptedThisIter >= BALANCE_MAX_SWAPS_PER_ITER) break;
        stats.swaps_attempted += 1;

        // Simulate move.
        const newLongStops = longStops.filter((s) => s !== stop);
        const newShortStops = [...((assignmentMap.get(shortRep.id) || new Map()).get(dayIso) || []), stop];

        const newLongMin = estimateDayMinutes(longRep, newLongStops, paretoOverrides);
        const newShortMin = estimateDayMinutes(shortRep, newShortStops, paretoOverrides);
        const longCap = longRep.daily_minutes_cap || DEFAULT_DAILY_MINUTES_CAP;
        const shortCap = shortRep.daily_minutes_cap || DEFAULT_DAILY_MINUTES_CAP;

        if (newShortMin > shortCap) continue; // would blow short rep's cap
        if (newLongMin > longCap) continue;   // pathological
        const newGap = Math.abs(newLongMin - newShortMin);
        if (newGap >= gap) continue;

        // Accept swap.
        const longBucket = assignmentMap.get(longRep.id).get(dayIso);
        const shortBucket = assignmentMap.get(shortRep.id).get(dayIso) || [];
        const idx = longBucket.indexOf(stop);
        if (idx >= 0) longBucket.splice(idx, 1);
        shortBucket.push(stop);
        if (!assignmentMap.get(shortRep.id).has(dayIso)) {
          assignmentMap.get(shortRep.id).set(dayIso, shortBucket);
        }
        minutesByRep.set(longRep.id, newLongMin);
        minutesByRep.set(shortRep.id, newShortMin);
        stats.swaps_accepted += 1;
        acceptedThisIter += 1;
        // Re-sort longStops after removal.
        longStops.splice(longStops.indexOf(stop), 1);
      }

      if (acceptedThisIter === 0) break;  // no improvement possible at this iteration
    }

    const finalGap = Math.max(...minutesByRep.values()) - Math.min(...minutesByRep.values());
    stats.gap_after = Math.max(stats.gap_after, finalGap);
  }

  return stats;
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
async function sequenceAndMaterialize({
  scopeUsers, assignments, planConfig, mode = 'persist',
  coeffsByUserId = null, breakRulesByUserId = null, paretoOverrides = null,
}) {
  const rows = [];
  const totals = {
    total_drive_minutes: 0,
    total_service_minutes: 0,
    caution_arcs: 0,
    polyline_arcs: 0,
    last_leg_minutes_per_user: {},
    soft_window_violations: 0,
    soft_window_violation_count: 0,
    break_applied_per_user: {},
    break_skipped_per_user: {},
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

      // Holds polyline per (i,j) when fieldMask='with_polyline' returned them.
      let polylineMatrix = null;

      if (home && stopsWithCoords.length >= 2) {
        const points = [home, ...stopsWithCoords.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
        // PR6: when persisting AND ROUTES_INLINE_POLYLINE flag is on, we ask Google
        // for polylines inline. Avoids N×computeRoute calls per (rep,day).
        const wantsInlinePolyline = (mode === 'persist') && ENABLE_INLINE_POLYLINE;
        // PR6: when persisting AND PLAN_TRAFFIC_AWARE is on, switch to TRAFFIC_AWARE
        // for the publish-time matrix with the actual route start time of the day.
        // Preview iterations stay UNAWARE to keep the editor cheap.
        const matrixPref = (mode === 'persist' && ENABLE_TRAFFIC_AWARE_ON_PUBLISH)
          ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE';
        const departureTime = matrixPref === 'TRAFFIC_AWARE'
          ? localDayHHMMToUTC(dayIso, routeStartHHMM)
          : undefined;
        try {
          const matrixCall = wantsInlinePolyline
            ? routesMatrix.computeMatrixWithPolyline(points, points, {
                preference: matrixPref, departureTime, metricsSink: totals,
              })
            : routesMatrix.computeMatrixCached(points, points, {
                preference: matrixPref, departureTime, metricsSink: totals,
              });
          const matrix = await matrixCall;
          durationsMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(Infinity));
          if (wantsInlinePolyline) {
            polylineMatrix = Array.from({ length: points.length }, () => new Array(points.length).fill(null));
          }
          for (const r of matrix) {
            durationsMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
            if (polylineMatrix && r.polyline) polylineMatrix[r.originIndex][r.destinationIndex] = r.polyline;
          }
          totals.traffic_aware_used = totals.traffic_aware_used || (matrixPref === 'TRAFFIC_AWARE');
        } catch (err) {
          log.warn({ event: 'plan.matrix.failed', user_id: userId, day: dayIso, mode, err: err.message });
          durationsMatrix = null;
        }

        if (durationsMatrix) {
          stopsWithCoords.forEach((s, i) => { s.__seqIdx = i + 1; });
          const depotMarker = { __seqIdx: 0, lat: home.lat, lng: home.lng, __depot: true };
          const userCoeffs = coeffsByUserId ? coeffsByUserId.get(userId) : null;
          // distancesMatrix is null in this PR — matrix call only fetches durations.
          // PR6 (ROUTES_INLINE_POLYLINE) populates a parallel distance matrix.
          const costFn = buildCostFn(durationsMatrix, null, userCoeffs);

          // Feature flag PLAN_USE_OPTIMIZATION_API: si activo, intentamos
          // Google Route Optimization API antes del multiStartSolver clásico.
          // Si falla, log y caemos al solver actual sin cambios de comportamiento.
          let optimizerOrdered = null;
          if (process.env.PLAN_USE_OPTIMIZATION_API === 'true') {
            try {
              optimizerOrdered = await tryOptimizationApi({
                user: u, stops: stopsWithCoords, home,
                durationsMatrix, dayIso,
                paretoOverrides,
                routeStartHHMM,
              });
              if (optimizerOrdered) {
                totals.opt_api_runs = (totals.opt_api_runs || 0) + 1;
              }
            } catch (err) {
              log.warn({
                event: 'plan.opt_api.failed',
                user_id: userId, day: dayIso, n: stopsWithCoords.length,
                err: err.message,
              });
              optimizerOrdered = null;
            }
          }

          let solverResult;
          if (optimizerOrdered) {
            // Sintetizamos un solverResult con el shape que el resto del flujo
            // espera, marcando el "mode" para telemetría.
            solverResult = { ordered: optimizerOrdered, mode: 'optimization_api' };
          } else {
            solverResult = multiStartSolver.solve({
              depot: depotMarker,
              stops: stopsWithCoords,
              costFn,
              repId: userId,
              dayIso,
              deadline: Date.now() + SOLVER_DEADLINE_MS,
              strategy: SOLVER_STRATEGY,
            });
          }
          ordered = solverResult.ordered.map((s) => stopsWithCoords.find((x) => x.__seqIdx === s.__seqIdx)).filter(Boolean);

          // Audit Fix #6 — soft-window-aware post-pass.
          // Runs only when PLAN_SOFT_WINDOW_AWARE=true AND soft windows are
          // enabled. Default off (no behavior change). When on, swaps stops
          // to reduce opening-hours violations while capping drive growth at
          // 5%. See src/utils/softWindowSwap.js for full doc-block.
          let softWindowSwapStats = null;
          if (ENABLE_SOFT_WINDOW_SWAP && ENABLE_SOFT_WINDOWS && ordered.length >= 2) {
            const dayStartUtc = localDayHHMMToUTC(dayIso, routeStartHHMM);
            const swapResult = improveForSoftWindows({
              ordered,
              costMatrix: durationsMatrix,
              dayStart: dayStartUtc,
              serviceMinutesFor: (s) => resolveServiceMinutes(u, s, paretoOverrides),
              softWindowSlipSecondsFor: (s, arrival) => softWindowPenaltySeconds(s, arrival, dayIso),
            });
            ordered = swapResult.ordered;
            softWindowSwapStats = {
              accepted: swapResult.accepted,
              base_slip_seconds: Math.round(swapResult.baseSlipSeconds || 0),
              final_slip_seconds: Math.round(swapResult.finalSlipSeconds || 0),
              base_drive_seconds: Math.round(swapResult.baseDriveSeconds || 0),
              final_drive_seconds: Math.round(swapResult.finalDriveSeconds || 0),
            };
          }

          // Track solver telemetry per (rep, day) for metrics.solver.
          totals.solver_runs = totals.solver_runs || [];
          totals.solver_runs.push({
            user_id: userId,
            day: dayIso,
            n: stopsWithCoords.length,
            mode: solverResult.mode,
            tier: solverResult.strategy,
            seeds_tried: solverResult.seedsTried,
            kernels: solverResult.kernels,
            cost_seconds: Math.round(solverResult.totalCost),
            soft_window_swap: softWindowSwapStats,
          });
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

      // Lunch-break planning: before the walk, decide BEFORE which stop to insert the
      // break. Strategy: simulate the walk timeline; insert the break before the first
      // stop whose arrival would fall within (or after) the soft window (earliest..latest).
      // If we never reach the window naturally, hard_required breaks fire at the end of
      // the day with a metrics flag.
      const breakRules = breakRulesByUserId ? (breakRulesByUserId.get(userId) || []) : [];
      const lunchRule = breakRules.find((b) => b.kind === 'lunch') || null;
      let breakBeforeIdx = null;
      let breakDurationMin = 0;
      let breakStatus = null; // 'on_time' | 'late' | 'skipped'
      if (lunchRule) {
        breakDurationMin = lunchRule.duration_min;
        const earliestUtc = localDayHHMMToUTC(dayIso, String(lunchRule.earliest).slice(0, 5));
        const latestUtc = localDayHHMMToUTC(dayIso, String(lunchRule.latest).slice(0, 5));
        let simCursor = new Date(cursor);
        let simPrev = 0;
        for (let i = 0; i < ordered.length; i += 1) {
          const s = ordered[i];
          const seg = (durationsMatrix && s.__seqIdx != null && Number.isFinite(durationsMatrix[simPrev][s.__seqIdx]))
            ? durationsMatrix[simPrev][s.__seqIdx]
            : Math.round(haversineKm(home, { lat: Number(s.lat), lng: Number(s.lng) }) * RETURN_LEG_HAVERSINE_FACTOR / RETURN_LEG_KMH * 3600);
          simCursor = new Date(simCursor.getTime() + seg * 1000);
          if (simCursor >= earliestUtc) {
            breakBeforeIdx = i;
            breakStatus = simCursor <= latestUtc ? 'on_time' : 'late';
            break;
          }
          simCursor = new Date(simCursor.getTime() + resolveServiceMinutes(u, s, paretoOverrides) * 60 * 1000);
          simPrev = s.__seqIdx ?? 0;
        }
        if (breakBeforeIdx == null) {
          if (lunchRule.hard_required) {
            breakBeforeIdx = ordered.length; // end of day
            breakStatus = 'late';
          } else {
            breakStatus = 'skipped';
          }
        }
      }

      for (let i = 0; i < ordered.length; i += 1) {
        const s = ordered[i];

        // Apply lunch break before this stop if scheduled here.
        if (lunchRule && i === breakBeforeIdx && breakStatus !== 'skipped') {
          cursor = new Date(cursor.getTime() + breakDurationMin * 60 * 1000);
          totals.break_applied_per_user[userId] = (totals.break_applied_per_user[userId] || 0) + breakDurationMin;
        }

        const stopPoint = { lat: Number(s.lat), lng: Number(s.lng) };
        let travelSeconds = 0;
        let polyline = null;
        let crossesCaution = false;

        if (durationsMatrix && s.__seqIdx != null) {
          const ms = durationsMatrix[prevSeqIdx][s.__seqIdx];
          if (Number.isFinite(ms)) travelSeconds = ms;
        }

        if (mode === 'persist' && prevPoint) {
          // PR6: prefer polyline already shipped by the matrix call. Fall through
          // to per-arc computeRoute only when (a) polyline-in-matrix flag is OFF,
          // or (b) the matrix didn't return a polyline for this arc.
          let usedInline = false;
          if (polylineMatrix && s.__seqIdx != null) {
            const inline = polylineMatrix[prevSeqIdx][s.__seqIdx];
            if (inline) {
              polyline = inline;
              usedInline = true;
            }
          }
          if (!usedInline) {
            try {
              const route = await routesMatrix.computeRoute(prevPoint, stopPoint, { preference: 'TRAFFIC_UNAWARE' });
              if (route) {
                travelSeconds = route.durationSeconds || travelSeconds;
                polyline = route.polyline;
              }
            } catch (err) {
              log.warn({ event: 'plan.route.failed', user_id: userId, day: dayIso, err: err.message });
            }
          }
          if (polyline) {
            crossesCaution = await securityPolygons.polylineIntersectsCaution(polyline);
            if (crossesCaution) {
              travelSeconds = Math.round(travelSeconds * securityPolygons.CAUTION_PENALTY);
              totals.caution_arcs += 1;
            }
            totals.polyline_arcs += 1;
            // Even when usedInline=true the cache row for this geohash7 pair
            // may not yet have polyline if a prior preview-only matrix call
            // wrote a row without it. persistPolylineSafe ensures coverage.
            if (!usedInline) routesMatrix.persistPolylineSafe(prevPoint, stopPoint, polyline);
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

        // Soft window violation tracking. Metrics + per-row stamp here.
        // Reorder-aware path is the soft-window-swap pass above the
        // sequencing call (audit Fix #6, gated by PLAN_SOFT_WINDOW_AWARE).
        const stopServiceMin = resolveServiceMinutes(u, s, paretoOverrides);
        let softSlipMin = 0;
        if (ENABLE_SOFT_WINDOWS) {
          const penaltySec = softWindowPenaltySeconds(s, arrival, dayIso);
          if (penaltySec > 0) {
            softSlipMin = Math.round(penaltySec / SOFT_WINDOW_PENALTY_SEC_PER_MIN);
            totals.soft_window_violations += softSlipMin;
            totals.soft_window_violation_count += 1;
          }
        }

        cursor = new Date(cursor.getTime() + stopServiceMin * 60 * 1000);

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
          expected_service_minutes: stopServiceMin,
          polyline_to_next: null,
          // Preview-only fields (stripped before DB insert in generate()).
          lat: s.lat != null ? Number(s.lat) : null,
          lng: s.lng != null ? Number(s.lng) : null,
          farmacia_nombre: s.farmacia_nombre || null,
          cpadre: s.cpadre || null,
          pareto: s.pareto || null,
          __crossesCaution: crossesCaution,
          __softWindowSlipMin: softSlipMin,
        };
        dayRows.push(row);
        if (dayRows.length > 1) {
          dayRows[dayRows.length - 2].polyline_to_next = polyline;
        }
        totals.total_drive_minutes += travelMinutes;
        totals.total_service_minutes += stopServiceMin;
        prevPoint = stopPoint;
        prevSeqIdx = s.__seqIdx ?? 0;
        routeOrder += 1;
      }

      // Apply lunch break at end-of-day if scheduled there (hard_required and never
      // hit the window naturally).
      if (lunchRule && breakBeforeIdx === ordered.length && breakStatus !== 'skipped') {
        cursor = new Date(cursor.getTime() + breakDurationMin * 60 * 1000);
        totals.break_applied_per_user[userId] = (totals.break_applied_per_user[userId] || 0) + breakDurationMin;
      }
      if (lunchRule && breakStatus === 'skipped') {
        totals.break_skipped_per_user[userId] = (totals.break_skipped_per_user[userId] || 0) + 1;
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
    // is_global del JWT del actor. Cuando es true (admin / director_sucursal,
    // ver constants/roles.js#GLOBAL_ROLES), saltamos el check fila-por-fila de
    // canActorManage. Esto se alinea con el patrón usado en el resto del
    // codebase (visitSessions, analytics, alerts) donde `is_global` siempre
    // bypassea el scope check. Sin esto, un director con id virtual (UUID v5
    // del access directory, sin row en `users`) no puede planear NADA porque
    // canActorManage() no encuentra al actor en BD y devuelve false para
    // todos los targets.
    actorIsGlobal = false,
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
  // Global actors (admin / director_sucursal) bypass the per-row check, igual
  // que en visit-sessions / analytics / alerts (ver header del campo).
  if (!actorIsGlobal) {
    for (const sid of scopeUserIds) {
      if (sid === ownerUserId) continue;
      if (!await canActorManage(ownerUserId, sid)) {
        const err = new Error(`User ${ownerUserId} cannot generate plan for ${sid}`);
        err.status = 403; throw err;
      }
    }
  }

  // Defensive SELECT: migration 057 / 068 might not be applied. Fall back to
  // base columns and let the geo + cap logic degrade gracefully.
  // Columns from 057: home_lat, home_lng, daily_minutes_cap, service_minutes_per_stop
  // Columns from 068: travel_minutes_cap, daily_km_cap, preferred_travel_mode
  let scopeUsers;
  try {
    scopeUsers = await trx('users')
      .select('id', 'role', 'full_name', 'branch_id',
        'home_lat', 'home_lng', 'daily_minutes_cap', 'service_minutes_per_stop',
        'travel_minutes_cap', 'daily_km_cap', 'preferred_travel_mode')
      .whereIn('id', scopeUserIds)
      .andWhere({ is_active: true });
  } catch (err) {
    if (/column .* does not exist/.test(String(err.message || ''))) {
      log.warn({ event: 'plan.users.migration_pending', migrations: ['057', '068'], degraded: true });
      // Try 057-only fallback first.
      try {
        scopeUsers = (await trx('users')
          .select('id', 'role', 'full_name', 'branch_id',
            'home_lat', 'home_lng', 'daily_minutes_cap', 'service_minutes_per_stop')
          .whereIn('id', scopeUserIds)
          .andWhere({ is_active: true }))
          .map((u) => ({
            ...u,
            travel_minutes_cap: DEFAULT_TRAVEL_MINUTES_CAP,
            daily_km_cap: DEFAULT_DAILY_KM_CAP,
            preferred_travel_mode: 'DRIVE',
          }));
      } catch {
        scopeUsers = (await trx('users')
          .select('id', 'role', 'full_name', 'branch_id')
          .whereIn('id', scopeUserIds)
          .andWhere({ is_active: true }))
          .map((u) => ({
            ...u, home_lat: null, home_lng: null,
            daily_minutes_cap: DEFAULT_DAILY_MINUTES_CAP,
            service_minutes_per_stop: DEFAULT_SERVICE_MINUTES,
            travel_minutes_cap: DEFAULT_TRAVEL_MINUTES_CAP,
            daily_km_cap: DEFAULT_DAILY_KM_CAP,
            preferred_travel_mode: 'DRIVE',
          }));
      }
    } else { throw err; }
  }

  // Resolve cost coefficients for every user up front. coeffsByUserId is consumed
  // by sequenceAndMaterialize when building costFn, and snapshotted into metrics
  // so historical post-mortems use the values that were active at plan time.
  const coeffsByUserId = new Map();
  const breakRulesByUserId = new Map();
  await pMapBounded(scopeUsers, async (u) => {
    coeffsByUserId.set(u.id, await resolveCostCoeffs(trx, u));
    breakRulesByUserId.set(u.id, await loadBreakRules(trx, u));
  });
  const paretoOverrides = await loadParetoServiceOverrides(trx);
  // First-resolved coeff → snapshot. Mixed sources are rare (all users share role
  // or global), but log when we see >1 distinct source to make calibration drift visible.
  const coeffSources = new Set([...coeffsByUserId.values()].map((c) => c.source));
  if (coeffSources.size > 1) {
    log.warn({ event: 'plan.coeffs.mixed_sources', sources: [...coeffSources] });
  }

  // Resolve working days from the branch's plan_settings (mig 085). When
  // branchId is null, we keep legacy Mon-Fri behavior to preserve existing
  // contracts; new flows (replanWithHistory, visitPlans.service.publish) pass
  // branchId so Dom-Vie (or per-branch override) takes effect.
  const _bs = branchId ? await branchPlanSettings.get(branchId) : null;
  const workingDays = _bs?.working_days || LEGACY_WORKING_DAYS;
  const days = eachWorkingDay(
    new Date(`${periodStart}T00:00:00Z`),
    new Date(`${periodEnd}T00:00:00Z`),
    workingDays,
  );
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

  // PR7: post-greedy variance balancing. Mutates assignmentMap.
  const balanceStats = balanceByVarianceSwap({
    assignmentMap, scopeUsers, paretoOverrides, days,
  });

  const { rows: assignmentRows, totals } = await sequenceAndMaterialize({
    scopeUsers, assignments: assignmentMap, planConfig: { route_start_hhmm: routeStartHHMM },
    mode, coeffsByUserId, breakRulesByUserId, paretoOverrides,
  });

  // Diagnóstico de resolución de scope: el frontend manda IDs y el backend
  // los normaliza con accessDirectory.toCanonicalId, luego whereIn sobre users
  // filtra por is_active. Si los IDs canónicos no existen en `users` o están
  // inactivos, scopeUsers queda vacío y el plan no produce assignments. Sin
  // este metadata el toast del editor no podía distinguir "scope llegó vacío"
  // de "scope no se resolvió en BD".
  const resolvedUserIds = new Set(scopeUsers.map((u) => u.id));
  const unresolvedIds = (Array.isArray(scopeUserIds) ? scopeUserIds : [])
    .filter((id) => !resolvedUserIds.has(id))
    .slice(0, 10); // cap para no inflar response

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
    scope_resolution: {
      requested_count: Array.isArray(scopeUserIds) ? scopeUserIds.length : 0,
      resolved_count: scopeUsers.length,
      unresolved_sample: unresolvedIds,
    },
  };
  // Snapshot coefficients per-user so historical reports use the values that
  // were active at plan time (cost_coefficients edits don't retroactively change
  // post-mortem economics).
  const coeffsSnapshot = {};
  for (const [uid, c] of coeffsByUserId.entries()) {
    coeffsSnapshot[uid] = {
      source: c.source,
      alpha_duration: Number(c.alpha_duration),
      beta_distance: Number(c.beta_distance),
      cost_per_km: Number(c.cost_per_km),
      cost_per_hour: Number(c.cost_per_hour),
      fixed_cost_per_day: Number(c.fixed_cost_per_day || 0),
    };
  }

  // Solver summary: aggregate the per-(rep,day) solver runs into one snapshot.
  const solverRuns = totals.solver_runs || [];
  const tiersSeen = [...new Set(solverRuns.map((r) => r.tier))];
  const nMax = solverRuns.reduce((m, r) => Math.max(m, r.n), 0);
  const seedsAvg = solverRuns.length
    ? Math.round(solverRuns.reduce((s, r) => s + r.seeds_tried, 0) / solverRuns.length * 10) / 10
    : 0;

  const metrics = {
    total_drive_minutes: totals.total_drive_minutes,
    total_service_minutes: totals.total_service_minutes,
    caution_arcs: totals.caution_arcs,
    polyline_arcs: totals.polyline_arcs,
    unassigned_count: unassigned.length,
    assignments_count: assignmentRows.length,
    last_leg_minutes_per_user: totals.last_leg_minutes_per_user,
    coeffs_snapshot: coeffsSnapshot,
    soft_window_violations: totals.soft_window_violations,
    soft_window_violation_count: totals.soft_window_violation_count,
    break_applied_per_user: totals.break_applied_per_user,
    break_skipped_per_user: totals.break_skipped_per_user,
    solver: {
      strategy: SOLVER_STRATEGY,
      tiers_seen: tiersSeen,
      n_max_per_route: nMax,
      seeds_avg: seedsAvg,
      runs: solverRuns.length,
    },
    cost_breakdown: {
      fresh: totals.fresh || 0,
      cached: totals.cached || 0,
      estimated_fallback: totals.estimated || 0,
      traffic_aware_used: !!totals.traffic_aware_used,
      polyline_in_matrix: ENABLE_INLINE_POLYLINE,
    },
    balance: {
      ...balanceStats,
      gap_threshold_min: BALANCE_GAP_THRESHOLD_MIN,
    },
    flags: {
      cost_coeffs: ENABLE_COST_COEFFS,
      cap_validation: ENABLE_CAP_VALIDATION,
      breaks: ENABLE_BREAKS,
      soft_windows: ENABLE_SOFT_WINDOWS,
      pareto_service: ENABLE_PARETO_SERVICE,
      solver: SOLVER_STRATEGY,
      inline_polyline: ENABLE_INLINE_POLYLINE,
      traffic_aware_publish: ENABLE_TRAFFIC_AWARE_ON_PUBLISH,
      balance: ENABLE_BALANCE_STEP,
    },
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
  buildPlan,
  DB_ASSIGNMENT_COLS,
  PARETO_CLASSES,
  PROSPECTO_PARETO_CLASSES,
  ROLE_PRIMARY_PARETO,
  // exported for tests + downstream tooling.
  tryOptimizationApi,
  paretoPenalty,
};
