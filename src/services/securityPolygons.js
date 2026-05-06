/**
 * Caution / not-acceptable polygon checks.
 *
 * `colonias.security_level` ∈ {acceptable, caution, not_acceptable} comes from
 * an external dataset already joined to PostGIS polygons (`geom`, GIST-indexed).
 * planGenerator uses these checks to:
 *
 *   1. Hard-block `not_acceptable`: a stop whose pharmacy lat/lng is inside a
 *      not_acceptable polygon is removed from the candidate pool entirely.
 *      Reps never get sent there.
 *
 *   2. Soft-penalize `caution`: an arc whose route polyline crosses a caution
 *      polygon gets its driving-time multiplied by `CAUTION_PENALTY` so the
 *      sequencing optimizer prefers the alternative even if longer in absolute
 *      minutes. Reps still go but the algorithm tries to avoid extended
 *      exposure.
 *
 * The polyline test uses ST_Intersects against an ST_LineFromEncodedPolyline
 * (Google encoded polyline → geometry). PostGIS 3.0+ has this function; older
 * versions need the polyline to be decoded in JS first.
 */

const db = require('../config/database');

const CAUTION_PENALTY = 1.5; // multiplier applied to durationSeconds for arcs that cross caution polygons

/**
 * @param {{lat:number,lng:number}} point
 * @returns {Promise<'acceptable'|'caution'|'not_acceptable'|null>}
 */
async function levelAtPoint({ lat, lng }) {
  if (lat == null || lng == null) return null;
  const result = await db.raw(`
    SELECT security_level
    FROM colonias
    WHERE geom IS NOT NULL
      AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(?::double precision, ?::double precision), 4326))
    ORDER BY area_m2 ASC NULLS LAST
    LIMIT 1
  `, [lng, lat]);
  return result.rows?.[0]?.security_level || null;
}

/**
 * Bulk version: return a Map<index, level> for an array of points.
 */
async function levelAtPoints(points) {
  if (!points.length) return new Map();
  const out = new Map();
  // Build a VALUES list and join on ST_Contains. Single round-trip.
  // NOTE: knex 3.x trips on `$N` positional placeholders with array bindings —
  // it scans the SQL and errors "Expected N bindings, saw 0". Use `?` style.
  const params = [];
  const placeholders = points.map((p, i) => {
    params.push(i, p.lng, p.lat);
    return '(?::int, ?::double precision, ?::double precision)';
  }).join(',');
  const sql = `
    WITH pts(idx, lng, lat) AS (VALUES ${placeholders})
    SELECT pts.idx,
           (SELECT c.security_level
              FROM colonias c
             WHERE c.geom IS NOT NULL
               AND ST_Contains(c.geom, ST_SetSRID(ST_MakePoint(pts.lng, pts.lat), 4326))
             ORDER BY c.area_m2 ASC NULLS LAST
             LIMIT 1) AS level
    FROM pts
  `;
  const result = await db.raw(sql, params);
  for (const row of result.rows) out.set(Number(row.idx), row.level || 'acceptable');
  return out;
}

/**
 * @param {string} encodedPolyline — Google encoded polyline format
 * @returns {Promise<boolean>} true if the polyline intersects ANY caution polygon
 */
// Counter so /api/health can surface "caution polygon checks degrading" as a
// boot-time warning when ST_LineFromEncodedPolyline isn't available.
let polylineFallbackCount = 0;
let polylineFallbackLastError = null;

async function polylineIntersectsCaution(encodedPolyline) {
  if (!encodedPolyline) return false;
  try {
    const result = await db.raw(`
      SELECT 1
      FROM colonias
      WHERE security_level = 'caution'
        AND geom IS NOT NULL
        AND ST_Intersects(
          geom,
          ST_LineFromEncodedPolyline(?, 5)
        )
      LIMIT 1
    `, [encodedPolyline]);
    return (result.rows?.length || 0) > 0;
  } catch (err) {
    polylineFallbackCount += 1;
    polylineFallbackLastError = err.message;
    // ST_LineFromEncodedPolyline requires PostGIS 3.0+. On older installs we
    // fall back to a no-intersection result so plans still generate, but the
    // fallback is now logged and surfaced via getDegradationStatus().
    if (process.env.POSTGIS_3_REQUIRED === 'true') {
      throw new Error(`PostGIS ST_LineFromEncodedPolyline missing — caution polygons disabled. Original error: ${err.message}`);
    }
    if (polylineFallbackCount === 1) {
      console.warn(`[securityPolygons] polylineIntersectsCaution falling back (set POSTGIS_3_REQUIRED=true to fail loud): ${err.message}`);
    }
    return false;
  }
}

function getDegradationStatus() {
  return {
    polyline_fallback_count: polylineFallbackCount,
    polyline_fallback_last_error: polylineFallbackLastError,
  };
}

/**
 * Bbox-scoped GeoJSON FeatureCollection for the Plan Editor map overlay.
 * Returns only colonias whose geometry intersects the bbox; clipping is the
 * client's job (MapLibre handles partial polygons fine).
 *
 * @param {{minLng,minLat,maxLng,maxLat}} bbox
 * @param {string[]} levels  — subset of 'acceptable' | 'caution' | 'not_acceptable'
 */
async function geoJsonForBbox(bbox, levels = ['caution', 'not_acceptable']) {
  const { minLng, minLat, maxLng, maxLat } = bbox || {};
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    throw new Error('bbox required: minLng, minLat, maxLng, maxLat');
  }
  const rows = await db.raw(`
    SELECT name, security_level,
           ST_AsGeoJSON(geom)::jsonb AS geometry
      FROM colonias
     WHERE geom IS NOT NULL
       AND security_level = ANY(?::text[])
       AND ST_Intersects(geom, ST_MakeEnvelope(?, ?, ?, ?, 4326))
     LIMIT 5000
  `, [levels, minLng, minLat, maxLng, maxLat]);
  const features = (rows.rows || []).map((r) => ({
    type: 'Feature',
    properties: { name: r.name, level: r.security_level },
    geometry: r.geometry,
  }));
  return { type: 'FeatureCollection', features };
}

module.exports = {
  CAUTION_PENALTY,
  levelAtPoint,
  levelAtPoints,
  polylineIntersectsCaution,
  geoJsonForBbox,
  getDegradationStatus,
};
