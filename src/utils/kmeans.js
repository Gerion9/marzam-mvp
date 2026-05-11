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
function clusterByHome(reps, candidates, opts = {}) {
  const {
    iterations = 4,
    anchor = true,
    enableHomeless = false, // Cambio 2 — include reps without home in clustering.
    loadAwareTiebreak = false, // Cambio 3 — tie-break by cluster load + employee_code.
    epsKm = 0.5, // Tie-break threshold (within 0.5 km is considered "same distance").
  } = opts;

  // Important: Number(null) === 0 (finite!), so we must explicitly reject
  // null/undefined before checking isFinite, otherwise reps without home get
  // classified as "at (0,0)" and produce phantom clusters off the coast of Africa.
  const hasHomeCoords = (r) => (
    r.home_lat != null && r.home_lng != null
    && Number.isFinite(Number(r.home_lat)) && Number.isFinite(Number(r.home_lng))
  );
  const repsWithHome = reps.filter(hasHomeCoords);
  const repsNoHome = reps.filter((r) => !hasHomeCoords(r));

  // Reject null/undefined explicitly: Number(null) === 0 (finite!) would
  // otherwise smuggle a coordless candidate through as if it were at (0,0).
  const hasCoords = (c) =>
    c.lat != null && c.lng != null
    && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
  const usable = candidates.filter(hasCoords);
  const unclustered = candidates.filter((c) => !hasCoords(c));

  // Degraded: no reps with home AND homeless not enabled → legacy round-robin
  // across all reps (preserves existing behavior).
  if (!repsWithHome.length && !enableHomeless) {
    const byRep = new Map(reps.map((r) => [r.id, []]));
    candidates.forEach((c, i) => byRep.get(reps[i % reps.length].id).push(c));
    return { byRep, unclustered: [], centroidByRepId: new Map() };
  }

  // Build initial centroids:
  //   1. Reps with home → centroid = home (anchored).
  //   2. Reps without home (only when enableHomeless) → k-means++ seed:
  //      pick the candidate farthest from all existing centroids. This avoids
  //      collisions where two homeless reps start at identical seeds.
  const centroids = repsWithHome.map((r) => ({
    repId: r.id,
    employee_code: r.employee_code || r.id || '',
    lat: Number(r.home_lat),
    lng: Number(r.home_lng),
    home: { lat: Number(r.home_lat), lng: Number(r.home_lng) },
    hasHome: true,
  }));

  if (enableHomeless && repsNoHome.length && usable.length) {
    // Seed each homeless rep with k-means++: farthest candidate from existing centroids.
    for (const rep of repsNoHome) {
      let best = null;
      let bestMinD = -1;
      for (const c of usable) {
        if (!centroids.length) {
          best = c; bestMinD = 0; break;
        }
        let minD = Infinity;
        for (const k of centroids) {
          const d = haversineKm({ lat: Number(c.lat), lng: Number(c.lng) }, k);
          if (d < minD) minD = d;
        }
        if (minD > bestMinD) { bestMinD = minD; best = c; }
      }
      const seed = best
        ? { lat: Number(best.lat), lng: Number(best.lng) }
        : { lat: 0, lng: 0 };
      centroids.push({
        repId: rep.id,
        employee_code: rep.employee_code || rep.id || '',
        lat: seed.lat,
        lng: seed.lng,
        home: null,
        hasHome: false,
      });
    }
  }

  // If after all that we still have no centroids (e.g., no reps with home AND
  // homeless disabled but enableHomeless requested with empty usable), fall
  // back to round-robin to avoid a degenerate state.
  if (!centroids.length) {
    const byRep = new Map(reps.map((r) => [r.id, []]));
    candidates.forEach((c, i) => byRep.get(reps[i % reps.length].id).push(c));
    return { byRep, unclustered: [], centroidByRepId: new Map() };
  }

  let assignments = new Array(usable.length);
  // Cambio 3 telemetry — counts when tiebreak rules actually triggered.
  const tiebreakStats = {
    tiebreaks_applied: 0,
    by_load: 0,
    by_employee_code: 0,
  };

  for (let it = 0; it < iterations; it += 1) {
    // Track per-centroid running count for load-aware tie-break (Cambio 3).
    const counts = new Array(centroids.length).fill(0);
    const isLastIteration = (it === iterations - 1);
    for (let i = 0; i < usable.length; i += 1) {
      const c = { lat: Number(usable[i].lat), lng: Number(usable[i].lng) };
      let best = -1;
      let bestD = Infinity;
      // Track ties: candidates within `epsKm` of bestD are eligible for tiebreak.
      const ties = [];
      for (let k = 0; k < centroids.length; k += 1) {
        const d = haversineKm(c, centroids[k]);
        if (d < bestD - epsKm) {
          bestD = d; best = k; ties.length = 0; ties.push(k);
        } else if (Math.abs(d - bestD) <= epsKm) {
          ties.push(k);
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      // Cambio 3 — when tiebreak enabled and multiple centroids tied,
      // pick by (current load ASC, employee_code ASC) for deterministic, balanced result.
      if (loadAwareTiebreak && ties.length > 1) {
        const beforeBest = best;
        ties.sort((a, b) => {
          if (counts[a] !== counts[b]) return counts[a] - counts[b];
          const ca = String(centroids[a].employee_code || '');
          const cb = String(centroids[b].employee_code || '');
          if (ca < cb) return -1;
          if (ca > cb) return 1;
          return 0;
        });
        best = ties[0];
        if (isLastIteration) {
          tiebreakStats.tiebreaks_applied += 1;
          if (counts[best] !== counts[beforeBest]) tiebreakStats.by_load += 1;
          else if (best !== beforeBest) tiebreakStats.by_employee_code += 1;
        }
      }
      assignments[i] = best;
      counts[best] += 1;
    }

    // Refine centroids: mean of assigned points (anchored half-and-half on
    // home so the centroid doesn't drift to the far side of the cluster).
    // For homeless centroids, no anchor — pure mean (auto-referential).
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
      if (anchor && centroids[k].hasHome) {
        centroids[k].lat = (meanLat + centroids[k].home.lat) / 2;
        centroids[k].lng = (meanLng + centroids[k].home.lng) / 2;
      } else {
        // Homeless centroid: pure mean of assigned candidates (auto-referential).
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

  // Expose final centroid per rep (useful for homeless reps as their virtual depot).
  const centroidByRepId = new Map();
  for (const c of centroids) {
    centroidByRepId.set(c.repId, { lat: c.lat, lng: c.lng, hasHome: c.hasHome });
  }

  // Reps without home that weren't included (enableHomeless=false) get empty cluster.
  for (const r of repsNoHome) byRep.set(r.id, byRep.get(r.id) || []);

  return { byRep, unclustered, centroidByRepId, tiebreakStats };
}

module.exports = { clusterByHome, haversineKm };
