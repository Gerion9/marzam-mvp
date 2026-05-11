/**
 * BlackPrint admin — composition layer for platform observability.
 *
 * Each function aggregates from existing infrastructure tables (no new
 * heavyweight queries) plus in-memory metrics from middlewares/services.
 * Defensive: every table read is gated on `to_regclass` so a deploy with
 * partial migrations still returns a useful shape instead of erroring.
 *
 * Tables consumed:
 *   routes_api_spend       (mig 061)  — Google Routes daily USD
 *   geocoding_api_spend    (mig 092)  — Google Geocoding daily USD (new)
 *   cron_runs              (mig 067)  — cron health
 *   bq_sync_warnings       (mig 036)  — sync diagnostics
 *   bq_sync_checkpoints    (mig 084)  — sync freshness
 *   error_log              (mig 082)  — recent 5xx
 *   import_jobs            (mig 029)  — import success/failure rate
 *   live_event_outbox      (mig 065)  — outbox depth
 *   rate_limit_buckets     (mig 080)  — rate-limit hits
 *   geocode_cache          (mig 062)  — cache hit rate
 *   pharmacies, users      — geocoding quality
 *
 * In-memory:
 *   live.getMetrics()        — active SSE subscriptions per process
 *   demoReadonly.getDemoMetrics() — demo write blocks counter
 *   routesMatrix.getStats()  — cache hit rate per process
 */

const db = require('../../config/database');
const accessDirectory = require('../../services/accessDirectory');
const pricing = require('../../services/pricing');
const costSimulator = require('../../services/costSimulator');

// Threshold para sugerir suscripción / negociar tarifa enterprise. Si el MTD
// pesimista (naive) supera este corte, el dashboard muestra un widget de
// "subscription suggestion".
const SUBSCRIPTION_SUGGEST_THRESHOLD_USD = 1000;

async function tableExists(name) {
  const r = await db.raw('SELECT to_regclass(?) AS t', [name]);
  return Boolean(r.rows?.[0]?.t);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function monthStartISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function yearStartISO() {
  return `${new Date().getUTCFullYear()}-01-01`;
}

async function costSummary() {
  const today = todayISO();
  const monthStart = monthStartISO();
  const yearStart = yearStartISO();
  const out = {
    routes_api: null,
    geocoding_api: null,
    route_optimization_api: null,
    total_today_usd: 0,
    total_mtd_usd: 0,
    total_mtd_real_usd: 0,
    total_mtd_savings_usd: 0,
    subscription_suggestion: null,
    generated_at: new Date().toISOString(),
  };

  // -- Routes API (mig 061) --
  if (await tableExists('routes_api_spend')) {
    const todayRow = await db('routes_api_spend').where({ day: today }).first();
    const mtdAgg = await db('routes_api_spend')
      .where('day', '>=', monthStart)
      .sum({
        usd: 'est_cost_usd',
        matrix_calls: 'matrix_calls',
        matrix_elements: 'matrix_elements',
        route_calls: 'route_calls',
        rejected: 'rejected_calls',
      })
      .first();
    const ytdAgg = await db('routes_api_spend')
      .where('day', '>=', yearStart)
      .sum({ usd: 'est_cost_usd' })
      .first();
    const breakdown = await db('routes_api_spend')
      .where('day', '>=', monthStart)
      .orderBy('day', 'asc')
      .select('day', 'matrix_calls', 'matrix_elements', 'route_calls', 'est_cost_usd', 'rejected_calls');

    let cacheStats = null;
    try {
      // eslint-disable-next-line global-require
      cacheStats = require('../../services/routesMatrix').getStats?.() || null;
    } catch { /* optional */ }

    // Para piecewise usamos elementos facturables = matrix_elements + route_calls.
    // Routes API cobra por elementos de matriz (NxM) y por single-route calls;
    // ambos al mismo precio en el tier essentials. Esto es el volumen que come
    // free tier y degrada tiers (post-marzo 2025).
    const mtdBillable = Number(mtdAgg?.matrix_elements || 0) + Number(mtdAgg?.route_calls || 0);
    const enriched = pricing.enrich(mtdBillable, { tier: 'essentials' });

    out.routes_api = {
      today_usd: Number(todayRow?.est_cost_usd || 0),
      today_matrix_calls: Number(todayRow?.matrix_calls || 0),
      today_route_calls: Number(todayRow?.route_calls || 0),
      today_rejected_calls: Number(todayRow?.rejected_calls || 0),
      mtd_usd: Number(mtdAgg?.usd || 0),
      mtd_matrix_calls: Number(mtdAgg?.matrix_calls || 0),
      mtd_matrix_elements: Number(mtdAgg?.matrix_elements || 0),
      mtd_route_calls: Number(mtdAgg?.route_calls || 0),
      mtd_billable_elements: mtdBillable,
      mtd_rejected_calls: Number(mtdAgg?.rejected || 0),
      ytd_usd: Number(ytdAgg?.usd || 0),
      // Real (piecewise) vs naive (linear pessimistic).
      mtd_real_usd: enriched.est_cost_real_usd,
      mtd_naive_usd: enriched.est_cost_naive_usd,
      mtd_savings_usd: enriched.est_savings_vs_naive,
      free_tier_remaining: enriched.free_tier_remaining,
      free_tier_limit: 10000,
      tier_curve: 'essentials',
      mtd_breakdown: breakdown.map((r) => ({
        day: r.day,
        matrix_calls: Number(r.matrix_calls || 0),
        matrix_elements: Number(r.matrix_elements || 0),
        route_calls: Number(r.route_calls || 0),
        usd: Number(r.est_cost_usd || 0),
        rejected: Number(r.rejected_calls || 0),
      })),
      cache_stats: cacheStats,
    };
    out.total_today_usd += out.routes_api.today_usd;
    out.total_mtd_usd += out.routes_api.mtd_usd;
    out.total_mtd_real_usd += enriched.est_cost_real_usd;
    out.total_mtd_savings_usd += enriched.est_savings_vs_naive;
  }

  // -- Geocoding API (mig 092) --
  if (await tableExists('geocoding_api_spend')) {
    const todayRow = await db('geocoding_api_spend').where({ day: today }).first();
    const mtdAgg = await db('geocoding_api_spend')
      .where('day', '>=', monthStart)
      .sum({ usd: 'est_cost_usd', calls: 'geocoding_calls', cache_hits: 'cache_hits', rejected: 'rejected_calls' })
      .first();
    const ytdAgg = await db('geocoding_api_spend')
      .where('day', '>=', yearStart)
      .sum({ usd: 'est_cost_usd' })
      .first();
    const breakdown = await db('geocoding_api_spend')
      .where('day', '>=', monthStart)
      .orderBy('day', 'asc')
      .select('day', 'geocoding_calls', 'cache_hits', 'rejected_calls', 'est_cost_usd');

    const mtdCalls = Number(mtdAgg?.calls || 0);
    const mtdCacheHits = Number(mtdAgg?.cache_hits || 0);
    const total = mtdCalls + mtdCacheHits;
    // Solo las llamadas a Google (no cache hits) cuentan para el free tier.
    const enriched = pricing.enrich(mtdCalls, { tier: 'essentials' });

    out.geocoding_api = {
      today_usd: Number(todayRow?.est_cost_usd || 0),
      today_calls: Number(todayRow?.geocoding_calls || 0),
      today_cache_hits: Number(todayRow?.cache_hits || 0),
      today_rejected: Number(todayRow?.rejected_calls || 0),
      mtd_usd: Number(mtdAgg?.usd || 0),
      mtd_calls: mtdCalls,
      mtd_cache_hits: mtdCacheHits,
      mtd_rejected: Number(mtdAgg?.rejected || 0),
      mtd_cache_hit_rate: total > 0 ? mtdCacheHits / total : null,
      ytd_usd: Number(ytdAgg?.usd || 0),
      mtd_real_usd: enriched.est_cost_real_usd,
      mtd_naive_usd: enriched.est_cost_naive_usd,
      mtd_savings_usd: enriched.est_savings_vs_naive,
      free_tier_remaining: enriched.free_tier_remaining,
      free_tier_limit: 10000,
      tier_curve: 'essentials',
      mtd_breakdown: breakdown.map((r) => ({
        day: r.day,
        calls: Number(r.geocoding_calls || 0),
        cache_hits: Number(r.cache_hits || 0),
        rejected: Number(r.rejected_calls || 0),
        usd: Number(r.est_cost_usd || 0),
      })),
    };
    out.total_today_usd += out.geocoding_api.today_usd;
    out.total_mtd_usd += out.geocoding_api.mtd_usd;
    out.total_mtd_real_usd += enriched.est_cost_real_usd;
    out.total_mtd_savings_usd += enriched.est_savings_vs_naive;
  }

  // -- Route Optimization API (mig 095 + 096) --
  // La tabla existe aunque el feature flag PLAN_USE_OPTIMIZATION_API esté off
  // (devolverá 0s). Google bifurca dinámicamente el SKU según vehicles.length
  // del payload — almacenamos counts separados per SKU (Single/Fleet) en mig
  // 096. Free tier y curva piecewise también difieren por SKU.
  if (await tableExists('route_optimization_api_spend')) {
    // Detect availability of the mig-096 columns so older deploys keep
    // rendering the legacy aggregate shape without crashing.
    const hasSkuSplit = await db.schema.hasColumn('route_optimization_api_spend', 'single_vehicle_shipments');

    const todayRow = await db('route_optimization_api_spend').where({ day: today }).first();
    const mtdSum = {
      usd: 'est_cost_usd',
      calls: 'optimization_calls',
      shipments: 'total_shipments',
      vehicles: 'total_vehicles',
      rejected: 'rejected_calls',
      failed: 'failed_calls',
    };
    if (hasSkuSplit) {
      Object.assign(mtdSum, {
        single_calls: 'single_vehicle_calls',
        single_shipments: 'single_vehicle_shipments',
        fleet_calls: 'fleet_routing_calls',
        fleet_shipments: 'fleet_routing_shipments',
        validate_only: 'validate_only_calls',
      });
    }
    const mtdAgg = await db('route_optimization_api_spend')
      .where('day', '>=', monthStart)
      .sum(mtdSum)
      .first();
    const ytdAgg = await db('route_optimization_api_spend')
      .where('day', '>=', yearStart)
      .sum({ usd: 'est_cost_usd' })
      .first();
    const breakdownCols = [
      'day', 'optimization_calls', 'total_vehicles', 'total_shipments',
      'est_cost_usd', 'rejected_calls', 'failed_calls',
    ];
    if (hasSkuSplit) {
      breakdownCols.push(
        'single_vehicle_calls', 'single_vehicle_shipments',
        'fleet_routing_calls', 'fleet_routing_shipments',
        'validate_only_calls',
      );
    }
    const breakdown = await db('route_optimization_api_spend')
      .where('day', '>=', monthStart)
      .orderBy('day', 'asc')
      .select(...breakdownCols);

    const singleMtd = Number(mtdAgg?.single_shipments || 0);
    const fleetMtd = Number(mtdAgg?.fleet_shipments || 0);

    // Real (piecewise) per SKU vs naive: naive uses the first paid tier rate
    // for both SKUs as the pessimistic baseline (matches how dashboards in
    // routes_api/geocoding_api already compute "naive").
    const singleEnriched = {
      est_cost_real_usd: pricing.routeOptimizationCost(singleMtd, { kind: 'single' }),
      free_tier_remaining: Math.max(0, 5000 - singleMtd),
      free_tier_limit: 5000,
    };
    const fleetEnriched = {
      est_cost_real_usd: pricing.routeOptimizationCost(fleetMtd, { kind: 'fleet' }),
      free_tier_remaining: Math.max(0, 1000 - fleetMtd),
      free_tier_limit: 1000,
    };
    // Naive: cost-as-if-all-shipments-were-billable-at-base-rate.
    const singleNaive = Math.round((singleMtd / 1000) * 10 * 10000) / 10000;
    const fleetNaive = Math.round((fleetMtd / 1000) * 30 * 10000) / 10000;

    out.route_optimization_api = {
      today_usd: Number(todayRow?.est_cost_usd || 0),
      today_calls: Number(todayRow?.optimization_calls || 0),
      today_shipments: Number(todayRow?.total_shipments || 0),
      today_vehicles: Number(todayRow?.total_vehicles || 0),
      mtd_usd: Number(mtdAgg?.usd || 0),
      mtd_calls: Number(mtdAgg?.calls || 0),
      mtd_shipments: Number(mtdAgg?.shipments || 0),
      mtd_vehicles: Number(mtdAgg?.vehicles || 0),
      mtd_rejected: Number(mtdAgg?.rejected || 0),
      mtd_failed: Number(mtdAgg?.failed || 0),
      mtd_validate_only_calls: Number(mtdAgg?.validate_only || 0),
      ytd_usd: Number(ytdAgg?.usd || 0),

      single_vehicle: hasSkuSplit ? {
        mtd_calls: Number(mtdAgg?.single_calls || 0),
        mtd_shipments: singleMtd,
        ...singleEnriched,
        est_cost_naive_usd: singleNaive,
        est_savings_vs_naive: Math.max(0, Math.round((singleNaive - singleEnriched.est_cost_real_usd) * 10000) / 10000),
        tier_curve: 'pro',
      } : null,
      fleet_routing: hasSkuSplit ? {
        mtd_calls: Number(mtdAgg?.fleet_calls || 0),
        mtd_shipments: fleetMtd,
        ...fleetEnriched,
        est_cost_naive_usd: fleetNaive,
        est_savings_vs_naive: Math.max(0, Math.round((fleetNaive - fleetEnriched.est_cost_real_usd) * 10000) / 10000),
        tier_curve: 'enterprise',
      } : null,

      mtd_breakdown: breakdown.map((r) => ({
        day: r.day,
        calls: Number(r.optimization_calls || 0),
        vehicles: Number(r.total_vehicles || 0),
        shipments: Number(r.total_shipments || 0),
        usd: Number(r.est_cost_usd || 0),
        rejected: Number(r.rejected_calls || 0),
        failed: Number(r.failed_calls || 0),
        single_shipments: hasSkuSplit ? Number(r.single_vehicle_shipments || 0) : null,
        fleet_shipments: hasSkuSplit ? Number(r.fleet_routing_shipments || 0) : null,
        validate_only_calls: hasSkuSplit ? Number(r.validate_only_calls || 0) : null,
      })),
    };
    out.total_today_usd += out.route_optimization_api.today_usd;
    out.total_mtd_usd += out.route_optimization_api.mtd_usd;
    // Real piecewise (mig 096 enabled): sum of real-per-SKU. Legacy fallback:
    // use the historical aggregate (which mirrored naive linear).
    out.total_mtd_real_usd += hasSkuSplit
      ? (singleEnriched.est_cost_real_usd + fleetEnriched.est_cost_real_usd)
      : out.route_optimization_api.mtd_usd;
    if (hasSkuSplit) {
      out.total_mtd_savings_usd
        += out.route_optimization_api.single_vehicle.est_savings_vs_naive
         + out.route_optimization_api.fleet_routing.est_savings_vs_naive;
    }
  }

  // Subscription suggestion — si el naive MTD ya cruzó el umbral, sugerimos
  // negociar una suscripción / tarifa enterprise. Calculamos break-even como
  // el volumen al cual la suscripción Pro mensual ($1200) se paga sola contra
  // el ritmo lineal — el dashboard lo usa para mostrar "a tu ritmo gastarías
  // $X/mes, plan Pro ahorraría $Y, break-even Z elementos".
  if (out.total_mtd_usd >= SUBSCRIPTION_SUGGEST_THRESHOLD_USD) {
    out.subscription_suggestion = {
      reason: 'mtd_above_threshold',
      threshold_usd: SUBSCRIPTION_SUGGEST_THRESHOLD_USD,
      current_mtd_naive_usd: out.total_mtd_usd,
      estimated_real_mtd_usd: out.total_mtd_real_usd,
      potential_savings_usd: out.total_mtd_savings_usd,
      // El usuario validará con Google la oferta concreta; estos valores son
      // de referencia para el widget. Cambian sin migration.
      ref_plan: 'pro_1200',
      break_even_hint:
        'Break-even contra plan Pro hipotético depende del volumen real y la tasa negociada — usa esto como prompt para abrir conversación con tu account manager.',
    };
  }

  return out;
}

async function geocodingQuality() {
  const out = {
    pharmacies: { total: 0, with_coords: 0, without_coords: 0, pct_geocoded: null, by_source: [] },
    users: { reps_total: 0, reps_with_home: 0, pct_geocoded: null, geocoded_last_7d: 0 },
    cache: { entries: 0, total_hits: 0 },
    top_missing: [],
    generated_at: new Date().toISOString(),
  };

  if (await tableExists('pharmacies')) {
    const totalRow = await db('pharmacies').count({ n: '*' }).first();
    out.pharmacies.total = Number(totalRow?.n || 0);
    const withRow = await db('pharmacies').whereNotNull('coordinates').count({ n: '*' }).first();
    out.pharmacies.with_coords = Number(withRow?.n || 0);
    out.pharmacies.without_coords = out.pharmacies.total - out.pharmacies.with_coords;
    out.pharmacies.pct_geocoded = out.pharmacies.total > 0
      ? out.pharmacies.with_coords / out.pharmacies.total
      : null;
    // top 50 sin coords (defensive: name may be null)
    out.top_missing = await db('pharmacies')
      .whereNull('coordinates')
      .select('id', 'name', 'address')
      .limit(50);
  }

  if (await tableExists('users')) {
    const repsRow = await db('users').where({ is_active: true, role: 'representante' }).count({ n: '*' }).first();
    out.users.reps_total = Number(repsRow?.n || 0);
    const withHomeRow = await db('users')
      .where({ is_active: true, role: 'representante' })
      .whereNotNull('home_lat')
      .count({ n: '*' })
      .first();
    out.users.reps_with_home = Number(withHomeRow?.n || 0);
    out.users.pct_geocoded = out.users.reps_total > 0
      ? out.users.reps_with_home / out.users.reps_total
      : null;
    const last7 = await db('users')
      .where({ is_active: true, role: 'representante' })
      .whereRaw("home_geocoded_at >= NOW() - INTERVAL '7 days'")
      .count({ n: '*' })
      .first();
    out.users.geocoded_last_7d = Number(last7?.n || 0);
  }

  if (await tableExists('geocode_cache')) {
    const cacheRow = await db('geocode_cache')
      .count({ entries: '*' })
      .sum({ total_hits: 'hits' })
      .first();
    out.cache.entries = Number(cacheRow?.entries || 0);
    out.cache.total_hits = Number(cacheRow?.total_hits || 0);
  }

  return out;
}

async function systemHealth() {
  const out = {
    cron_runs: [],
    bq_sync_checkpoints: [],
    bq_sync_warnings_7d: [],
    error_log_24h_count: 0,
    error_log_top_paths_24h: [],
    live_outbox_depth: 0,
    generated_at: new Date().toISOString(),
  };

  if (await tableExists('cron_runs')) {
    out.cron_runs = await db('cron_runs').orderBy('job_key').select('*');
  }
  if (await tableExists('bq_sync_checkpoints')) {
    out.bq_sync_checkpoints = await db('bq_sync_checkpoints').orderBy('job_key').select('*');
  }
  if (await tableExists('bq_sync_warnings')) {
    out.bq_sync_warnings_7d = await db('bq_sync_warnings')
      .whereRaw("occurred_at >= NOW() - INTERVAL '7 days'")
      .select('job_name', 'code', 'severity')
      .count({ n: '*' })
      .groupBy('job_name', 'code', 'severity')
      .orderBy('n', 'desc')
      .limit(50);
  }
  if (await tableExists('error_log')) {
    const cnt = await db('error_log')
      .whereRaw("occurred_at >= NOW() - INTERVAL '24 hours'")
      .count({ n: '*' })
      .first();
    out.error_log_24h_count = Number(cnt?.n || 0);
    out.error_log_top_paths_24h = await db('error_log')
      .whereRaw("occurred_at >= NOW() - INTERVAL '24 hours'")
      .select('path', 'status')
      .count({ n: '*' })
      .groupBy('path', 'status')
      .orderBy('n', 'desc')
      .limit(20);
  }
  if (await tableExists('live_event_outbox')) {
    const depth = await db('live_event_outbox').count({ n: '*' }).first();
    out.live_outbox_depth = Number(depth?.n || 0);
  }

  return out;
}

async function usageMetrics() {
  const out = {
    sse: { active_subscriptions: 0, started_at: null },
    demo: { blocked_writes: 0, passthrough_reads: 0, whitelisted_writes: 0, started_at: null },
    rate_limit_24h: [],
    active_reps_24h: 0,
    pings_24h: 0,
    imports_30d: { total: 0, done: 0, partial: 0, failed: 0 },
    generated_at: new Date().toISOString(),
  };

  try {
    // eslint-disable-next-line global-require
    const liveSvc = require('../live/live.service');
    if (typeof liveSvc.getMetrics === 'function') {
      out.sse = liveSvc.getMetrics();
    }
  } catch { /* optional */ }

  try {
    // eslint-disable-next-line global-require
    const dr = require('../../middleware/demoReadonly');
    if (typeof dr.getDemoMetrics === 'function') {
      out.demo = dr.getDemoMetrics();
    }
  } catch { /* optional */ }

  if (await tableExists('rate_limit_buckets')) {
    out.rate_limit_24h = await db('rate_limit_buckets')
      .whereRaw("window_start >= NOW() - INTERVAL '24 hours'")
      .select('bucket_key')
      .max({ peak: 'count' })
      .groupBy('bucket_key')
      .orderBy('peak', 'desc')
      .limit(50);
  }

  if (await tableExists('rep_tracking_points')) {
    const repsRow = await db('rep_tracking_points')
      .whereRaw("recorded_at >= NOW() - INTERVAL '24 hours'")
      .countDistinct({ n: 'rep_id' })
      .first();
    out.active_reps_24h = Number(repsRow?.n || 0);
    const pingsRow = await db('rep_tracking_points')
      .whereRaw("recorded_at >= NOW() - INTERVAL '24 hours'")
      .count({ n: '*' })
      .first();
    out.pings_24h = Number(pingsRow?.n || 0);
  }

  if (await tableExists('import_jobs')) {
    const last30 = await db('import_jobs')
      .whereRaw("created_at >= NOW() - INTERVAL '30 days'")
      .select('status')
      .count({ n: '*' })
      .groupBy('status');
    for (const row of last30) {
      const n = Number(row.n || 0);
      out.imports_30d.total += n;
      if (row.status === 'done') out.imports_30d.done += n;
      else if (row.status === 'partial') out.imports_30d.partial += n;
      else if (row.status === 'failed') out.imports_30d.failed += n;
    }
  }

  return out;
}

function directory() {
  // No password, no DB lookup — accessDirectory.listUsers() is in-memory.
  const users = accessDirectory.listUsers();
  return {
    count: users.length,
    by_role: users.reduce((acc, u) => {
      const k = u.role || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      is_active: u.is_active,
      employee_code: u.employee_code || null,
      branch_code: u.branch_code || null,
      data_scope: u.data_scope || null,
    })),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Cost simulator — what-if calculator para presupuestar volúmenes hipotéticos
 * sin tocar el spend real. Recibe los parámetros del cliente (reps,
 * working_days, stops/rep, optimizer mode, etc.) o un nombre de preset
 * documentado y devuelve el desglose por API + grand total + comparativa
 * contra planes de suscripción + recomendación textual.
 */
function simulateCost(params = {}) {
  // Si viene un `preset` válido, lo usamos como base; el caller puede
  // sobrescribir campos individuales (útil para "preset + reps custom").
  let inputs = params;
  if (params.preset && costSimulator.PRESETS[params.preset]) {
    inputs = { ...costSimulator.PRESETS[params.preset], ...params };
    delete inputs.preset;
  }
  return {
    presets: costSimulator.PRESETS,
    subscriptions: costSimulator.SUBSCRIPTIONS,
    result: costSimulator.simulateMonth(inputs),
  };
}

module.exports = {
  costSummary,
  geocodingQuality,
  systemHealth,
  usageMetrics,
  directory,
  simulateCost,
};
