/**
 * Nearest-neighbour greedy heuristic for stop ordering.
 * Sufficient for MVP; advanced optimization (TSP solvers) is out of scope.
 *
 * Input:  Array of { id, lat, lng }
 * Output: Same array reordered by greedy nearest-neighbour from the first element.
 */
function orderStops(stops) {
  if (stops.length <= 2) return stops;

  const remaining = [...stops];
  const ordered = [remaining.shift()];

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return ordered;
}

/**
 * NN starting from a fixed depot (rep's home), using a caller-supplied cost
 * function. Cost is in seconds (or any monotonic unit) — typically a closure
 * over a precomputed driving-time matrix.
 *
 * @param {{lat:number,lng:number}} depot
 * @param {Array<{id:string,lat:number,lng:number}>} stops
 * @param {(from:{lat,lng,depotId?},to:{lat,lng,id}) => number} costFn
 * @returns {Array<{id,lat,lng}>}
 */
function orderStopsFromDepot(depot, stops, costFn) {
  if (!stops.length) return [];
  const remaining = [...stops];
  const ordered = [];
  let current = { ...depot, depot: true };
  while (remaining.length) {
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const c = costFn(current, remaining[i]);
      if (c < bestCost) {
        bestCost = c;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

/**
 * 2-opt improvement on an already-ordered route. Applied AFTER NN to flip
 * any pair of edges (i,j) when removing them and reconnecting in reverse
 * yields a lower cost. For N ≤ 12 this is essentially instant and produces
 * routes within a few percent of optimal.
 *
 *   route[0]   = depot (kept fixed)
 *   route[1..] = stops to reorder
 *
 * The depot is INCLUDED at index 0 because the algorithm needs the starting
 * point in the cost calculation. The return value is the reordered route
 * with the depot still at index 0; caller typically slices(1).
 *
 * @param {Array<{id?:string,lat:number,lng:number}>} route
 * @param {(a,b) => number} costFn — symmetric or asymmetric in seconds
 * @param {{maxIterations?:number}} [opts]
 * @returns {Array} improved route (mutated copy, depot at [0])
 */
/**
 * Total cost of a route (depot included at index 0). Exported so multi-start
 * solver (utils/multiStart.js) can compare candidate tours without re-deriving
 * the closure. Asymmetric: cost(a,b) ≠ cost(b,a).
 */
function totalCost(arr, costFn) {
  let sum = 0;
  for (let k = 0; k < arr.length - 1; k += 1) sum += costFn(arr[k], arr[k + 1]);
  return sum;
}

function twoOptImprove(route, costFn, { maxIterations = 30, deadline = null } = {}) {
  if (route.length < 4) return route.slice();
  const out = route.slice();

  let improved = true;
  let iter = 0;
  let best = totalCost(out, costFn);
  while (improved && iter < maxIterations) {
    improved = false;
    iter += 1;
    // i starts at 1 to keep depot fixed; j ends at length-1 (no wrap-around,
    // we are an open path, not a tour).
    for (let i = 1; i < out.length - 1; i += 1) {
      if (deadline && Date.now() > deadline) return out;
      for (let j = i + 1; j < out.length; j += 1) {
        // Candidate: reverse the segment [i..j] inclusive.
        const candidate = out.slice();
        let a = i;
        let b = j;
        while (a < b) {
          [candidate[a], candidate[b]] = [candidate[b], candidate[a]];
          a += 1;
          b -= 1;
        }
        const cost = totalCost(candidate, costFn);
        if (cost + 1e-6 < best) {
          best = cost;
          for (let k = 0; k < out.length; k += 1) out[k] = candidate[k];
          improved = true;
        }
      }
    }
  }
  return out;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

module.exports = { orderStops, orderStopsFromDepot, twoOptImprove, totalCost };
