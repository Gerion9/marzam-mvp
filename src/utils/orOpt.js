/**
 * Or-opt: mueve segmentos contiguos de 1, 2 o 3 stops a otra posición de la
 * ruta. Complementa 2-opt en rutas con clusters separados — 2-opt sólo invierte
 * subsecuencias, no las relocaliza.
 *
 * Complejidad: O(N²) por segment-size por pass. Para N=15 son ~675 operaciones
 * por pass × 3 segment sizes ≈ 2k ops/pass. Cheap.
 *
 * Entrada: route con depot fijo en index 0. La función NO mueve el depot.
 * Salida: ruta mejorada (mutated copy, depot todavía en [0]).
 */

const { totalCost } = require('./routeOrdering');

function orOptImprove(route, costFn, { segmentSizes = [1, 2, 3], maxIterations = 2, deadline = null } = {}) {
  if (route.length < 4) return route.slice();
  const out = route.slice();
  let best = totalCost(out, costFn);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let improved = false;
    for (const segLen of segmentSizes) {
      // Indices [i..i+segLen-1] form the segment to remove (1..length-segLen-1
      // because we skip the depot).
      for (let i = 1; i <= out.length - segLen - 1; i += 1) {
        if (deadline && Date.now() > deadline) return out;
        // Try inserting the segment after every other position j (j != i-1, j+1 != i, etc.)
        for (let j = 0; j < out.length; j += 1) {
          // Skip insertion that doesn't change the route.
          if (j >= i - 1 && j <= i + segLen - 1) continue;
          // Build candidate: remove segment, insert after j (adjusted for removal shift).
          const candidate = out.slice();
          const segment = candidate.splice(i, segLen);
          const insertIdx = j < i ? j + 1 : j + 1 - segLen;
          if (insertIdx <= 0 || insertIdx > candidate.length) continue;  // never before depot
          candidate.splice(insertIdx, 0, ...segment);
          const cost = totalCost(candidate, costFn);
          if (cost + 1e-6 < best) {
            best = cost;
            for (let k = 0; k < out.length; k += 1) out[k] = candidate[k];
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  return out;
}

module.exports = { orOptImprove };
