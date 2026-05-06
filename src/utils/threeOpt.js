/**
 * 3-opt edge-removal heuristic. Remueve 3 aristas de la ruta y prueba las 7
 * reconexiones posibles (excluyendo la identidad). Acepta la mejor.
 *
 * Más caro que 2-opt (O(N³) por pass) pero escapa el "U-turn trap" en N>15
 * que 2-opt no puede romper porque cualquier inversión local empeora el costo.
 *
 * Complejidad: en N=20 son ~7000 evaluaciones por pass. Mantenemos max 1 pass
 * por default — corremos 3-opt sólo después de 2-opt en multi-start, y sólo
 * para N≥15 (umbral configurable en multiStart.js).
 *
 * Entrada: route con depot fijo en index 0. NO mueve el depot.
 * Salida: ruta mejorada (mutated copy, depot todavía en [0]).
 */

const { totalCost } = require('./routeOrdering');

/**
 * Build all 7 non-identity reconnections after removing edges at i, j, k.
 * Indices i < j < k mark segment boundaries:
 *   route = [A | B | C | D]
 *           A: 0..i, B: i+1..j, C: j+1..k, D: k+1..end
 * The 7 reconnections are A+B+C+D variations with reversals.
 */
function reconnect(route, i, j, k) {
  const A = route.slice(0, i + 1);
  const B = route.slice(i + 1, j + 1);
  const C = route.slice(j + 1, k + 1);
  const D = route.slice(k + 1);

  const reverseB = B.slice().reverse();
  const reverseC = C.slice().reverse();

  return [
    [...A, ...reverseB, ...C, ...D],          // 1: reverse B
    [...A, ...B, ...reverseC, ...D],          // 2: reverse C
    [...A, ...reverseB, ...reverseC, ...D],   // 3: reverse B and C
    [...A, ...C, ...B, ...D],                 // 4: swap B and C
    [...A, ...C, ...reverseB, ...D],          // 5: swap + reverse B
    [...A, ...reverseC, ...B, ...D],          // 6: swap + reverse C
    [...A, ...reverseC, ...reverseB, ...D],   // 7: swap + reverse both
  ];
}

function threeOptImprove(route, costFn, { maxIterations = 1, deadline = null } = {}) {
  if (route.length < 5) return route.slice();
  const out = route.slice();
  let best = totalCost(out, costFn);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let improved = false;
    // i, j, k bound segments. i starts at 0 so segment A always contains depot.
    // j > i, k > j, k <= length-1.
    for (let i = 0; i < out.length - 3; i += 1) {
      if (deadline && Date.now() > deadline) return out;
      for (let j = i + 1; j < out.length - 2; j += 1) {
        for (let k = j + 1; k < out.length - 1; k += 1) {
          const candidates = reconnect(out, i, j, k);
          for (const cand of candidates) {
            const cost = totalCost(cand, costFn);
            if (cost + 1e-6 < best) {
              best = cost;
              for (let m = 0; m < out.length; m += 1) out[m] = cand[m];
              improved = true;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
  return out;
}

module.exports = { threeOptImprove };
