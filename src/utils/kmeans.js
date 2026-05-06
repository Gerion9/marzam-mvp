/**
 * Geographic k-means clustering for the plan generator.
 *
 * Replaces the "heaviest-target rep first" greedy in assignByGreedy. The old
 * sort gave the most-loaded rep first pick of all geographically close stops,
 * leaving thinner-quota reps with farther leftovers and unbalanced day length.
 *
 * Approach:
 *   1) Seed centroids on each rep's home_lat/home_lng (this is the natural
 *      depot — k = number of reps with home coords).
 *   2) Assign each candidate to nearest centroid by Haversine.
 *   3) Refine centroids = mean of assigned candidates (few iterations).
 *   4) Return clusters keyed by repId, plus a fallback list for reps without
 *      home coords.
 *
 * Why fix initial centroids on home_lat/lng instead of random:
 *   The depot IS the start/end of the day. Any cluster that drifts away from
 *   home increases drive time, defeating the point. The depot anchor keeps
 *   clusters around each rep's real reachable area.
 */

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
 * Cluster candidates among reps anchored on their home coordinates.
 *
 * @param {Array<{id, home_lat, home_lng}>} reps
 * @param {Array<{id, lat, lng, ...}>} candidates
 * @param {Object} [opts]
 * @param {number} [opts.iterations=4]   — refinement passes
 * @param {boolean} [opts.anchor=true]   — keep centroid near home (averages with home)
 * @returns {{ byRep: Map<repId, candidate[]>, unclustered: candidate[] }}
 */
function clusterByHome(reps, candidates, { iterations = 4, anchor = true } = {}) {
  const repsWithHome = reps.filter(
    (r) => Number.isFinite(Number(r.home_lat)) && Number.isFinite(Number(r.home_lng)),
  );
  const repsNoHome = reps.filter(
    (r) => !Number.isFinite(Number(r.home_lat)) || !Number.isFinite(Number(r.home_lng)),
  );

  if (!repsWithHome.length) {
    // Degraded: nothing to cluster against. Round-robin fallback.
    const byRep = new Map(reps.map((r) => [r.id, []]));
    candidates.forEach((c, i) => byRep.get(reps[i % reps.length].id).push(c));
    return { byRep, unclustered: [] };
  }

  // Initial centroids = home coords.
  const centroids = repsWithHome.map((r) => ({
    repId: r.id,
    lat: Number(r.home_lat),
    lng: Number(r.home_lng),
    home: { lat: Number(r.home_lat), lng: Number(r.home_lng) },
  }));

  const usable = candidates.filter(
    (c) => Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)),
  );
  const unclustered = candidates.filter(
    (c) => !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lng)),
  );

  let assignments = new Array(usable.length);

  for (let it = 0; it < iterations; it += 1) {
    // Assign each candidate to nearest centroid.
    for (let i = 0; i < usable.length; i += 1) {
      const c = { lat: Number(usable[i].lat), lng: Number(usable[i].lng) };
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < centroids.length; k += 1) {
        const d = haversineKm(c, centroids[k]);
        if (d < bestD) { bestD = d; best = k; }
      }
      assignments[i] = best;
    }

    // Refine centroids: mean of assigned points (anchored half-and-half on
    // home so the centroid doesn't drift to the far side of the cluster).
    const sums = centroids.map(() => ({ lat: 0, lng: 0, n: 0 }));
    for (let i = 0; i < usable.length; i += 1) {
      const k = assignments[i];
      sums[k].lat += Number(usable[i].lat);
      sums[k].lng += Number(usable[i].lng);
      sums[k].n += 1;
    }
    for (let k = 0; k < centroids.length; k += 1) {
      if (sums[k].n === 0) continue;
      const meanLat = sums[k].lat / sums[k].n;
      const meanLng = sums[k].lng / sums[k].n;
      if (anchor) {
        centroids[k].lat = (meanLat + centroids[k].home.lat) / 2;
        centroids[k].lng = (meanLng + centroids[k].home.lng) / 2;
      } else {
        centroids[k].lat = meanLat;
        centroids[k].lng = meanLng;
      }
    }
  }

  // Build output grouped by repId.
  const byRep = new Map();
  for (const r of reps) byRep.set(r.id, []);
  for (let i = 0; i < usable.length; i += 1) {
    const repId = centroids[assignments[i]].repId;
    byRep.get(repId).push(usable[i]);
  }

  // Reps without home get NO cluster — caller falls back to round-robin or
  // skips. Returning an empty list per home-less rep is intentional: without
  // a depot we cannot promise drive-time correctness.
  for (const r of repsNoHome) byRep.set(r.id, byRep.get(r.id) || []);

  return { byRep, unclustered };
}

module.exports = { clusterByHome, haversineKm };
