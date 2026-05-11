/**
 * Routes API — driving-time matrix service.
 *
 * Single point of contact between Marzam and Google's Routes API. The rest of
 * the codebase calls `computeMatrixCached(origins, destinations, opts)` and
 * never sees raw HTTP. The service:
 *
 *   1) Looks up each origin × destination pair in `route_matrix_cache`
 *      keyed by (geohash7, geohash7, hour_bucket, day_type, routing_preference).
 *   2) For uncached pairs, batches into ≤625-element calls to
 *      `:computeRouteMatrix` and writes the responses back to cache with
 *      a 7-day TTL.
 *   3) On Routes API failure (network / quota / ROUTE_NOT_FOUND), falls back
 *      to a Haversine × 1.4 estimate (corrects roughly for road-vs-air ratio
 *      in CDMX) and marks the result with `flag='estimated'` so callers can
 *      choose to skip those pairs in critical decisions.
 *
 * SKU choice (per memory and Marzam Execution Doc §10.3):
 *   - TRAFFIC_UNAWARE  → SKU Essentials ($5/1k). Used for weekly mass planning.
 *   - TRAFFIC_AWARE    → SKU Pro ($10/1k). Used for day-of sequencing only.
 *
 * Field mask is the cheapest possible: originIndex, destinationIndex, duration,
 * distanceMeters, condition. We deliberately do NOT request `polyline` here —
 * polylines are fetched per-arc with `computeRoute()` only for the final chosen
 * arcs of the published plan, to keep matrix calls in the Essentials SKU.
 */

const db = require('../config/database');
const config = require('../config');
const { encode: geohashEncode } = require('../utils/geohash');
const log = require('../utils/logger');

// [P10] Lifetime aggregated counters so /api/admin/cockpit/routes-matrix-stats
// can report the cache hit rate without scrubbing logs. Reset on process boot
// (Vercel cold start), so an admin observing the value sees roughly the
// throughput since the last cold-start. Per-instance — won't be globally
// accurate across N concurrent Vercel instances, but good enough for trend.
const _stats = Object.seal({
  matrix_calls: 0,
  pairs_total: 0,
  pairs_cached: 0,
  pairs_fresh: 0,
  pairs_estimated: 0,
  api_calls: 0,
  api_failures: 0,
  fallback_haversine: 0,
  started_at: new Date().toISOString(),
});

function getStats() {
  const total = _stats.pairs_total || 1;
  return {
    ..._stats,
    cache_hit_rate: _stats.pairs_cached / total,
    estimated_rate: _stats.pairs_estimated / total,
  };
}

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTE_ENDPOINT  = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,condition';
// PR6: when the caller asks for polylines inline (mode='persist' on publish),
// we add `polyline.encodedPolyline` to the mask. This costs the same SKU as
// the basic field mask per Google docs (Routes Matrix doesn't ladder the SKU
// based on this single field). Validated empirically before enabling in prod.
const MATRIX_FIELD_MASK_WITH_POLYLINE = `${MATRIX_FIELD_MASK},polyline.encodedPolyline`;
const ROUTE_FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';

const MAX_ELEMENTS_PER_CALL = 625;
const CACHE_TTL_DAYS = 7;
const HAVERSINE_CORRECTION = 1.4;       // road km / air km in CDMX (rough)
const FALLBACK_KMH = 22;                // average driving speed when estimating

// SKU pricing (Routes API, USD per 1000 elements/calls).
const SKU_PRICE = {
  TRAFFIC_UNAWARE: 5,   // Essentials
  TRAFFIC_AWARE: 10,    // Pro
  ROUTE_SINGLE: 5,      // Essentials
};
const DEFAULT_DAILY_BUDGET_USD = Number(process.env.ROUTES_API_DAILY_BUDGET_USD) || 50;

// Custom error so the API can return 429 cleanly.
class RoutesBudgetExceededError extends Error {
  constructor(spent, budget) {
    super(`Routes API daily budget exceeded ($${spent.toFixed(2)} / $${budget.toFixed(2)})`);
    this.code = 'routes_budget_exceeded';
    this.status = 429;
    this.spent_usd = spent;
    this.budget_usd = budget;
  }
}

// ─── hour bucket discretization ─────────────────────────────────────────
//   0=valle (10-13h, 21-7h), 1=pico-am (8-10h),
//   2=pico-pm (17-20h),       3=mid-pm (13-17h)
function hourBucket(date) {
  const h = date.getHours();
  if (h >= 8 && h < 10) return 1;
  if (h >= 17 && h < 20) return 2;
  if (h >= 13 && h < 17) return 3;
  return 0;
}

function dayType(date) {
  return date.getDay() === 6 ? 1 : 0;
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

// ─── budget tracking ────────────────────────────────────────────────────

/**
 * Read today's spend (or {0,0,0} when no row exists). Day key is UTC date.
 */
async function getDailyBudgetStatus() {
  const row = await db('routes_api_spend')
    .where('day', db.raw("CURRENT_DATE AT TIME ZONE 'UTC'"))
    .first();
  const spent = Number(row?.est_cost_usd || 0);
  const budget = DEFAULT_DAILY_BUDGET_USD;
  return {
    day: row?.day || new Date().toISOString().slice(0, 10),
    spent_usd: spent,
    budget_usd: budget,
    remaining_usd: Math.max(0, budget - spent),
    matrix_calls: row?.matrix_calls || 0,
    matrix_elements: row?.matrix_elements || 0,
    route_calls: row?.route_calls || 0,
    rejected_calls: row?.rejected_calls || 0,
  };
}

/**
 * Atomically reserve `addCostUsd` against today's budget. Throws
 * `RoutesBudgetExceededError` (HTTP 429) when the reservation would push us
 * over the daily limit, otherwise pre-records the estimated cost so concurrent
 * callers see the deduction immediately.
 *
 * Concurrency: the read-check-write sequence runs inside a single
 * `db.transaction` guarded by `pg_advisory_xact_lock(<day>)`. The lock is
 * scoped to today's UTC date — different days don't contend, but every
 * caller in the same UTC day serializes through the same key. This closes
 * the TOCTOU window where N parallel matrix calls could each see "$49.99
 * spent" and all proceed.
 *
 * Settlement: the actual cost is recorded later via `recordSpend()`, which
 * uses the SAME advisory lock so reservations and settlements never
 * interleave.
 */
function dayLockKey() {
  // Postgres advisory lock takes a bigint. Use today's UTC date as YYYYMMDD
  // and arrange so two different process instances on the same day collide.
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

async function assertWithinBudget(addCostUsd) {
  const lockKey = dayLockKey();
  // Two-phase to keep the rejected_calls counter visible even when the
  // outer trx rolls back due to throw:
  //   Phase 1 (this trx, lock held): read budget, decide reject vs accept.
  //     - Accept: pre-record reservation in the same trx, commit, return.
  //     - Reject: commit cleanly (no writes), then phase 2 records the
  //       rejection counter in a separate trx, then throw.
  let rejectAt = null;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [lockKey]);
    const row = await trx('routes_api_spend')
      .where('day', trx.raw("CURRENT_DATE AT TIME ZONE 'UTC'"))
      .first();
    const spent = Number(row?.est_cost_usd || 0);
    if (spent + addCostUsd > DEFAULT_DAILY_BUDGET_USD) {
      // Stage the reject info; we'll record + throw outside the trx so the
      // counter increment isn't rolled back along with this trx body.
      rejectAt = spent;
      return;
    }
    // Pre-record the estimated cost so concurrent callers see the
    // deduction. Settlement (recordSpend below) corrects the delta against
    // the actual cost on success.
    await trx.raw(`
      INSERT INTO routes_api_spend (day, est_cost_usd, first_call_at, last_call_at)
      VALUES (CURRENT_DATE, ?, NOW(), NOW())
      ON CONFLICT (day) DO UPDATE
        SET est_cost_usd = routes_api_spend.est_cost_usd + EXCLUDED.est_cost_usd,
            last_call_at = NOW()
    `, [addCostUsd]);
  });

  if (rejectAt !== null) {
    // Phase 2: persist the rejection counter in its own trx (not under the
    // advisory lock — we don't need exclusivity for a counter increment;
    // ON CONFLICT serializes adequately on the conflict target). Best-
    // effort: a counter write failure must not mask the budget error.
    try {
      await db.raw(`
        INSERT INTO routes_api_spend (day, rejected_calls)
        VALUES (CURRENT_DATE, 1)
        ON CONFLICT (day) DO UPDATE
          SET rejected_calls = routes_api_spend.rejected_calls + 1,
              last_call_at = NOW()
      `);
    } catch (err) {
      log.warn({ event: 'routes.rejected_counter.failed', err: err.message });
    }
    throw new RoutesBudgetExceededError(rejectAt, DEFAULT_DAILY_BUDGET_USD);
  }
}

/**
 * Settlement: increment counters AND apply (estimate - actual) delta to
 * `est_cost_usd`. Reservation already ran in `assertWithinBudget`, so this
 * step does NOT add the full cost again — it only corrects for the
 * difference between the estimate and the actual SKU bill (almost always
 * zero or negative because estimates are pessimistic).
 *
 * Takes the same advisory lock as `assertWithinBudget` so concurrent
 * settlements don't race on the est_cost_usd column.
 */
async function recordSpend({
  matrixCalls = 0, matrixElements = 0, routeCalls = 0,
  sku = 'TRAFFIC_UNAWARE', estimatedReservedUsd = null,
}) {
  const matrixCost = (matrixElements / 1000) * (SKU_PRICE[sku] || SKU_PRICE.TRAFFIC_UNAWARE);
  const routeCost = (routeCalls / 1000) * SKU_PRICE.ROUTE_SINGLE;
  const actualCost = +(matrixCost + routeCost).toFixed(4);
  if (actualCost === 0 && matrixCalls === 0 && routeCalls === 0) return;

  // Delta against the reservation. If estimatedReservedUsd is null (legacy
  // callers pre-#7-fix), behave as before and add the full cost.
  const delta = estimatedReservedUsd != null
    ? +(actualCost - estimatedReservedUsd).toFixed(4)
    : actualCost;

  const lockKey = dayLockKey();
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [lockKey]);
    await trx.raw(`
      INSERT INTO routes_api_spend (day, matrix_calls, matrix_elements, route_calls, est_cost_usd, first_call_at, last_call_at)
      VALUES (CURRENT_DATE, ?, ?, ?, ?, NOW(), NOW())
      ON CONFLICT (day) DO UPDATE
        SET matrix_calls    = routes_api_spend.matrix_calls    + EXCLUDED.matrix_calls,
            matrix_elements = routes_api_spend.matrix_elements + EXCLUDED.matrix_elements,
            route_calls     = routes_api_spend.route_calls     + EXCLUDED.route_calls,
            est_cost_usd    = routes_api_spend.est_cost_usd    + EXCLUDED.est_cost_usd,
            last_call_at    = NOW()
    `, [matrixCalls, matrixElements, routeCalls, delta]);
  });
}

function fallbackEstimate(origin, dest) {
  const km = haversineKm(origin, dest) * HAVERSINE_CORRECTION;
  const seconds = Math.round((km / FALLBACK_KMH) * 3600);
  return {
    durationSeconds: seconds,
    distanceMeters: Math.round(km * 1000),
    flag: 'estimated',
  };
}

// ─── cache ──────────────────────────────────────────────────────────────
async function readCache(pairs, { hourBucketValue, dayTypeValue, preference }) {
  if (!pairs.length) return new Map();
  // Build a CTE of requested pairs and left-join to cache. Faster than 1
  // query per pair on a typical N=100×100 plan generation.
  // NOTE: knex 3.x does not understand `$N` positional placeholders when an
  // array is also passed — it scans the SQL for placeholders and counts both
  // styles, then errors with "Expected N bindings, saw 0". Use `?` instead.
  const params = [];
  const placeholders = pairs.map(({ originGh, destGh }) => {
    params.push(originGh, destGh);
    return '(?::char(7), ?::char(7))';
  }).join(',');
  // hourBucketValue, dayTypeValue and preference are server-controlled enums —
  // safe to inline. (Preference is validated via the SKU_PRICE map upstream.)
  const sql = `
    WITH wanted (origin_geohash7, dest_geohash7) AS (VALUES ${placeholders})
    SELECT w.origin_geohash7, w.dest_geohash7,
           c.duration_seconds, c.distance_meters, c.polyline
    FROM wanted w
    LEFT JOIN route_matrix_cache c
      ON c.origin_geohash7 = w.origin_geohash7
     AND c.dest_geohash7  = w.dest_geohash7
     AND c.hour_bucket    = ${Number(hourBucketValue)}
     AND c.day_type       = ${Number(dayTypeValue)}
     AND c.routing_preference = '${String(preference).replace(/'/g, "''")}'
     AND c.expires_at > NOW()
  `;
  const result = await db.raw(sql, params);
  const map = new Map();
  for (const row of result.rows) {
    const key = `${row.origin_geohash7}|${row.dest_geohash7}`;
    if (row.duration_seconds != null) {
      map.set(key, {
        durationSeconds: row.duration_seconds,
        distanceMeters: row.distance_meters,
        polyline: row.polyline,
        flag: 'cached',
      });
    }
  }
  return map;
}

async function writeCache(rows, { hourBucketValue, dayTypeValue, preference }) {
  if (!rows.length) return;
  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 3600 * 1000);
  const inserts = rows.map((r) => ({
    origin_geohash7: r.originGh,
    dest_geohash7: r.destGh,
    hour_bucket: hourBucketValue,
    day_type: dayTypeValue,
    routing_preference: preference,
    duration_seconds: r.durationSeconds,
    distance_meters: r.distanceMeters,
    polyline: r.polyline || null,
    expires_at: expiresAt,
  }));
  await db('route_matrix_cache')
    .insert(inserts)
    .onConflict(['origin_geohash7', 'dest_geohash7', 'hour_bucket', 'day_type', 'routing_preference'])
    .merge(['duration_seconds', 'distance_meters', 'polyline', 'computed_at', 'expires_at']);
}

// ─── Google API ─────────────────────────────────────────────────────────
function buildWaypoint({ lat, lng }) {
  return { waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } };
}

async function callRoutesMatrixApi(origins, destinations, opts = {}) {
  const { preference = 'TRAFFIC_UNAWARE', departureTime, fieldMask = 'basic' } = opts;
  const apiKey = config.google.mapsApiKey;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  // PR6 invariant: TRAFFIC_AWARE without departureTime is meaningless and Google
  // bills it as Pro tier anyway. Throw to prevent silent waste.
  if (preference === 'TRAFFIC_AWARE' && !departureTime) {
    const err = new Error('TRAFFIC_AWARE matrix call requires opts.departureTime');
    err.code = 'invalid_traffic_aware_call';
    throw err;
  }

  // Cost guard: estimate this call's cost before it goes out.
  const elements = origins.length * destinations.length;
  const estCost = (elements / 1000) * (SKU_PRICE[preference] || SKU_PRICE.TRAFFIC_UNAWARE);
  await assertWithinBudget(estCost);

  const body = {
    origins: origins.map(buildWaypoint),
    destinations: destinations.map(buildWaypoint),
    travelMode: 'DRIVE',
    routingPreference: preference,
  };
  if (preference === 'TRAFFIC_AWARE' && departureTime) {
    body.departureTime = departureTime.toISOString();
  }

  const mask = fieldMask === 'with_polyline' ? MATRIX_FIELD_MASK_WITH_POLYLINE : MATRIX_FIELD_MASK;

  const res = await fetch(ROUTES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': mask,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Routes API matrix failed: ${res.status} ${text.slice(0, 240)}`);
    err.status = res.status;
    err.code = 'routes_api_error';
    throw err;
  }
  const json = await res.json();
  // Record actual spend (best-effort — don't fail call if recording fails).
  recordSpend({
    matrixCalls: 1,
    matrixElements: elements,
    sku: preference,
  }).catch((e) => log.warn({ event: 'routes.recordSpend.failed', source: 'matrix', err: e.message }));
  // Response is a flat array of { originIndex, destinationIndex, ... }.
  return Array.isArray(json) ? json : [];
}

// ─── public API ─────────────────────────────────────────────────────────

/**
 * Compute (origin → destination) matrix without cache.
 *
 * @param {Array<{lat:number,lng:number}>} origins
 * @param {Array<{lat:number,lng:number}>} destinations
 * @param {{preference?:'TRAFFIC_AWARE'|'TRAFFIC_UNAWARE',departureTime?:Date}} [opts]
 * @returns {Promise<Array<{originIndex:number,destinationIndex:number,durationSeconds:number,distanceMeters:number,flag?:string}>>}
 */
async function computeMatrix(origins, destinations, opts = {}) {
  if (!origins.length || !destinations.length) return [];
  const elementCount = origins.length * destinations.length;
  if (elementCount > MAX_ELEMENTS_PER_CALL) {
    // Split destinations into chunks; origins stay whole to keep originIndex stable.
    const out = [];
    const chunkDests = Math.max(1, Math.floor(MAX_ELEMENTS_PER_CALL / Math.max(1, origins.length)));
    for (let i = 0; i < destinations.length; i += chunkDests) {
      const slice = destinations.slice(i, i + chunkDests);
      const partial = await computeMatrix(origins, slice, opts);
      for (const p of partial) {
        out.push({ ...p, destinationIndex: p.destinationIndex + i });
      }
    }
    return out;
  }

  try {
    const raw = await callRoutesMatrixApi(origins, destinations, opts);
    return raw.map((r) => {
      // duration looks like "1234s" or { seconds: 1234 } depending on encoding.
      const dur = typeof r.duration === 'string'
        ? Number(r.duration.replace(/s$/, ''))
        : (r.duration?.seconds ?? 0);
      return {
        originIndex: r.originIndex ?? 0,
        destinationIndex: r.destinationIndex ?? 0,
        durationSeconds: dur,
        distanceMeters: r.distanceMeters ?? 0,
        condition: r.condition,
        polyline: r.polyline?.encodedPolyline ?? null,
      };
    });
  } catch (err) {
    // Caller-error invariants must NOT silently degrade to Haversine — they are
    // bugs in the caller. Surface them so the SLA alert / oncall can react.
    if (err && (err.code === 'invalid_traffic_aware_call' || err.code === 'routes_budget_exceeded')) {
      throw err;
    }
    log.warn({ event: 'routes.matrix.fallback_haversine', origins: origins.length, dests: destinations.length, err: err.message });
    const out = [];
    for (let i = 0; i < origins.length; i += 1) {
      for (let j = 0; j < destinations.length; j += 1) {
        const est = fallbackEstimate(origins[i], destinations[j]);
        out.push({ originIndex: i, destinationIndex: j, ...est });
      }
    }
    return out;
  }
}

/**
 * Cached matrix lookup. Idempotent under the same hour_bucket/day_type/preference.
 *
 * Returns a flat list of results aligned with the (origin,destination) pairs.
 * Each result includes `flag` ∈ {'cached','fresh','estimated'} so callers can
 * gate critical decisions on data quality.
 */
async function computeMatrixCached(origins, destinations, opts = {}) {
  if (!origins.length || !destinations.length) return [];
  _stats.matrix_calls += 1;
  const departureTime = opts.departureTime || new Date();
  const preference = opts.preference || 'TRAFFIC_UNAWARE';
  const fieldMask = opts.fieldMask || 'basic';
  const wantsPolyline = fieldMask === 'with_polyline';
  // Optional sink populated by caller to count cache hit/miss for the metrics chip.
  const sink = opts.metricsSink || null;
  const hourBucketValue = hourBucket(departureTime);
  const dayTypeValue = dayType(departureTime);

  // Geohash both ends.
  const originGh = origins.map((o) => geohashEncode(o.lat, o.lng, 7));
  const destGh = destinations.map((d) => geohashEncode(d.lat, d.lng, 7));

  // De-dup: when two stops share the same geohash7 cell, they share the same
  // cache entry — we only ask Google once per unique pair.
  const uniquePairs = new Map(); // key origin|dest -> {originGh,destGh, originLatLng, destLatLng}
  const pairToKey = []; // index -> "originGh|destGh"
  for (let i = 0; i < origins.length; i += 1) {
    for (let j = 0; j < destinations.length; j += 1) {
      if (!originGh[i] || !destGh[j]) continue;
      const key = `${originGh[i]}|${destGh[j]}`;
      pairToKey.push({ i, j, key });
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, {
          originGh: originGh[i],
          destGh: destGh[j],
          originLatLng: origins[i],
          destLatLng: destinations[j],
        });
      }
    }
  }

  // 1) Cache lookup.
  const cacheMap = await readCache([...uniquePairs.values()], { hourBucketValue, dayTypeValue, preference });

  // 2) Detect uncached pairs. When fieldMask='with_polyline' we also treat
  //    rows that have duration but no polyline as effectively uncached (we'll
  //    re-fetch with the polyline-bearing field mask). Caller pays SKU once;
  //    next callers benefit from polyline being persisted.
  const uncached = [];
  for (const [key, pair] of uniquePairs.entries()) {
    const cached = cacheMap.get(key);
    if (!cached) uncached.push({ key, ...pair });
    else if (wantsPolyline && !cached.polyline) uncached.push({ key, ...pair, __polylineRefetch: true });
  }

  // 3) Call Routes API (or fallback) on the uncached subset.
  if (uncached.length) {
    // Build positional uniqueOrigin/uniqueDest lists keeping mapping back.
    const uniqOrigins = [];
    const uniqDests = [];
    const oIdx = new Map();
    const dIdx = new Map();
    for (const p of uncached) {
      if (!oIdx.has(p.originGh)) {
        oIdx.set(p.originGh, uniqOrigins.length);
        uniqOrigins.push(p.originLatLng);
      }
      if (!dIdx.has(p.destGh)) {
        dIdx.set(p.destGh, uniqDests.length);
        uniqDests.push(p.destLatLng);
      }
    }
    const matrix = await computeMatrix(uniqOrigins, uniqDests, { preference, departureTime, fieldMask });

    // Build a lookup uniqueOrigin × uniqueDest → result.
    const resultByOD = new Map();
    for (const r of matrix) {
      resultByOD.set(`${r.originIndex}|${r.destinationIndex}`, r);
    }

    const toCache = [];
    for (const p of uncached) {
      const oi = oIdx.get(p.originGh);
      const di = dIdx.get(p.destGh);
      const r = resultByOD.get(`${oi}|${di}`);
      if (!r) continue;
      const entry = {
        durationSeconds: r.durationSeconds,
        distanceMeters: r.distanceMeters,
        polyline: r.polyline || null,
        flag: r.flag === 'estimated' ? 'estimated' : 'fresh',
      };
      cacheMap.set(p.key, entry);
      if (entry.flag === 'fresh') {
        toCache.push({
          originGh: p.originGh,
          destGh: p.destGh,
          durationSeconds: entry.durationSeconds,
          distanceMeters: entry.distanceMeters,
          polyline: entry.polyline,
        });
      }
    }
    if (toCache.length) {
      try {
        await writeCache(toCache, { hourBucketValue, dayTypeValue, preference });
      } catch (err) {
        log.warn({ event: 'routes.cache.write_failed', err: err.message });
      }
    }
  }

  // 4) Project results back to the requested (i, j) shape.
  const out = [];
  for (const { i, j, key } of pairToKey) {
    const r = cacheMap.get(key);
    if (r) {
      // [P10] global stats aggregation — same flag taxonomy as the per-call sink.
      _stats.pairs_total += 1;
      if (r.flag === 'cached') _stats.pairs_cached += 1;
      else if (r.flag === 'estimated') _stats.pairs_estimated += 1;
      else _stats.pairs_fresh += 1;
      if (sink) {
        if (r.flag === 'cached') sink.cached = (sink.cached || 0) + 1;
        else if (r.flag === 'estimated') sink.estimated = (sink.estimated || 0) + 1;
        else sink.fresh = (sink.fresh || 0) + 1;
      }
      out.push({
        originIndex: i,
        destinationIndex: j,
        durationSeconds: r.durationSeconds,
        distanceMeters: r.distanceMeters,
        polyline: r.polyline || null,
        flag: r.flag,
      });
    } else {
      // No cache, no fresh result: use Haversine fallback to keep planGenerator deterministic.
      const est = fallbackEstimate(origins[i], destinations[j]);
      if (sink) sink.estimated = (sink.estimated || 0) + 1;
      out.push({ originIndex: i, destinationIndex: j, ...est });
    }
  }
  return out;
}

/**
 * Convenience wrapper for callers that want polylines inline (publish path).
 * Sets `fieldMask='with_polyline'` so cache rows missing polyline trigger a
 * re-fetch with the polyline-bearing mask.
 *
 * SKU note: Google's Routes Matrix bills per element, not per field. Adding
 * `polyline.encodedPolyline` does NOT escalate the SKU as of the 2026 docs.
 * Validate empirically (cron `routes_api_spend` should not double after the
 * flag is enabled).
 */
async function computeMatrixWithPolyline(origins, destinations, opts = {}) {
  return computeMatrixCached(origins, destinations, { ...opts, fieldMask: 'with_polyline' });
}

/**
 * Read snapshot of matrix breakdown captured by metricsSink.
 * Caller pattern:
 *   const sink = { fresh: 0, cached: 0, estimated: 0 };
 *   await computeMatrixCached(..., { metricsSink: sink });
 *   const breakdown = getMatrixBreakdown(sink);
 */
function getMatrixBreakdown(sink) {
  if (!sink) return { fresh: 0, cached: 0, estimated: 0, total: 0 };
  const fresh = sink.fresh || 0;
  const cached = sink.cached || 0;
  const estimated = sink.estimated || 0;
  return { fresh, cached, estimated, total: fresh + cached + estimated };
}

/**
 * Single-arc route with polyline. Used after planGenerator picks the final
 * sequence to materialize `polyline_to_next` and to test caution polygons.
 *
 * @param {{lat,lng}} origin
 * @param {{lat,lng}} destination
 */
async function computeRoute(origin, destination, opts = {}) {
  const apiKey = config.google.mapsApiKey;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  const preference = opts.preference || 'TRAFFIC_UNAWARE';
  // Cost guard: a single call costs ~$0.005 ($5/1000) but if we're at limit
  // we still reject so we don't sneak past with arc-by-arc small calls.
  await assertWithinBudget(SKU_PRICE.ROUTE_SINGLE / 1000);
  const body = {
    origin: buildWaypoint(origin),
    destination: buildWaypoint(destination),
    travelMode: 'DRIVE',
    routingPreference: preference,
    polylineQuality: 'OVERVIEW',
  };
  if (preference === 'TRAFFIC_AWARE' && opts.departureTime) {
    body.departureTime = opts.departureTime.toISOString();
  }
  const res = await fetch(ROUTE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': ROUTE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Routes API single failed: ${res.status} ${text.slice(0, 240)}`);
  }
  recordSpend({ routeCalls: 1, sku: preference }).catch((e) => log.warn({ event: 'routes.recordSpend.failed', source: 'route_single', err: e.message }));
  const json = await res.json();
  const route = json.routes?.[0];
  if (!route) return null;
  const dur = typeof route.duration === 'string'
    ? Number(route.duration.replace(/s$/, ''))
    : (route.duration?.seconds ?? 0);
  return {
    durationSeconds: dur,
    distanceMeters: route.distanceMeters ?? 0,
    polyline: route.polyline?.encodedPolyline ?? null,
  };
}

/**
 * Store the polyline of a single arc in the cache so future matrix lookups
 * for the same geohash7 pair pick it up. Cheap, idempotent.
 *
 * Direct version — throws on failure. Use `persistPolylineSafe` from hot
 * paths so a transient DB failure doesn't break a plan generation.
 */
async function persistPolyline(originLatLng, destLatLng, polyline, opts = {}) {
  const departureTime = opts.departureTime || new Date();
  const preference = opts.preference || 'TRAFFIC_UNAWARE';
  const originGh = geohashEncode(originLatLng.lat, originLatLng.lng, 7);
  const destGh = geohashEncode(destLatLng.lat, destLatLng.lng, 7);
  if (!originGh || !destGh) return;
  await db('route_matrix_cache')
    .where({
      origin_geohash7: originGh,
      dest_geohash7: destGh,
      hour_bucket: hourBucket(departureTime),
      day_type: dayType(departureTime),
      routing_preference: preference,
    })
    .update({ polyline });
}

/**
 * Fire-and-retry-once wrapper. Used by planGenerator from inside the
 * sequencing loop where a transient DB hiccup shouldn't tank the plan.
 * Logs once to warn if the second attempt also fails.
 */
function persistPolylineSafe(originLatLng, destLatLng, polyline, opts = {}) {
  setImmediate(async () => {
    try {
      await persistPolyline(originLatLng, destLatLng, polyline, opts);
    } catch {
      // One retry after 250ms, then warn and drop.
      setTimeout(async () => {
        try { await persistPolyline(originLatLng, destLatLng, polyline, opts); }
        catch (err2) {
          log.warn({ event: 'routes.polyline.persist_failed_after_retry', err: err2.message });
        }
      }, 250);
    }
  });
}

async function purgeExpired() {
  // Use the actual `expires_at` column (TTL = 7 days). A separate weekly
  // backstop deletes rows older than 30 days regardless, to satisfy Google
  // ToS on derived lat/lng caches.
  const result = await db('route_matrix_cache')
    .whereRaw('expires_at < NOW()')
    .del();
  const backstop = await db('route_matrix_cache')
    .whereRaw("computed_at < NOW() - INTERVAL '30 days'")
    .del();
  return { deleted_expired: result, deleted_backstop: backstop };
}

/**
 * Convierte una matriz raw del response de Google (array de
 * { originIndex, destinationIndex, durationSeconds, distanceMeters? }) en dos
 * matrices 2D NxN listas para inyectar en Google Route Optimization API.
 *
 * Si la matriz raw no incluye `distanceMeters` (la versión current solo pide
 * duration), aplicamos fallback Haversine × HAVERSINE_CORRECTION para llenar
 * la distance matrix — Optimization API exige ambas, y es preferible una
 * aproximación a fallar la llamada.
 *
 * Inputs:
 *   - points: array [depot, stop1, stop2, ...] de { lat, lng }.
 *   - rawMatrix: array opcional ya devuelto por computeMatrixCached. Si null,
 *     hace fetch en this call usando los mismos defaults.
 *
 * Output: { durationMatrix: number[][], distanceMatrix: number[][] }
 */
async function extractMatrixForOptimization(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('extractMatrixForOptimization: need at least 2 points');
  }
  const n = points.length;
  let raw = opts.rawMatrix;
  if (!raw) {
    raw = await computeMatrixCached(points, points, {
      preference: opts.preference || 'TRAFFIC_UNAWARE',
      departureTime: opts.departureTime,
    });
  }
  const durationMatrix = Array.from({ length: n }, () => new Array(n).fill(null));
  const distanceMatrix = Array.from({ length: n }, () => new Array(n).fill(null));
  for (const r of raw) {
    durationMatrix[r.originIndex][r.destinationIndex] = r.durationSeconds;
    if (r.distanceMeters != null) {
      distanceMatrix[r.originIndex][r.destinationIndex] = r.distanceMeters;
    }
  }
  // Backfill diagonals + missing cells with Haversine. Optimization API throws
  // if any cell is null, so a cell-by-cell fallback is safer than a one-shot
  // recompute on the whole matrix.
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        if (durationMatrix[i][j] == null) durationMatrix[i][j] = 0;
        if (distanceMatrix[i][j] == null) distanceMatrix[i][j] = 0;
      } else {
        if (durationMatrix[i][j] == null) {
          // Fallback duration: km / 22 km/h × 3600
          const km = haversineKm(points[i], points[j]) * HAVERSINE_CORRECTION;
          durationMatrix[i][j] = Math.round((km / FALLBACK_KMH) * 3600);
        }
        if (distanceMatrix[i][j] == null) {
          const km = haversineKm(points[i], points[j]) * HAVERSINE_CORRECTION;
          distanceMatrix[i][j] = Math.round(km * 1000);
        }
      }
    }
  }
  return { durationMatrix, distanceMatrix };
}

module.exports = {
  computeMatrix,
  computeMatrixCached,
  computeMatrixWithPolyline,
  computeRoute,
  persistPolyline,
  persistPolylineSafe,
  purgeExpired,
  getDailyBudgetStatus,
  getMatrixBreakdown,
  getStats,
  extractMatrixForOptimization,
  RoutesBudgetExceededError,
  // exported for tests
  _hourBucket: hourBucket,
  _dayType: dayType,
  _haversineKm: haversineKm,
  // exported for Tier B: scripts/qa-routes-toctou.js + qa-routes-budget-stress.js
  assertWithinBudget,
  recordSpend,
};
