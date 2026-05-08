/**
 * Address → lat/lng geocoder.
 *
 * Used by:
 *   - employee imports & on-demand admin tooling to pre-populate
 *     users.home_lat/home_lng before the rep ever opens the app
 *   - Vercel Cron daily backfill (admin/cron/geocode-backfill)
 *
 * Cache: `geocode_cache(normalized_address PK, lat, lng, ...)` (migration 062).
 * Same address geocoded twice = 1 Google call.
 *
 * Provider: Google Maps Geocoding API (uses GOOGLE_MAPS_API_KEY).
 *   - Uses `region=mx` and `country:MX` to bias to Mexico results.
 *   - Falls back gracefully on 4xx/5xx (caller decides whether to retry).
 */

const db = require('../config/database');
const config = require('../config');
const { encode: geohashEncode } = require('../utils/geohash');

const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^\w\s,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function geocodeOne(address) {
  const norm = normalizeAddress(address);
  if (!norm) return null;
  const cached = await db('geocode_cache').where({ normalized_address: norm }).first();
  if (cached) {
    db('geocode_cache').where({ normalized_address: norm })
      .increment('hits', 1)
      .catch(() => { /* best-effort */ });
    return { lat: Number(cached.lat), lng: Number(cached.lng), source: 'cache', formatted: cached.formatted_address };
  }

  const apiKey = config.google?.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set('address', address);
  url.searchParams.set('region', 'mx');
  url.searchParams.set('components', 'country:MX');
  url.searchParams.set('key', apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) {
    return null;
  }
  const r = json.results[0];
  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  await db('geocode_cache')
    .insert({
      normalized_address: norm,
      lat, lng,
      source: 'google',
      formatted_address: r.formatted_address,
    })
    .onConflict('normalized_address').merge();
  return { lat, lng, source: 'google', formatted: r.formatted_address };
}

/**
 * Backfill `users.home_lat/home_lng` from `employee_profiles.domicilio_particular`
 * for users that don't have coordinates yet.
 *
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{processed:number, geocoded:number, missed:number}>}
 */
async function backfillUsersHome({ limit = 100 } = {}) {
  // Defensive: employee_profiles may not have domicilio_particular column on
  // every environment. We probe via raw query and bail if it's missing.
  let rows;
  try {
    rows = await db.raw(`
      SELECT u.id, ep.domicilio_particular
        FROM users u
        LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.is_active = true
         AND u.home_lat IS NULL
         AND ep.domicilio_particular IS NOT NULL
         AND length(trim(ep.domicilio_particular)) >= 6
       LIMIT ?
    `, [limit]);
  } catch (err) {
    return { processed: 0, geocoded: 0, missed: 0, error: err.message };
  }
  let processed = 0; let geocoded = 0; let missed = 0;
  for (const r of (rows.rows || [])) {
    processed += 1;
    try {
      const result = await geocodeOne(r.domicilio_particular);
      if (!result) { missed += 1; continue; }
      const gh = geohashEncode(result.lat, result.lng, 7);
      await db('users').where({ id: r.id }).update({
        home_lat: result.lat,
        home_lng: result.lng,
        home_geohash7: gh,
        home_geocoded_at: db.fn.now(),
        home_geocode_source: 'geocoder',
      });
      geocoded += 1;
    } catch (e) {
      missed += 1;
      console.warn(`[geocoder] backfill failed for user ${r.id}: ${e.message}`);
    }
  }
  return { processed, geocoded, missed };
}

module.exports = { geocodeOne, backfillUsersHome, normalizeAddress };
