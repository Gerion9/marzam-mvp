/**
 * Multi-start solver para TSP-from-depot.
 *
 * Estrategia escalonada por N (stops, sin contar depot):
 *   N <=  8: NN-from-depot + 2-opt único — comportamiento histórico.
 *   N <= 15: NN + Or-opt(1,2,3) + 2-opt × 3 seeds.
 *   N >  15: NN + Or-opt + 2-opt + 3-opt(1 pass) × 5 seeds.
 *
 * Determinismo: seeds derivados de `hash(repId + dayIso)`. Dos planes con los
 * mismos inputs producen exactamente el mismo orden. Esto importa para que el
 * editor del manager no haga flicker al re-generar el preview.
 *
 * Cada seed varía la heurística inicial:
 *   seed 0: NN puro desde depot
 *   seed 1: NN puro pero arrancando con el stop más lejano (last-first)
 *   seed 2: NN ponderado por pareto (A primero)
 *   seed 3: random shuffle determinista
 *   seed 4: NN inverso desde depot (greedy de mayor distancia primero)
 *
 * SLA (validado en bench-solver.js):
 *   N=15 p95 < 100 ms
 *   N=25 p95 < 500 ms (con `deadline` en kwargs)
 */

const { orderStopsFromDepot, twoOptImprove, totalCost } = require('./routeOrdering');
const { orOptImprove } = require('./orOpt');
const { threeOptImprove } = require('./threeOpt');

const N_OROPT_THRESHOLD = 8;
const N_THREEOPT_THRESHOLD = 15;
const SEEDS_OROPT_TIER = 3;
const SEEDS_3OPT_TIER = 5;

/**
 * Hash determinista para derivar seeds reproducibles a partir de (repId, dayIso).
 * Usa FNV-1a (32-bit) — suficiente para distribuir 5-10 seeds.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * PRNG determinista (mulberry32). Se siembra desde fnv1a(repId|dayIso|seedIdx).
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Initial-solution heuristics. Cada uno produce una secuencia inicial DESDE el depot.
 *
 *   - 'nn'             : NN puro desde depot.
 *   - 'nn_last_first'  : NN puro pero arrancando con el stop más lejano.
 *   - 'nn_pareto'      : NN puro pero penalizando los pareto bajos para que A salga primero.
 *   - 'random'         : permutación aleatoria determinista.
 *   - 'farthest_first' : siempre el más lejano del current.
 */
function buildInitial(strategy, depot, stops, costFn, rngSeed) {
  if (strategy === 'nn') {
    return orderStopsFromDepot(depot, stops, costFn);
  }
  if (strategy === 'nn_last_first') {
    if (!stops.length) return [];
    // Find furthest from depot, place first; then NN for the rest.
    let furthestIdx = 0;
    let furthestCost = -Infinity;
    for (let i = 0; i < stops.length; i += 1) {
      const c = costFn(depot, stops[i]);
      if (c > furthestCost) { furthestCost = c; furthestIdx = i; }
    }
    const seed = stops[furthestIdx];
    const remaining = stops.filter((_, i) => i !== furthestIdx);
    const tail = orderStopsFromDepot(seed, remaining, costFn);
    return [seed, ...tail];
  }
  if (strategy === 'nn_pareto') {
    // Sort by pareto rank first (A=1, B=2, C=3, D=4, null=5), then NN.
    const rank = { A: 1, B: 2, C: 3, D: 4 };
    const ordered = stops.slice().sort((a, b) => (rank[a.pareto] || 5) - (rank[b.pareto] || 5));
    return orderStopsFromDepot(depot, ordered, costFn);
  }
  if (strategy === 'farthest_first') {
    if (!stops.length) return [];
    const remaining = stops.slice();
    const out = [];
    let current = depot;
    while (remaining.length) {
      let bestIdx = 0;
      let bestCost = -Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const c = costFn(current, remaining[i]);
        if (c > bestCost) { bestCost = c; bestIdx = i; }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      out.push(next);
      current = next;
    }
    return out;
  }
  if (strategy === 'random') {
    const rng = mulberry32(rngSeed);
    const arr = stops.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // default
  return orderStopsFromDepot(depot, stops, costFn);
}

const SEED_STRATEGIES = ['nn', 'nn_last_first', 'nn_pareto', 'random', 'farthest_first'];

/**
 * Improve a single seed with the kernels appropriate for N.
 */
function improveOnce(routeWithDepot, costFn, kernels, deadline) {
  let cur = routeWithDepot;
  for (const k of kernels) {
    if (deadline && Date.now() > deadline) break;
    if (k === '2opt') cur = twoOptImprove(cur, costFn, { deadline });
    else if (k === 'oropt') cur = orOptImprove(cur, costFn, { deadline });
    else if (k === '3opt') cur = threeOptImprove(cur, costFn, { deadline });
  }
  return cur;
}

/**
 * Main entry. Solves a single (rep, day) tour from depot.
 *
 * @param {{
 *   depot: {lat:number, lng:number, __seqIdx?:0},
 *   stops: Array,
 *   costFn: (a,b) => number,
 *   repId?: string,
 *   dayIso?: string,
 *   deadline?: number,    // ms epoch; aborts when reached
 *   strategy?: 'auto'|'legacy'|'multistart'  // default 'auto' (use multistart when N>=8)
 * }} args
 *
 * Returns:
 *   { ordered, totalCost, strategy, seedsTried, kernels, mode }
 */
function solve({ depot, stops, costFn, repId = '', dayIso = '', deadline = null, strategy = 'auto' }) {
  if (!stops.length) {
    return { ordered: [], totalCost: 0, strategy: 'empty', seedsTried: 0, kernels: [], mode: 'legacy' };
  }
  const N = stops.length;

  // Mode selection.
  const useLegacy = strategy === 'legacy' || N <= 4;
  const tier = N <= N_OROPT_THRESHOLD ? 'small'
    : N <= N_THREEOPT_THRESHOLD ? 'medium'
      : 'large';

  if (useLegacy) {
    const nn = orderStopsFromDepot(depot, stops, costFn);
    const opt = twoOptImprove([depot, ...nn], costFn);
    return {
      ordered: opt.slice(1),
      totalCost: totalCost(opt, costFn),
      strategy: 'legacy',
      seedsTried: 1,
      kernels: ['nn', '2opt'],
      mode: 'legacy',
    };
  }

  const kernels = tier === 'small' ? ['2opt']
    : tier === 'medium' ? ['oropt', '2opt']
      : ['oropt', '2opt', '3opt'];
  const seedCount = tier === 'medium' ? SEEDS_OROPT_TIER : tier === 'large' ? SEEDS_3OPT_TIER : 1;
  const baseSeed = fnv1a(`${repId}|${dayIso}|${N}`);

  let bestRoute = null;
  let bestCost = Infinity;
  let seedsTried = 0;

  for (let s = 0; s < seedCount; s += 1) {
    if (deadline && Date.now() > deadline) break;
    const strat = SEED_STRATEGIES[s % SEED_STRATEGIES.length];
    const initial = buildInitial(strat, depot, stops, costFn, (baseSeed + s) >>> 0);
    const improved = improveOnce([depot, ...initial], costFn, kernels, deadline);
    const c = totalCost(improved, costFn);
    seedsTried += 1;
    if (c < bestCost) {
      bestCost = c;
      bestRoute = improved;
    }
  }

  // Fallback: always return at least the legacy solution if all seeds were aborted.
  if (!bestRoute) {
    const nn = orderStopsFromDepot(depot, stops, costFn);
    const opt = twoOptImprove([depot, ...nn], costFn);
    return {
      ordered: opt.slice(1),
      totalCost: totalCost(opt, costFn),
      strategy: 'fallback',
      seedsTried,
      kernels: ['nn', '2opt'],
      mode: 'legacy',
    };
  }

  return {
    ordered: bestRoute.slice(1),
    totalCost: bestCost,
    strategy: tier,
    seedsTried,
    kernels,
    mode: 'multistart',
  };
}

module.exports = {
  solve,
  N_OROPT_THRESHOLD,
  N_THREEOPT_THRESHOLD,
  SEED_STRATEGIES,
};
