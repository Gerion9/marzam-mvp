/**
 * Simulador de costos "what-if" — escenarios para presupuestar la operación
 * Marzam en Google Maps Platform sin tocar el budget real.
 *
 * Trabaja exclusivamente con funciones puras del módulo `pricing.js`. NO toca
 * DB ni red. El endpoint /api/blackprint/cost-simulate lo expone y la vista
 * del drawer lo invoca con los parámetros del usuario.
 *
 * Ejes que cubre:
 *   1. Geocoding API (Essentials, free 10k/mes) — para nuevas farmacias /
 *      backfill de home_lat de reps / direcciones de prospectos.
 *   2. Routes API (Essentials, free 10k/mes) — matrix elements + route calls
 *      consumidos por el solver clásico durante el plan generate.
 *   3. Route Optimization API — bifurca por SKU según `vehicles_per_call`:
 *        1  → Single Vehicle Routing (Pro,  free 5k shipments/mes)
 *        2+ → Fleet Routing          (Enterprise, free 1k shipments/mes,
 *             ~3× más caro post-free)
 *
 * La salida está pensada para ser consumida directamente por una UI: cada
 * bloque carga real + naive + savings + free tier remaining, y al final un
 * grand total con extrapolación anual y comparativa contra los planes de
 * suscripción públicos de GMP.
 */

const pricing = require('./pricing');

// Presets de escenarios — alineados con el roadmap Marzam:
//   pilot_ecatepec: 10 reps × 22 días × 23 stops/día (=5,060 shipments)
//   sucursal_full:  50 reps × 22 días × 23 stops/día (=25,300 shipments)
//   nacional:      200 reps × 22 días × 23 stops/día (=101,200 shipments)
const PRESETS = Object.freeze({
  pilot_ecatepec: {
    label: 'Pilot Ecatepec (estado actual)',
    description: '10 reps captando + manteniendo Ecatepec, 1 plan/semana',
    reps: 10,
    working_days_per_month: 22,
    stops_per_rep_per_day: 23,
    plans_per_month_per_rep: 4,
    optimizer_mode: 'classic',
    geocoding_calls_per_month: 500,
    routes_matrix_elements_per_plan: 600,
    routes_route_calls_per_plan: 50,
  },
  sucursal_full: {
    label: 'Sucursal completa',
    description: '50 reps × 22 días × 23 stops/día, sin re-planificación intradía',
    reps: 50,
    working_days_per_month: 22,
    stops_per_rep_per_day: 23,
    plans_per_month_per_rep: 4,
    optimizer_mode: 'single_vehicle',
    geocoding_calls_per_month: 2000,
    routes_matrix_elements_per_plan: 600,
    routes_route_calls_per_plan: 50,
  },
  nacional: {
    label: 'Marzam nacional',
    description: '200 reps × 22 días, optimizer activado para todos',
    reps: 200,
    working_days_per_month: 22,
    stops_per_rep_per_day: 23,
    plans_per_month_per_rep: 4,
    optimizer_mode: 'single_vehicle',
    geocoding_calls_per_month: 10000,
    routes_matrix_elements_per_plan: 600,
    routes_route_calls_per_plan: 50,
  },
  fleet_warning: {
    label: '⚠ Sucursal con Fleet Routing (anti-pattern)',
    description: '50 reps. Demuestra qué pasa si un dev mete 2+ vehicles por error',
    reps: 50,
    working_days_per_month: 22,
    stops_per_rep_per_day: 23,
    plans_per_month_per_rep: 4,
    optimizer_mode: 'fleet',
    geocoding_calls_per_month: 2000,
    routes_matrix_elements_per_plan: 600,
    routes_route_calls_per_plan: 50,
  },
});

// Suscripciones publicadas por Google (post-marzo 2025). Para fines del
// simulador asumimos que el bloque combinado se aplica a Geocoding + Routes,
// y que Route Optimization siempre se factura aparte por SKU.
const SUBSCRIPTIONS = Object.freeze({
  starter: { label: 'Starter', monthly_usd: 100, combined_calls: 50000, includes_single_opt: true },
  essentials: { label: 'Essentials', monthly_usd: 275, combined_calls: 100000, includes_single_opt: true },
  pro: { label: 'Pro', monthly_usd: 1200, combined_calls: 250000, includes_single_opt: false },
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function safePositive(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Calcula bloques de costos para un escenario hipotético. Cada bloque incluye
 * real (piecewise con free tier) y naive (lineal pesimista) más el ahorro y
 * la franja de free tier restante. Por construcción, NO sirve para facturar —
 * sirve para presupuestar.
 */
function simulateMonth(input = {}) {
  const inputs = {
    reps: safePositive(input.reps, 0),
    working_days_per_month: safePositive(input.working_days_per_month, 22),
    stops_per_rep_per_day: safePositive(input.stops_per_rep_per_day, 23),
    plans_per_month_per_rep: safePositive(input.plans_per_month_per_rep, 4),
    optimizer_mode: ['classic', 'single_vehicle', 'fleet'].includes(input.optimizer_mode)
      ? input.optimizer_mode : 'classic',
    geocoding_calls_per_month: safePositive(input.geocoding_calls_per_month, 0),
    routes_matrix_elements_per_plan: safePositive(input.routes_matrix_elements_per_plan, 600),
    routes_route_calls_per_plan: safePositive(input.routes_route_calls_per_plan, 50),
  };

  // Total shipments del mes: reps × días × stops. Cada uno es 1 "envío"
  // para el solver de Optimization API.
  const totalShipments = inputs.reps * inputs.working_days_per_month * inputs.stops_per_rep_per_day;

  // Para el solver clásico (multiStart), el costo cae en Routes API
  // (matrix + single route calls). El solver de Optimization API consume
  // matrix también, pero LA INYECTAMOS pre-calculada para que Google NO
  // re-cobre. La cuenta de matrix/route_calls aplica a AMBOS modos (es nuestro
  // cache hidratado), así que se calcula igual independientemente del mode.
  const totalPlansPerMonth = inputs.reps * inputs.plans_per_month_per_rep;
  const routesMatrixElementsTotal = totalPlansPerMonth * inputs.routes_matrix_elements_per_plan;
  const routesRouteCallsTotal = totalPlansPerMonth * inputs.routes_route_calls_per_plan;
  const routesBillableElements = routesMatrixElementsTotal + routesRouteCallsTotal;

  // -- Bloque 1: Geocoding (Essentials curve) --
  const geo = pricing.enrich(inputs.geocoding_calls_per_month, { tier: 'essentials' });
  const geocodingBlock = {
    monthly_volume: inputs.geocoding_calls_per_month,
    free_tier_limit: 10000,
    free_tier_remaining: geo.free_tier_remaining,
    real_usd: geo.est_cost_real_usd,
    naive_usd: geo.est_cost_naive_usd,
    savings_usd: geo.est_savings_vs_naive,
    tier_curve: 'essentials',
    note: 'Free 10k calls/mes; post-free $5/1k cae a $1.5/1k sobre 1M+.',
  };

  // -- Bloque 2: Routes API (Essentials, asumiendo TRAFFIC_UNAWARE) --
  const routesEnrich = pricing.enrich(routesBillableElements, { tier: 'essentials' });
  const routesBlock = {
    monthly_volume: routesBillableElements,
    matrix_elements: routesMatrixElementsTotal,
    route_calls: routesRouteCallsTotal,
    free_tier_limit: 10000,
    free_tier_remaining: routesEnrich.free_tier_remaining,
    real_usd: routesEnrich.est_cost_real_usd,
    naive_usd: routesEnrich.est_cost_naive_usd,
    savings_usd: routesEnrich.est_savings_vs_naive,
    tier_curve: 'essentials',
    note: 'TRAFFIC_UNAWARE; cambiar a TRAFFIC_AWARE dobla el precio (curva Pro).',
  };

  // -- Bloque 3: Route Optimization API --
  // Solo se factura en modes single_vehicle | fleet. En modo classic el
  // solver vive en JS (NN + 2-opt) y NO consume esta API.
  let optBlock = null;
  if (inputs.optimizer_mode !== 'classic') {
    const kind = inputs.optimizer_mode === 'fleet' ? 'fleet' : 'single';
    const real = pricing.routeOptimizationCost(totalShipments, { kind });
    // Naive: la primera banda paga (post-free) aplicada al volumen completo.
    const baseRatePerK = kind === 'fleet' ? 30 : 10;
    const naive = round2((totalShipments / 1000) * baseRatePerK);
    const freeTierLimit = kind === 'fleet' ? 1000 : 5000;
    optBlock = {
      sku: kind,
      sku_label: kind === 'fleet' ? 'Fleet Routing (Enterprise)' : 'Single Vehicle Routing (Pro)',
      monthly_volume: totalShipments,
      free_tier_limit: freeTierLimit,
      free_tier_remaining: Math.max(0, freeTierLimit - totalShipments),
      real_usd: real,
      naive_usd: naive,
      savings_usd: Math.max(0, round2(naive - real)),
      tier_curve: kind === 'fleet' ? 'enterprise' : 'pro',
      note: kind === 'fleet'
        ? '⚠ Activado por 2+ vehicles en el payload. ~3× el costo de Single SKU.'
        : 'Activado por 1 vehicle por (rep,day). Free tier de 5k shipments/mes.',
    };
  }

  // -- Totales y proyección anual --
  const totalRealMonthly = round2(
    geocodingBlock.real_usd + routesBlock.real_usd + (optBlock?.real_usd || 0),
  );
  const totalNaiveMonthly = round2(
    geocodingBlock.naive_usd + routesBlock.naive_usd + (optBlock?.naive_usd || 0),
  );
  const totalSavingsMonthly = round2(Math.max(0, totalNaiveMonthly - totalRealMonthly));

  // -- Comparativa contra planes de suscripción --
  // Solo aplica si el escenario está dentro de la "bolsa combinada" del plan
  // (Geocoding + Routes calls). Route Optimization se cobra aparte excepto
  // por Starter/Essentials que incluyen Single Vehicle (la doc oficial NO
  // incluye Fleet en ningún plan).
  const combinedNonOptCalls = inputs.geocoding_calls_per_month + routesBillableElements;
  const subscriptionAnalysis = Object.entries(SUBSCRIPTIONS).map(([key, plan]) => {
    let extraOptUsd = 0;
    let coversCombined = combinedNonOptCalls <= plan.combined_calls;
    if (optBlock) {
      if (plan.includes_single_opt && optBlock.sku === 'single') {
        // Single Vehicle queda dentro de la bolsa combinada del plan.
        const totalInBag = combinedNonOptCalls + optBlock.monthly_volume;
        coversCombined = totalInBag <= plan.combined_calls;
        extraOptUsd = 0;
      } else {
        extraOptUsd = optBlock.real_usd;
      }
    }
    const overage = coversCombined ? 0 : (
      // Excedente — si rebasamos la bolsa, igualamos a pago-por-uso real para
      // el delta. Aproximación conservadora.
      round2(totalRealMonthly - (plan.includes_single_opt ? extraOptUsd : 0))
    );
    return {
      plan: key,
      label: plan.label,
      monthly_base_usd: plan.monthly_usd,
      covers_combined: coversCombined,
      extra_opt_usd: extraOptUsd,
      overage_usd: overage,
      effective_monthly_usd: round2(plan.monthly_usd + extraOptUsd + overage),
      includes_single_opt: plan.includes_single_opt,
      notes: optBlock && optBlock.sku === 'fleet'
        ? 'Fleet Routing NO se incluye en ningún plan; se factura aparte siempre.'
        : '',
    };
  });

  return {
    inputs,
    totals: {
      total_shipments_per_month: totalShipments,
      total_plans_per_month: totalPlansPerMonth,
      routes_billable_elements_per_month: routesBillableElements,
    },
    geocoding: geocodingBlock,
    routes_api: routesBlock,
    route_optimization: optBlock,
    grand_total: {
      monthly_real_usd: totalRealMonthly,
      monthly_naive_usd: totalNaiveMonthly,
      monthly_savings_usd: totalSavingsMonthly,
      annual_real_usd: round2(totalRealMonthly * 12),
      annual_naive_usd: round2(totalNaiveMonthly * 12),
      annual_savings_usd: round2(totalSavingsMonthly * 12),
    },
    subscriptions: subscriptionAnalysis,
    // Recomendación textual basada en heurísticas simples — la UI puede
    // renderizarla como un highlight.
    recommendation: recommend({ totalRealMonthly, optBlock, subscriptionAnalysis }),
    generated_at: new Date().toISOString(),
  };
}

function recommend({ totalRealMonthly, optBlock, subscriptionAnalysis }) {
  if (optBlock && optBlock.sku === 'fleet') {
    return {
      level: 'critical',
      title: '⚠ Modo Fleet Routing — revisa el payload',
      body: 'El escenario activa el SKU Enterprise (2+ vehicles). El plan-editor actual usa 1 vehicle por (rep,day), así que esto solo pasa si alguien introduce un payload manual con varios vehículos. El costo por shipment es ~3× más caro que Single Vehicle.',
    };
  }
  if (totalRealMonthly === 0) {
    return {
      level: 'info',
      title: 'Operación gratuita',
      body: 'Todo el volumen cabe en los free tiers — no se factura nada en estos parámetros.',
    };
  }
  // Plan que minimiza el costo total efectivo.
  const cheapestSubs = subscriptionAnalysis
    .filter((s) => s.covers_combined)
    .sort((a, b) => a.effective_monthly_usd - b.effective_monthly_usd)[0];
  if (cheapestSubs && cheapestSubs.effective_monthly_usd < totalRealMonthly) {
    return {
      level: 'info',
      title: `Considera plan ${cheapestSubs.label}`,
      body: `Pago por uso ~$${totalRealMonthly.toFixed(2)}/mes; con plan ${cheapestSubs.label} pagarías $${cheapestSubs.effective_monthly_usd.toFixed(2)}/mes. Ahorro anual potencial ~$${round2((totalRealMonthly - cheapestSubs.effective_monthly_usd) * 12)}.`,
    };
  }
  return {
    level: 'info',
    title: 'Pago por uso es la opción más económica',
    body: 'Los planes de suscripción no compensan a este volumen. Reevaluar trimestralmente si el volumen crece.',
  };
}

module.exports = {
  PRESETS,
  SUBSCRIPTIONS,
  simulateMonth,
  __recommend: recommend, // exported for tests
};
