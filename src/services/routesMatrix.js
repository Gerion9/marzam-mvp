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

/* global fetch */
const db = require('../config/database');
const config = require('../config');
const { encode: geohashEncode } = require('../utils/geohash');

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTE_ENDPOINT  = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,condition';
const ROUTE_FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';

const MAX_ELEMENTS_PER_CALL = 625;
const CACHE_TTL_DAYS = 7;
const HAVERSINE_CORRECTION = 1.4;       // road km / air km in CDMX (rough)
const FALLBACK_KMH = 22;                // average driving speed when estimating

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
  const params = [];
  const placeholders = pairs.map(({ originGh, destGh }, i) => {
    const j = i * 2;
    params.push(originGh, destGh);
    return `($${j + 1}::char(7), $${j + 2}::char(7))`;
  }).join(',');
  const sql = `
    WITH wanted (origin_geohash7, dest_geohash7) AS (VALUES ${placeholders})
    SELECT w.origin_geohash7, w.dest_geohash7,
           c.duration_seconds, c.distance_meters, c.polyline
    FROM wanted w
    LEFT JOIN route_matrix_cache c
      ON c.origin_geohash7 = w.origin_geohash7
     AND c.dest_geohash7  = w.dest_geohash7
     AND c.hour_bucket    = ${hourBucketValue}
     AND c.day_type       = ${dayTypeValue}
     AND c.routing_preference = '${preference}'
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

async function callRoutesMatrixApi(origins, destinations, { preference = 'TRAFFIC_UNAWARE', departureTime } = {}) {
  const apiKey = config.google.mapsApiKey;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  const body = {
    origins: origins.map(buildWaypoint),
    destinations: destinations.map(buildWaypoint),
    travelMode: 'DRIVE',
    routingPreference: preference,
  };
  // departureTime is required for TRAFFIC_AWARE; ignored otherwise.
  if (preference === 'TRAFFIC_AWARE' && departureTime) {
    body.departureTime = departureTime.toISOString();
  }

  const res = await fetch(ROUTES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': MATRIX_FIELD_MASK,
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
      };
    });
  } catch (err) {
    console.warn(`[routesMatrix] Falling back to Haversine — ${err.message}`);
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
  const departureTime = opts.departureTime || new Date();
  const preference = opts.preference || 'TRAFFIC_UNAWARE';
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

  // 2) Detect uncached pairs.
  const uncached = [];
  for (const [key, pair] of uniquePairs.entries()) {
    if (!cacheMap.has(key)) uncached.push({ key, ...pair });
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
    const matrix = await computeMatrix(uniqOrigins, uniqDests, { preference, departureTime });

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
        flag: r.flag === 'estimated' ? 'estimated' : 'fresh',
      };
      cacheMap.set(p.key, entry);
      if (entry.flag === 'fresh') {
        toCache.push({
          originGh: p.originGh,
          destGh: p.destGh,
          durationSeconds: entry.durationSeconds,
          distanceMeters: entry.distanceMeters,
          polyline: null,
        });
      }
    }
    if (toCache.length) {
      try {
        await writeCache(toCache, { hourBucketValue, dayTypeValue, preference });
      } catch (err) {
        console.warn(`[routesMatrix] writeCache failed: ${err.message}`);
      }
    }
  }

  // 4) Project results back to the requested (i, j) shape.
  const out = [];
  for (const { i, j, key } of pairToKey) {
    const r = cacheMap.get(key);
    if (r) {
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
      out.push({ originIndex: i, destinationIndex: j, ...est });
    }
  }
  return out;
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
 * Best-effort: store the polyline of a single arc in the cache so a future
 * matrix lookup for the same geohash7 pair gets the geometry too. Cheap and
 * idempotent.
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

async function purgeExpired() {
  // 23 days satisfies the 30-day Google ToS limit on cached lat/lng-derived
  // data with a 7-day safety margin. Run nightly.
  const result = await db('route_matrix_cache')
    .whereRaw("computed_at < NOW() - INTERVAL '23 days'")
    .del();
  return { deleted: result };
}

module.exports = {
  computeMatrix,
  computeMatrixCached,
  computeRoute,
  persistPolyline,
  purgeExpired,
  // exported for tests
  _hourBucket: hourBucket,
  _dayType: dayType,
  _haversineKm: haversineKm,
};
