/**
 * Funciones piecewise para el costo real de Google Maps Platform.
 *
 * Por qué este módulo existe (vs. las constantes lineales en routesMatrix.js y
 * geocoder.js):
 *
 *   - `routesMatrix.SKU_PRICE` y `geocoder.GEOCODING_USD_PER_CALL` son
 *     PESIMISTAS: usan el peor precio (sin free tier, sin tier degradation) y
 *     sirven al budget gate (assertWithinBudget / recordSpend). Queremos que
 *     el gate corte ANTES de que el costo real haga ruido, no DESPUÉS.
 *
 *   - Este módulo expone el costo REAL (free tier + tier degradation) y se
 *     usa solo en el READ path del dashboard de BlackPrint. Permite mostrar
 *     "te ahorraste $X gracias al free tier" sin tocar la lógica de gating.
 *
 * Schema de tiers (post-marzo 2025):
 *
 *   Essentials (Geocoding, Routes Compute Routes/Matrix sin trafic-aware):
 *     0 - 10,000     → $0 / 1k (free)
 *     10k - 100k     → $5 / 1k
 *     100k - 500k    → $4 / 1k
 *     500k - 1M      → $3 / 1k
 *     1M+            → $1.50 / 1k
 *
 *   Pro (Compute Routes/Matrix con TRAFFIC_AWARE / TRAFFIC_AWARE_OPTIMAL):
 *     0 - 5,000      → $0 / 1k (free, la mitad de Essentials)
 *     5k - 100k      → $10 / 1k
 *     100k - 500k    → $8 / 1k
 *     500k - 1M      → $6 / 1k
 *     1M+            → $3 / 1k
 *
 *   Route Optimization API:
 *     $0.13 / shipment (tentativo — confirmar con docs oficiales).
 *
 * Las tablas se exportan crudas para que el frontend pueda renderizar bandas
 * y break-evens sin re-derivarlas.
 */

const ESSENTIALS_TIERS = Object.freeze([
  Object.freeze({ upTo: 10000, pricePerK: 0 }),
  Object.freeze({ upTo: 100000, pricePerK: 5.0 }),
  Object.freeze({ upTo: 500000, pricePerK: 4.0 }),
  Object.freeze({ upTo: 1000000, pricePerK: 3.0 }),
  Object.freeze({ upTo: Infinity, pricePerK: 1.5 }),
]);

const PRO_TIERS = Object.freeze([
  Object.freeze({ upTo: 5000, pricePerK: 0 }),
  Object.freeze({ upTo: 100000, pricePerK: 10.0 }),
  Object.freeze({ upTo: 500000, pricePerK: 8.0 }),
  Object.freeze({ upTo: 1000000, pricePerK: 6.0 }),
  Object.freeze({ upTo: Infinity, pricePerK: 3.0 }),
]);

// Tentativo — pricing exacto de Route Optimization API pendiente de
// confirmación. Ajustar aquí cuando esté en stone.
const ROUTE_OPTIMIZATION_USD_PER_SHIPMENT = 0.0013;

// 4 decimales — suficiente para mostrar centavos sin arrastrar ruido de FP.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Calcula el costo USD de procesar `monthlyVolume` elementos contra una tabla
 * piecewise. La banda free no cobra; cada banda subsiguiente cobra solo el
 * incremento dentro de su rango.
 *
 * Asume `tiers` ordenado por `upTo` ascendente. Volúmenes negativos o NaN
 * devuelven 0.
 */
function piecewiseCost(monthlyVolume, tiers) {
  const vol = Number(monthlyVolume);
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  let usd = 0;
  let consumed = 0;
  for (const tier of tiers) {
    if (consumed >= vol) break;
    const bandCap = tier.upTo - consumed;
    const inBand = Math.min(bandCap, vol - consumed);
    if (inBand <= 0) continue;
    usd += (inBand / 1000) * tier.pricePerK;
    consumed += inBand;
  }
  return round4(usd);
}

/**
 * Cuántos elementos quedan en la banda free (primera banda con pricePerK === 0)
 * dada una utilización actual. Devuelve 0 si ya se consumió, e Infinity si la
 * tabla no tiene banda free.
 */
function freeTierRemaining(monthlyVolume, tiers) {
  const vol = Math.max(0, Number(monthlyVolume) || 0);
  for (const tier of tiers) {
    if (tier.pricePerK === 0) {
      return Math.max(0, tier.upTo - vol);
    }
    break; // free tier siempre es la primera por convención de la tabla.
  }
  return Infinity;
}

/**
 * Costo Geocoding API. Misma curva que Essentials por simplicidad
 * (Google cobra $5/1k en el tier base post-free).
 */
function geocodingCost(monthlyVolume) {
  return piecewiseCost(monthlyVolume, ESSENTIALS_TIERS);
}

function routesEssentialsCost(monthlyVolume) {
  return piecewiseCost(monthlyVolume, ESSENTIALS_TIERS);
}

function routesProCost(monthlyVolume) {
  return piecewiseCost(monthlyVolume, PRO_TIERS);
}

function routeOptimizationCost(shipments) {
  const n = Number(shipments);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round4(n * ROUTE_OPTIMIZATION_USD_PER_SHIPMENT);
}

/**
 * Costo lineal "naïve" (lo que cobraría el pricing constante actual de
 * routesMatrix.SKU_PRICE / geocoder.GEOCODING_USD_PER_CALL si no hubiera tiers
 * ni free). Útil para comparar contra `piecewiseCost` y exponer el ahorro.
 *
 * Asumimos el precio del primer tier no-cero como "tasa base" para esta curva
 * lineal — esa es la tasa que el código de billing pesimista ya está usando.
 */
function naiveCost(monthlyVolume, tiers) {
  const vol = Number(monthlyVolume);
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  const baseTier = tiers.find((t) => t.pricePerK > 0);
  if (!baseTier) return 0;
  return round4((vol / 1000) * baseTier.pricePerK);
}

function geocodingNaiveCost(monthlyVolume) {
  return naiveCost(monthlyVolume, ESSENTIALS_TIERS);
}

function routesEssentialsNaiveCost(monthlyVolume) {
  return naiveCost(monthlyVolume, ESSENTIALS_TIERS);
}

function routesProNaiveCost(monthlyVolume) {
  return naiveCost(monthlyVolume, PRO_TIERS);
}

/**
 * Devuelve un bloque enriquecido para el dashboard:
 *
 *   {
 *     est_cost_real_usd:    piecewise (free + tier degradation)
 *     est_cost_naive_usd:   linear (lo que el budget gate pesimista contaría)
 *     est_savings_vs_naive: max(0, naive - real)
 *     free_tier_remaining:  elements left in the free band (Infinity if no free)
 *     tier:                 'essentials' | 'pro' (eco del input)
 *   }
 *
 * Pure function — no DB / no I/O. Usado por blackprint.service.costSummary y
 * por tests de shape.
 */
function enrich(monthlyVolume, opts = {}) {
  const tier = opts.tier === 'pro' ? 'pro' : 'essentials';
  const tiers = tier === 'pro' ? PRO_TIERS : ESSENTIALS_TIERS;
  const real = piecewiseCost(monthlyVolume, tiers);
  const naive = naiveCost(monthlyVolume, tiers);
  const savings = round4(Math.max(0, naive - real));
  const free = freeTierRemaining(monthlyVolume, tiers);
  return {
    est_cost_real_usd: real,
    est_cost_naive_usd: naive,
    est_savings_vs_naive: savings,
    free_tier_remaining: Number.isFinite(free) ? free : null,
    tier,
  };
}

module.exports = {
  ESSENTIALS_TIERS,
  PRO_TIERS,
  ROUTE_OPTIMIZATION_USD_PER_SHIPMENT,
  piecewiseCost,
  freeTierRemaining,
  geocodingCost,
  routesEssentialsCost,
  routesProCost,
  routeOptimizationCost,
  naiveCost,
  geocodingNaiveCost,
  routesEssentialsNaiveCost,
  routesProNaiveCost,
  enrich,
};
