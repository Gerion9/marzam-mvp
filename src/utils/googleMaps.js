const MAX_GOOGLE_WAYPOINTS = 25;
const CHUNK_SIZE = 23;

/**
 * Builds one or more Google Maps Directions URLs for the given stops.
 * When stops exceed ~25 (Google Maps URL limit), the route is split into
 * overlapping segments so each URL connects to the next.
 *
 * @param {Array<{lat: number, lng: number}>} stops - Ordered visit stops.
 * @returns {string[]} Array of URL strings (single element when ≤ 25 stops).
 */
function buildDirectionsUrls(stops) {
  if (!stops || !stops.length) return [];

  if (stops.length <= MAX_GOOGLE_WAYPOINTS) {
    return [buildSingleUrl(stops)];
  }

  const urls = [];
  let i = 0;
  while (i < stops.length - 1) {
    const end = Math.min(i + CHUNK_SIZE + 2, stops.length);
    const chunk = stops.slice(i, end);
    urls.push(buildSingleUrl(chunk));
    i = end - 1;
  }

  return urls;
}

/**
 * Builds a single Google Maps Directions URL from an array of stops.
 * First stop is origin, last is destination, middle are waypoints.
 */
function buildSingleUrl(stops) {
  const origin = `${stops[0].lat},${stops[0].lng}`;
  const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;

  const waypoints = stops
    .slice(1, -1)
    .map((s) => `${s.lat},${s.lng}`)
    .join('|');

  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) {
    url += `&waypoints=${encodeURIComponent(waypoints)}`;
  }

  return url;
}

/**
 * Backward-compatible wrapper: returns the first (or only) directions URL.
 * @param {Array<{lat: number, lng: number}>} stops
 * @returns {string|null}
 */
function buildDirectionsUrl(stops) {
  const urls = buildDirectionsUrls(stops);
  return urls.length ? urls[0] : null;
}

/**
 * Builds a single-place Google Maps URL for "open in Maps" per pharmacy.
 */
function buildPlaceUrl(lat, lng, name) {
  const query = encodeURIComponent(name || `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=&center=${lat},${lng}`;
}

module.exports = { buildDirectionsUrl, buildDirectionsUrls, buildPlaceUrl };
