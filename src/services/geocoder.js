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

// Pricing constant for the BlackPrint cost-summary surface. First 100k tier.
// If usage crosses the boundary, BP can recompute from the row counts.
const GEOCODING_USD_PER_CALL = 0.005;

// Best-effort UPSERT into geocoding_api_spend (mig 092). Same daily-row
// pattern as routes_api_spend (mig 061). Failures are swallowed — observability
// must never block a user-facing geocode.
async function incrementGeocodingSpend({ cacheHit = false, geocodingCall = false, rejected = false } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const cost = geocodingCall ? GEOCODING_USD_PER_CALL : 0;
  try {
    await db.raw(`
      INSERT INTO geocoding_api_spend
        (day, geocoding_calls, cache_hits, rejected_calls, est_cost_usd,
         first_call_at, last_call_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      ON CONFLICT (day) DO UPDATE SET
        geocoding_calls = geocoding_api_spend.geocoding_calls + EXCLUDED.geocoding_calls,
        cache_hits      = geocoding_api_spend.cache_hits      + EXCLUDED.cache_hits,
        rejected_calls  = geocoding_api_spend.rejected_calls  + EXCLUDED.rejected_calls,
        est_cost_usd    = geocoding_api_spend.est_cost_usd    + EXCLUDED.est_cost_usd,
        last_call_at    = NOW()
    `, [
      day,
      geocodingCall ? 1 : 0,
      cacheHit ? 1 : 0,
      rejected ? 1 : 0,
      cost,
    ]);
  } catch (err) {
    // Table may not exist on environments that haven't applied mig 092 yet.
    // Best-effort: warn once per process via a Set, but do not throw.
    if (!incrementGeocodingSpend._warned) {
      console.warn('[geocoder] spend tracking failed: ' + err.message);
      incrementGeocodingSpend._warned = true;
    }
  }
}

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
    incrementGeocodingSpend({ cacheHit: true });
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
  if (!res.ok) {
    incrementGeocodingSpend({ rejected: true });
    throw new Error(`Geocoder HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) {
    // status NOT_FOUND / ZERO_RESULTS counts as a Google call (we did query)
    // but didn't get a useful answer. Track as both call AND rejected so the
    // BP dashboard can show effective hit rate.
    incrementGeocodingSpend({ geocodingCall: true, rejected: true });
    return null;
  }
  const r = json.results[0];
  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    incrementGeocodingSpend({ geocodingCall: true, rejected: true });
    return null;
  }
  await db('geocode_cache')
    .insert({
      normalized_address: norm,
      lat, lng,
      source: 'google',
      formatted_address: r.formatted_address,
    })
    .onConflict('normalized_address').merge();
  incrementGeocodingSpend({ geocodingCall: true });
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

module.exports = { geocodeOne, backfillUsersHome, normalizeAddress, incrementGeocodingSpend };
