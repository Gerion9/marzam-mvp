/**
 * Minimal geohash encoder.
 *
 * Used as the cache key for `route_matrix_cache` so two stops within ~150 m
 * of each other share a cached driving duration (length 7 → ~152 m × 152 m
 * cells around CDMX). This is the same trick Uber uses with H3 — we do not
 * pull H3 because for a single-resolution use case the 60 lines below are
 * sufficient and have no native dependencies.
 *
 *   encode(19.4326, -99.1332, 7)  → "9g3w81t"
 *
 * Resolution table (rough, varies with latitude):
 *   length  cell_w   cell_h
 *   5       ±2.4 km  ±2.4 km
 *   6       ±610 m   ±610 m
 *   7       ±152 m   ±152 m   ← we use this
 *   8       ±38 m    ±19 m
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encode(lat, lng, precision = 7) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let bits = 0;
  let bit = 0;
  let evenBit = true; // start with longitude
  let hash = '';
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) {
        bits = (bits << 1) | 1;
        minLng = mid;
      } else {
        bits <<= 1;
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        minLat = mid;
      } else {
        bits <<= 1;
        maxLat = mid;
      }
    }
    evenBit = !evenBit;
    bit += 1;
    if (bit === 5) {
      hash += BASE32[bits];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

module.exports = { encode };
