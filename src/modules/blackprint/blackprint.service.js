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
    total_today_usd: 0,
    total_mtd_usd: 0,
    generated_at: new Date().toISOString(),
  };

  // -- Routes API (mig 061) --
  if (await tableExists('routes_api_spend')) {
    const todayRow = await db('routes_api_spend').where({ day: today }).first();
    const mtdAgg = await db('routes_api_spend')
      .where('day', '>=', monthStart)
      .sum({ usd: 'est_cost_usd', matrix_calls: 'matrix_calls', rejected: 'rejected_calls' })
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

    out.routes_api = {
      today_usd: Number(todayRow?.est_cost_usd || 0),
      today_matrix_calls: Number(todayRow?.matrix_calls || 0),
      today_route_calls: Number(todayRow?.route_calls || 0),
      today_rejected_calls: Number(todayRow?.rejected_calls || 0),
      mtd_usd: Number(mtdAgg?.usd || 0),
      mtd_matrix_calls: Number(mtdAgg?.matrix_calls || 0),
      mtd_rejected_calls: Number(mtdAgg?.rejected || 0),
      ytd_usd: Number(ytdAgg?.usd || 0),
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

module.exports = {
  costSummary,
  geocodingQuality,
  systemHealth,
  usageMetrics,
  directory,
};
