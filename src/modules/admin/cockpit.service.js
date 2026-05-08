/**
 * Admin Cockpit service — derives executive KPIs and aggregates over existing
 * tables and materialized views. Read-only; no migrations involved.
 *
 * All public functions follow the same shape:
 *   async fn(params) -> { ...payload, generated_at }
 *
 * Heavy aggregations (coverage-heatmap, hierarchy) use an in-memory TTL cache
 * to keep p95 latency under Vercel's 10s serverless budget.
 */

const db = require('../../config/database');

// ── helpers ───────────────────────────────────────────────────────────────

const cache = new Map();
const DEFAULT_TTL_MS = 60 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function todayISO() { return isoDate(new Date()); }

function startOfMonthISO(d = new Date()) {
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function defaultRange(from, to, fallbackDays = 30) {
  const t = to || todayISO();
  const f = from || daysAgoISO(fallbackDays);
  return { from: f, to: t };
}

function isDbConnectionError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('connection terminated')
    || msg.includes('connection ended')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('connect econn')
    || ['ECONNRESET', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(err.code)
  );
}

async function tableExists(name) {
  const result = await db.raw("SELECT to_regclass(?) AS t", [name]);
  return !!result.rows?.[0]?.t;
}

function pctDelta(current, previous) {
  if (previous == null || Number(previous) === 0) return null;
  return Number((((Number(current) - Number(previous)) / Number(previous)) * 100).toFixed(1));
}

function num(x) { return x == null ? 0 : Number(x); }

// ── 1. HERO ───────────────────────────────────────────────────────────────

async function hero({ compare = 'yesterday' } = {}) {
  const today = todayISO();
  const yesterday = daysAgoISO(1);
  const monthStart = startOfMonthISO();
  const last14 = daysAgoISO(14);

  // 1) Visits today + yesterday
  const visitsRow = await db.raw(`
    SELECT
      COUNT(*) FILTER (WHERE created_at::date = ?::date)::int  AS today,
      COUNT(*) FILTER (WHERE created_at::date = ?::date)::int  AS yesterday
    FROM visit_reports
    WHERE created_at >= ?::date
  `, [today, yesterday, yesterday]);
  const visits_today = num(visitsRow.rows[0]?.today);
  const visits_yesterday = num(visitsRow.rows[0]?.yesterday);

  // 2) Coverage padrón global rolling 30d
  const cov = await db.raw(`
    WITH visited AS (
      SELECT DISTINCT mc.id AS marzam_client_id
      FROM marzam_clients mc
      JOIN visit_reports vr ON vr.pharmacy_id = mc.pharmacy_id
      WHERE vr.created_at >= NOW() - INTERVAL '30 days'
    )
    SELECT
      (SELECT COUNT(*) FROM marzam_clients)::int AS total_clients,
      (SELECT COUNT(*) FROM visited)::int AS visited_clients
  `);
  const totalClients = num(cov.rows[0]?.total_clients);
  const visitedClients = num(cov.rows[0]?.visited_clients);
  const coverage_pct = totalClients > 0
    ? Number(((visitedClients * 100) / totalClients).toFixed(1)) : 0;

  // 3) Monto MTD (daily_sales partitioned)
  let mtd_amount = 0;
  let prev_month_amount_to_date = 0;
  try {
    const mtdRow = await db.raw(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE sale_date >= ?::date AND NOT is_devolution), 0)::numeric AS mtd,
        COALESCE(SUM(amount) FILTER (
          WHERE sale_date >= (?::date - INTERVAL '1 month')::date
            AND sale_date < ?::date - INTERVAL '1 month' + (?::date - ?::date + 1)
            AND NOT is_devolution
        ), 0)::numeric AS prev_month_to_date
      FROM daily_sales
      WHERE sale_date >= (?::date - INTERVAL '1 month')::date
    `, [monthStart, monthStart, monthStart, today, monthStart, monthStart]);
    mtd_amount = num(mtdRow.rows[0]?.mtd);
    prev_month_amount_to_date = num(mtdRow.rows[0]?.prev_month_to_date);
  } catch (_) { /* daily_sales may be empty pre-launch */ }

  // 4) Active reps now (last 5 min)
  let active_reps = 0;
  try {
    const liveRow = await db.raw(`
      SELECT COUNT(DISTINCT rep_id)::int AS active
        FROM gps_pings
       WHERE recorded_at >= NOW() - INTERVAL '5 minutes'
    `);
    active_reps = num(liveRow.rows[0]?.active);
  } catch (_) { /* table may be empty */ }

  // 5) Compliance MTD
  const complRow = await db.raw(`
    WITH agg AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'done')::int AS done,
        COUNT(*) FILTER (WHERE status = 'done' OR status = 'skipped' OR
          (status = 'planned' AND scheduled_date < ?::date))::int AS denom
      FROM visit_plan_assignments
      WHERE scheduled_date >= ?::date AND scheduled_date <= ?::date
    )
    SELECT done, denom FROM agg
  `, [today, monthStart, today]);
  const done = num(complRow.rows[0]?.done);
  const denom = num(complRow.rows[0]?.denom);
  const compliance_mtd = denom > 0
    ? Number(((done * 100) / denom).toFixed(1)) : 0;

  // 6) System health score (cron + budget + imports)
  let cronOkPct = 100; let budgetPct = 100; let importsOkPct = 100;
  try {
    const cronRow = await db.raw(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE last_status = 'ok')::int AS ok,
        COUNT(*) FILTER (
          WHERE last_run_at < NOW() - INTERVAL '24 hours'
        )::int AS stale
      FROM cron_runs
    `);
    const ct = num(cronRow.rows[0]?.total);
    const ok = num(cronRow.rows[0]?.ok);
    const stale = num(cronRow.rows[0]?.stale);
    if (ct > 0) cronOkPct = Math.max(0, Math.round(((ok - stale) / ct) * 100));
  } catch (_) { /* cron_runs may not exist */ }

  try {
    const budRow = await db.raw(`
      SELECT est_cost_usd FROM routes_api_spend
       WHERE day = CURRENT_DATE
    `);
    const used = num(budRow.rows[0]?.est_cost_usd);
    const cap = Number(process.env.ROUTES_API_DAILY_CAP_USD) || 50;
    budgetPct = Math.max(0, Math.round(((cap - used) / cap) * 100));
  } catch (_) { /* fine */ }

  try {
    const impRow = await db.raw(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('done','partial'))::int AS ok
        FROM import_jobs
       WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    const it = num(impRow.rows[0]?.total);
    const iok = num(impRow.rows[0]?.ok);
    if (it > 0) importsOkPct = Math.round((iok / it) * 100);
  } catch (_) { /* fine */ }

  // weighted: 40% cron, 30% budget, 30% imports
  const system_score = Math.round(
    cronOkPct * 0.4 + budgetPct * 0.3 + importsOkPct * 0.3,
  );

  // sparklines: last 14 days for visits + orders + compliance
  const sparkRow = await db.raw(`
    WITH days AS (
      SELECT generate_series(?::date, ?::date, '1 day'::interval)::date AS d
    )
    SELECT
      d.d::text AS day,
      COALESCE(v.cnt, 0)::int AS visits,
      COALESCE(c.done, 0)::int AS done,
      COALESCE(c.denom, 0)::int AS denom
    FROM days d
    LEFT JOIN (
      SELECT created_at::date AS day, COUNT(*) AS cnt
        FROM visit_reports
       WHERE created_at >= ?::date
       GROUP BY created_at::date
    ) v ON v.day = d.d
    LEFT JOIN (
      SELECT scheduled_date AS day,
             COUNT(*) FILTER (WHERE status = 'done') AS done,
             COUNT(*) FILTER (WHERE status = 'done' OR status = 'skipped' OR
                (status = 'planned' AND scheduled_date < ?::date)) AS denom
        FROM visit_plan_assignments
       WHERE scheduled_date >= ?::date
       GROUP BY scheduled_date
    ) c ON c.day = d.d
    ORDER BY d.d
  `, [last14, today, last14, today, last14]);
  const sparkVisits = sparkRow.rows.map((r) => num(r.visits));
  const sparkCompliance = sparkRow.rows.map((r) =>
    num(r.denom) > 0 ? Math.round((num(r.done) * 100) / num(r.denom)) : 0,
  );

  // sales sparkline (separate, since daily_sales partitioned)
  let sparkSales = new Array(14).fill(0);
  try {
    const salesRow = await db.raw(`
      WITH days AS (
        SELECT generate_series(?::date, ?::date, '1 day'::interval)::date AS d
      )
      SELECT d.d::text AS day, COALESCE(SUM(ds.amount) FILTER (WHERE NOT ds.is_devolution), 0)::numeric AS amt
        FROM days d
        LEFT JOIN daily_sales ds ON ds.sale_date = d.d
       GROUP BY d.d ORDER BY d.d
    `, [last14, today]);
    sparkSales = salesRow.rows.map((r) => num(r.amt));
  } catch (_) { /* fine */ }

  return {
    visits_today,
    coverage_pct,
    mtd_amount,
    active_reps,
    compliance_mtd,
    system_score,
    deltas: {
      visits_vs_yesterday_pct: pctDelta(visits_today, visits_yesterday),
      mtd_vs_prev_month_pct: pctDelta(mtd_amount, prev_month_amount_to_date),
      compare_window: compare,
    },
    sparklines: {
      visits_14d: sparkVisits,
      compliance_14d: sparkCompliance,
      sales_14d: sparkSales,
    },
    components: {
      cron_ok_pct: cronOkPct,
      budget_remaining_pct: budgetPct,
      imports_ok_pct: importsOkPct,
    },
    generated_at: new Date().toISOString(),
  };
}

// ── 2. TREND ──────────────────────────────────────────────────────────────

async function trend({ from, to, bucket = 'day' } = {}) {
  const range = defaultRange(from, to, 30);
  const trunc = bucket === 'week' ? 'week' : 'day';

  const visits = await db.raw(`
    SELECT date_trunc(?, created_at)::date::text AS bucket,
           COUNT(*)::int AS visits
      FROM visit_reports
     WHERE created_at::date BETWEEN ?::date AND ?::date
     GROUP BY 1 ORDER BY 1
  `, [trunc, range.from, range.to]);

  const compliance = await db.raw(`
    SELECT date_trunc(?, scheduled_date)::date::text AS bucket,
           COUNT(*) FILTER (WHERE status = 'done')::int AS done,
           COUNT(*)::int AS planned
      FROM visit_plan_assignments
     WHERE scheduled_date BETWEEN ?::date AND ?::date
     GROUP BY 1 ORDER BY 1
  `, [trunc, range.from, range.to]);

  let orders = { rows: [] };
  try {
    orders = await db.raw(`
      SELECT date_trunc(?, sale_date)::date::text AS bucket,
             COUNT(*)::int AS orders_count,
             COALESCE(SUM(amount) FILTER (WHERE NOT is_devolution), 0)::numeric AS orders_amount
        FROM daily_sales
       WHERE sale_date BETWEEN ?::date AND ?::date
       GROUP BY 1 ORDER BY 1
    `, [trunc, range.from, range.to]);
  } catch (_) { /* daily_sales may be empty */ }

  // YoY same window last year (best effort — may have 0)
  let yoyVisitsTotal = null; let yoyOrdersAmount = null;
  try {
    const yoyRow = await db.raw(`
      SELECT
        (SELECT COUNT(*) FROM visit_reports WHERE created_at::date BETWEEN
          (?::date - INTERVAL '1 year')::date AND (?::date - INTERVAL '1 year')::date)::int AS visits,
        (SELECT COALESCE(SUM(amount) FILTER (WHERE NOT is_devolution),0)::numeric FROM daily_sales WHERE sale_date BETWEEN
          (?::date - INTERVAL '1 year')::date AND (?::date - INTERVAL '1 year')::date) AS orders
    `, [range.from, range.to, range.from, range.to]);
    yoyVisitsTotal = num(yoyRow.rows[0]?.visits);
    yoyOrdersAmount = num(yoyRow.rows[0]?.orders);
  } catch (_) { /* fine */ }

  const visitsTotal = visits.rows.reduce((s, r) => s + num(r.visits), 0);
  const ordersTotal = orders.rows?.reduce((s, r) => s + num(r.orders_amount), 0) || 0;

  return {
    range,
    bucket: trunc,
    series: {
      visits: visits.rows.map((r) => ({ bucket: r.bucket, value: num(r.visits) })),
      compliance: compliance.rows.map((r) => ({
        bucket: r.bucket,
        value: num(r.planned) > 0 ? Number(((num(r.done) * 100) / num(r.planned)).toFixed(1)) : 0,
      })),
      orders_count: (orders.rows || []).map((r) => ({ bucket: r.bucket, value: num(r.orders_count) })),
      orders_amount: (orders.rows || []).map((r) => ({ bucket: r.bucket, value: num(r.orders_amount) })),
    },
    totals: {
      visits: visitsTotal,
      orders_amount: ordersTotal,
    },
    yoy: {
      visits_pct: pctDelta(visitsTotal, yoyVisitsTotal),
      orders_amount_pct: pctDelta(ordersTotal, yoyOrdersAmount),
    },
    generated_at: new Date().toISOString(),
  };
}

// ── 3. COVERAGE HEATMAP ───────────────────────────────────────────────────

async function coverageHeatmap({ level = 'poblacion', days = 30 } = {}) {
  const cacheKey = `coverage:${level}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const colName = level === 'municipality' ? 'delegacion_municipio' : 'poblacion';

  const rows = await db.raw(`
    WITH base AS (
      SELECT
        mc.${colName} AS region,
        mc.id AS marzam_client_id,
        mc.pareto,
        ph.id AS pharmacy_id,
        ph.coordinates
      FROM marzam_clients mc
      LEFT JOIN pharmacies ph ON ph.id = mc.pharmacy_id
      WHERE mc.${colName} IS NOT NULL
    ),
    visited AS (
      SELECT DISTINCT vr.pharmacy_id
      FROM visit_reports vr
      WHERE vr.created_at >= NOW() - (?::int * INTERVAL '1 day')
    )
    SELECT
      b.region AS name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE v.pharmacy_id IS NOT NULL)::int AS visited,
      COUNT(*) FILTER (WHERE b.pareto = 'A')::int AS pareto_a,
      COUNT(*) FILTER (WHERE b.pareto = 'B')::int AS pareto_b,
      COUNT(*) FILTER (WHERE b.pareto = 'C')::int AS pareto_c,
      AVG(ST_Y(b.coordinates::geometry)) FILTER (WHERE b.coordinates IS NOT NULL) AS lat,
      AVG(ST_X(b.coordinates::geometry)) FILTER (WHERE b.coordinates IS NOT NULL) AS lng
    FROM base b
    LEFT JOIN visited v ON v.pharmacy_id = b.pharmacy_id
    GROUP BY b.region
    ORDER BY total DESC
  `, [days]);

  const features = rows.rows.map((r) => ({
    name: r.name,
    total: num(r.total),
    visited: num(r.visited),
    pct: num(r.total) > 0 ? Number(((num(r.visited) * 100) / num(r.total)).toFixed(1)) : 0,
    pareto: { A: num(r.pareto_a), B: num(r.pareto_b), C: num(r.pareto_c) },
    lat: r.lat ? Number(r.lat) : null,
    lng: r.lng ? Number(r.lng) : null,
  }));

  return cacheSet(cacheKey, {
    level,
    days,
    features,
    generated_at: new Date().toISOString(),
  });
}

// ── 4. HIERARCHY ──────────────────────────────────────────────────────────

async function hierarchy({ from, to } = {}) {
  const range = defaultRange(from, to, 30);
  const cacheKey = `hierarchy:${range.from}:${range.to}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // All users with manager link + KPIs aggregated for the period
  const users = await db.raw(`
    SELECT
      u.id, u.full_name, u.email, u.role, u.manager_id, u.is_active,
      u.branch_id, b.name AS branch_name,
      COALESCE(v.visits, 0)::int AS visits,
      COALESCE(v.orders, 0)::int AS orders,
      COALESCE(v.order_amount, 0)::numeric AS order_amount,
      COALESCE(c.done, 0)::int AS done,
      COALESCE(c.denom, 0)::int AS denom,
      COALESCE(g.last_ping, NULL) AS last_ping
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN (
      SELECT rep_id,
             COUNT(*)::int AS visits,
             COUNT(*) FILTER (WHERE order_placed = true)::int AS orders,
             COALESCE(SUM(order_amount), 0)::numeric AS order_amount
        FROM visit_reports
       WHERE created_at::date BETWEEN ?::date AND ?::date
       GROUP BY rep_id
    ) v ON v.rep_id = u.id
    LEFT JOIN (
      SELECT visitor_user_id,
             COUNT(*) FILTER (WHERE status = 'done')::int AS done,
             COUNT(*) FILTER (WHERE status = 'done' OR status = 'skipped' OR
                (status = 'planned' AND scheduled_date < CURRENT_DATE))::int AS denom
        FROM visit_plan_assignments
       WHERE scheduled_date BETWEEN ?::date AND ?::date
       GROUP BY visitor_user_id
    ) c ON c.visitor_user_id = u.id
    LEFT JOIN (
      SELECT rep_id, MAX(recorded_at) AS last_ping FROM gps_pings GROUP BY rep_id
    ) g ON g.rep_id = u.id
    WHERE u.is_active = true
  `, [range.from, range.to, range.from, range.to]);

  const allUsers = users.rows;
  const byId = new Map(allUsers.map((u) => [u.id, {
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    branch_name: u.branch_name,
    manager_id: u.manager_id,
    kpis: {
      visits: num(u.visits),
      orders: num(u.orders),
      order_amount: num(u.order_amount),
      compliance_pct: num(u.denom) > 0 ? Number(((num(u.done) * 100) / num(u.denom)).toFixed(1)) : null,
      conversion_pct: num(u.visits) > 0 ? Number(((num(u.orders) * 100) / num(u.visits)).toFixed(1)) : null,
      presence: presenceFromPing(u.last_ping),
    },
    children: [],
  }]));

  const roots = [];
  for (const node of byId.values()) {
    if (node.manager_id && byId.has(node.manager_id)) {
      byId.get(node.manager_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by role hierarchy then name
  const roleOrder = { admin: 0, director_sucursal: 1, gerente_ventas: 2, supervisor: 3, representante: 4 };
  function sortRecursive(node) {
    node.children.sort((a, b) => {
      const ra = roleOrder[a.role] ?? 99;
      const rb = roleOrder[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return String(a.full_name).localeCompare(String(b.full_name));
    });
    node.children.forEach(sortRecursive);
  }
  roots.forEach(sortRecursive);

  // Roll-up KPIs from children to parents (sums only; pcts recomputed)
  function rollup(node) {
    if (!node.children.length) return;
    node.children.forEach(rollup);
    const sums = { visits: node.kpis.visits, orders: node.kpis.orders, order_amount: node.kpis.order_amount };
    for (const c of node.children) {
      sums.visits += c.kpis.visits;
      sums.orders += c.kpis.orders;
      sums.order_amount += c.kpis.order_amount;
    }
    node.kpis.team_totals = sums;
  }
  roots.forEach(rollup);

  return cacheSet(cacheKey, { range, roots, generated_at: new Date().toISOString() });
}

function presenceFromPing(lastPing) {
  if (!lastPing) return 'offline';
  const ageMin = (Date.now() - new Date(lastPing).getTime()) / 60000;
  if (ageMin < 5) return 'live';
  if (ageMin < 25) return 'idle';
  return 'offline';
}

// ── 5. OPERATIONS ─────────────────────────────────────────────────────────

async function operations({ from, to } = {}) {
  const range = defaultRange(from, to, 7);

  // Routes on-time: assignments with actual_start_time within [expected-15min, expected+15min]
  const onTime = await db.raw(`
    SELECT
      COUNT(*) FILTER (WHERE actual_start_time IS NOT NULL AND expected_start_time IS NOT NULL)::int AS started,
      COUNT(*) FILTER (
        WHERE actual_start_time IS NOT NULL
          AND expected_start_time IS NOT NULL
          AND actual_start_time <= expected_start_time + INTERVAL '15 minutes'
      )::int AS on_time
    FROM visit_plan_assignments
    WHERE scheduled_date BETWEEN ?::date AND ?::date
  `, [range.from, range.to]);

  // Drive-time deviation (CTE because aggregates can't wrap window functions)
  const drive = await db.raw(`
    WITH gaps AS (
      SELECT
        EXTRACT(EPOCH FROM (vpa.actual_start_time
          - LAG(vpa.actual_start_time) OVER (
              PARTITION BY vpa.visit_plan_id, vpa.visitor_user_id
              ORDER BY vpa.route_order
            ))) / 60.0 AS gap_min,
        vpa.expected_travel_minutes AS expected_min
      FROM visit_plan_assignments vpa
      WHERE vpa.scheduled_date BETWEEN ?::date AND ?::date
    )
    SELECT
      AVG(gap_min) FILTER (WHERE gap_min IS NOT NULL AND expected_min IS NOT NULL) AS avg_actual_min,
      AVG(expected_min) FILTER (WHERE expected_min IS NOT NULL) AS avg_expected_min
    FROM gaps
  `, [range.from, range.to]);

  // Idle p50/p90 (visit_sessions)
  const idle = await db.raw(`
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY idle_seconds)::int AS p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY idle_seconds)::int AS p90,
      AVG(idle_seconds)::numeric AS avg
    FROM visit_sessions
    WHERE started_at::date BETWEEN ?::date AND ?::date
      AND idle_seconds IS NOT NULL
  `, [range.from, range.to]);

  // Reoptimizations breakdown
  let reopt = { rows: [] };
  if (await tableExists('visit_plan_reoptimizations')) {
    reopt = await db.raw(`
      SELECT trigger_kind, outcome, COUNT(*)::int AS n,
             AVG(ms_elapsed)::int AS avg_ms,
             AVG(locked_count)::numeric(6,1) AS avg_locked,
             AVG(released_count)::numeric(6,1) AS avg_released
        FROM visit_plan_reoptimizations
       WHERE created_at::date BETWEEN ?::date AND ?::date
       GROUP BY trigger_kind, outcome
       ORDER BY n DESC
    `, [range.from, range.to]);
  }

  // Deviation events
  const deviations = await db.raw(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE deviation_reason ILIKE '%trafico%' OR deviation_reason ILIKE '%traffic%')::int AS traffic,
      COUNT(*) FILTER (WHERE deviation_reason ILIKE '%cerrad%')::int AS closed_pharmacy,
      COUNT(*) FILTER (WHERE deviation_reason ILIKE '%cliente%')::int AS customer
    FROM visit_plan_assignments
    WHERE deviated_at IS NOT NULL
      AND scheduled_date BETWEEN ?::date AND ?::date
  `, [range.from, range.to]);

  // Sessions abandoned vs ended
  const sessions = await db.raw(`
    SELECT status, ended_reason, COUNT(*)::int AS n
      FROM visit_sessions
     WHERE started_at::date BETWEEN ?::date AND ?::date
     GROUP BY status, ended_reason
     ORDER BY n DESC
  `, [range.from, range.to]);

  return {
    range,
    routes_on_time: {
      started: num(onTime.rows[0]?.started),
      on_time: num(onTime.rows[0]?.on_time),
      pct: num(onTime.rows[0]?.started) > 0
        ? Number(((num(onTime.rows[0]?.on_time) * 100) / num(onTime.rows[0]?.started)).toFixed(1))
        : null,
    },
    drive_time: {
      avg_actual_min: drive.rows[0]?.avg_actual_min ? Number(drive.rows[0].avg_actual_min) : null,
      avg_expected_min: drive.rows[0]?.avg_expected_min ? Number(drive.rows[0].avg_expected_min) : null,
    },
    idle: {
      p50_seconds: num(idle.rows[0]?.p50),
      p90_seconds: num(idle.rows[0]?.p90),
      avg_seconds: num(idle.rows[0]?.avg),
    },
    reoptimizations: reopt.rows || [],
    deviations: {
      total: num(deviations.rows[0]?.total),
      traffic: num(deviations.rows[0]?.traffic),
      closed_pharmacy: num(deviations.rows[0]?.closed_pharmacy),
      customer: num(deviations.rows[0]?.customer),
    },
    sessions: sessions.rows,
    generated_at: new Date().toISOString(),
  };
}

// ── 6. PEOPLE ─────────────────────────────────────────────────────────────

async function people({ from, to, role, branchId } = {}) {
  const range = defaultRange(from, to, 30);

  const params = [range.from, range.to, range.from, range.to];
  let roleClause = '';
  if (role) { roleClause += ' AND u.role = ?'; params.push(role); }
  let branchClause = '';
  if (branchId) { branchClause += ' AND u.branch_id = ?'; params.push(branchId); }

  const ranking = await db.raw(`
    SELECT
      u.id, u.full_name, u.role, u.branch_id, b.name AS branch_name,
      COALESCE(v.visits, 0)::int AS visits,
      COALESCE(v.orders, 0)::int AS orders,
      COALESCE(v.order_amount, 0)::numeric AS order_amount,
      COALESCE(c.done, 0)::int AS done,
      COALESCE(c.denom, 0)::int AS denom,
      u.last_login_at
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      LEFT JOIN (
        SELECT rep_id,
               COUNT(*)::int AS visits,
               COUNT(*) FILTER (WHERE order_placed = true)::int AS orders,
               COALESCE(SUM(order_amount),0)::numeric AS order_amount
          FROM visit_reports
         WHERE created_at::date BETWEEN ?::date AND ?::date
         GROUP BY rep_id
      ) v ON v.rep_id = u.id
      LEFT JOIN (
        SELECT visitor_user_id,
               COUNT(*) FILTER (WHERE status = 'done')::int AS done,
               COUNT(*) FILTER (WHERE status = 'done' OR status = 'skipped' OR
                  (status = 'planned' AND scheduled_date < CURRENT_DATE))::int AS denom
          FROM visit_plan_assignments
         WHERE scheduled_date BETWEEN ?::date AND ?::date
         GROUP BY visitor_user_id
      ) c ON c.visitor_user_id = u.id
     WHERE u.is_active = true ${roleClause} ${branchClause}
     ORDER BY visits DESC NULLS LAST, u.full_name
     LIMIT 200
  `, params);

  const rows = ranking.rows.map((r) => ({
    user_id: r.id,
    full_name: r.full_name,
    role: r.role,
    branch_name: r.branch_name,
    visits: num(r.visits),
    orders: num(r.orders),
    order_amount: num(r.order_amount),
    compliance_pct: num(r.denom) > 0 ? Number(((num(r.done) * 100) / num(r.denom)).toFixed(1)) : null,
    conversion_pct: num(r.visits) > 0 ? Number(((num(r.orders) * 100) / num(r.visits)).toFixed(1)) : null,
    last_login_at: r.last_login_at,
  }));

  // Activity heatmap hour × dow
  const activityMatrix = await db.raw(`
    SELECT EXTRACT(DOW FROM created_at)::int AS dow,
           EXTRACT(HOUR FROM created_at)::int AS hour,
           COUNT(*)::int AS n
      FROM visit_reports
     WHERE created_at::date BETWEEN ?::date AND ?::date
     GROUP BY dow, hour ORDER BY dow, hour
  `, [range.from, range.to]);

  // Compliance heatmap user × day (last 28d)
  const heatmap = await db.raw(`
    SELECT visitor_user_id AS user_id, scheduled_date::text AS day,
           COUNT(*) FILTER (WHERE status = 'done')::int AS done,
           COUNT(*)::int AS planned
      FROM visit_plan_assignments
     WHERE scheduled_date >= CURRENT_DATE - INTERVAL '27 days'
     GROUP BY visitor_user_id, scheduled_date
     ORDER BY visitor_user_id, scheduled_date
  `);

  return {
    range,
    ranking: rows,
    activity_matrix: activityMatrix.rows,
    compliance_heatmap: heatmap.rows.map((r) => ({
      user_id: r.user_id,
      day: r.day,
      done: num(r.done),
      planned: num(r.planned),
      pct: num(r.planned) > 0 ? Number(((num(r.done) * 100) / num(r.planned)).toFixed(1)) : null,
    })),
    generated_at: new Date().toISOString(),
  };
}

// ── 7. COMMERCIAL ─────────────────────────────────────────────────────────

async function commercial({ from, to } = {}) {
  const range = defaultRange(from, to, 30);

  // Sales vs target MTD via mv_avance_mensual if present
  let avance = { rows: [] };
  if (await tableExists('mv_avance_mensual')) {
    try {
      avance = await db.raw(`
        SELECT
          COALESCE(SUM(objetivo), 0)::numeric AS target,
          COALESCE(SUM(amount_total), 0)::numeric AS actual,
          AVG(avance_pct)::numeric(6,2) AS avg_avance_pct
        FROM mv_avance_mensual
        WHERE period = date_trunc('month', CURRENT_DATE)::date
      `);
    } catch (_) { /* ignore */ }
  }
  const target = num(avance.rows[0]?.target);
  const actual = num(avance.rows[0]?.actual);

  // Forecast cierre mes (linear extrapolation: avg daily MTD × days remaining + actual)
  const today = new Date();
  const daysElapsed = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
  const avgDaily = daysElapsed > 0 ? actual / daysElapsed : 0;
  const forecastEom = Math.round(actual + (avgDaily * daysRemaining));

  // Top 20 clients by order_amount
  let topClients = { rows: [] };
  try {
    topClients = await db.raw(`
      SELECT mc.farmacia_nombre, mc.cpadre, mc.pareto,
             COALESCE(SUM(ds.amount) FILTER (WHERE NOT ds.is_devolution), 0)::numeric AS amount
        FROM marzam_clients mc
        LEFT JOIN daily_sales ds ON ds.marzam_client_id = mc.id
       WHERE ds.sale_date BETWEEN ?::date AND ?::date
       GROUP BY mc.id, mc.farmacia_nombre, mc.cpadre, mc.pareto
       HAVING COALESCE(SUM(ds.amount), 0) > 0
       ORDER BY amount DESC
       LIMIT 20
    `, [range.from, range.to]);
  } catch (_) { /* ok */ }

  // Conversion funnel from commercial_leads
  const funnel = await db.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'interested')::int AS interested,
      COUNT(*) FILTER (WHERE status = 'contact_captured')::int AS contact_captured,
      COUNT(*) FILTER (WHERE status = 'follow_up_required')::int AS follow_up_required,
      COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
      COUNT(*) FILTER (WHERE status = 'lost')::int AS lost,
      COUNT(*)::int AS total
    FROM commercial_leads
    WHERE created_at::date BETWEEN ?::date AND ?::date
  `, [range.from, range.to]);

  // Lost reasons
  const lostReasons = await db.raw(`
    SELECT no_order_reason AS reason, COUNT(*)::int AS n
      FROM visit_reports
     WHERE created_at::date BETWEEN ?::date AND ?::date
       AND order_placed = false
       AND no_order_reason IS NOT NULL
     GROUP BY no_order_reason
     ORDER BY n DESC
     LIMIT 20
  `, [range.from, range.to]);

  // RFM rough buckets via mv_pharmacy_sales_rollups
  let rfm = { rows: [] };
  if (await tableExists('mv_pharmacy_sales_rollups')) {
    try {
      rfm = await db.raw(`
        SELECT
          CASE
            WHEN last_sale_date >= CURRENT_DATE - INTERVAL '7 days' THEN 'fresh'
            WHEN last_sale_date >= CURRENT_DATE - INTERVAL '30 days' THEN 'warm'
            ELSE 'cold'
          END AS recency_bucket,
          CASE
            WHEN active_days_30d >= 10 THEN 'high'
            WHEN active_days_30d >= 3 THEN 'mid'
            ELSE 'low'
          END AS frequency_bucket,
          CASE
            WHEN sales_30d > 50000 THEN 'high'
            WHEN sales_30d > 5000 THEN 'mid'
            ELSE 'low'
          END AS monetary_bucket,
          COUNT(*)::int AS n
        FROM mv_pharmacy_sales_rollups
        GROUP BY 1, 2, 3
        ORDER BY n DESC
      `);
    } catch (_) { /* ok */ }
  }

  return {
    range,
    sales_vs_target: {
      target,
      actual,
      pct: target > 0 ? Number(((actual * 100) / target).toFixed(1)) : null,
      forecast_eom: forecastEom,
      forecast_pct_target: target > 0 ? Number(((forecastEom * 100) / target).toFixed(1)) : null,
      days_elapsed: daysElapsed,
      days_remaining: daysRemaining,
    },
    top_clients: (topClients.rows || []).map((r) => ({
      farmacia_nombre: r.farmacia_nombre,
      cpadre: r.cpadre,
      pareto: r.pareto,
      amount: num(r.amount),
    })),
    funnel: funnel.rows[0] || { interested: 0, contact_captured: 0, follow_up_required: 0, converted: 0, lost: 0, total: 0 },
    lost_reasons: lostReasons.rows,
    rfm_buckets: rfm.rows || [],
    generated_at: new Date().toISOString(),
  };
}

// ── 8. ONBOARDING ─────────────────────────────────────────────────────────

async function onboarding({ from, to } = {}) {
  const range = defaultRange(from, to, 30);

  const funnel = await db.raw(`
    SELECT status, COUNT(*)::int AS n
      FROM pharmacy_onboardings
     WHERE created_at::date BETWEEN ?::date AND ?::date
     GROUP BY status
     ORDER BY n DESC
  `, [range.from, range.to]);

  // Avg time per stage (only completed ones)
  const stages = await db.raw(`
    SELECT
      AVG(EXTRACT(EPOCH FROM (submitted_at - created_at)) / 3600.0)
        FILTER (WHERE submitted_at IS NOT NULL) AS avg_hours_to_submit,
      AVG(EXTRACT(EPOCH FROM (updated_at - submitted_at)) / 3600.0)
        FILTER (WHERE submitted_at IS NOT NULL AND status IN ('approved_cash','approved_credit','rejected')) AS avg_hours_to_decision
    FROM pharmacy_onboardings
    WHERE created_at::date BETWEEN ?::date AND ?::date
  `, [range.from, range.to]);

  const splits = await db.raw(`
    SELECT
      COUNT(*) FILTER (WHERE persona_tipo = 'fisica')::int AS fisica,
      COUNT(*) FILTER (WHERE persona_tipo = 'moral')::int AS moral,
      COUNT(*) FILTER (WHERE forma_pago = 'efectivo')::int AS efectivo,
      COUNT(*) FILTER (WHERE forma_pago = 'credito')::int AS credito,
      COUNT(*) FILTER (WHERE credit_decision = 'approved')::int AS credit_approved,
      COUNT(*) FILTER (WHERE credit_decision = 'rejected')::int AS credit_rejected
    FROM pharmacy_onboardings
    WHERE created_at::date BETWEEN ?::date AND ?::date
  `, [range.from, range.to]);

  const docsGap = await db.raw(`
    SELECT po.id, po.rfc, po.nombre_comercial, po.status, po.persona_tipo,
           COUNT(d.id)::int AS docs_uploaded
      FROM pharmacy_onboardings po
      LEFT JOIN pharmacy_onboarding_documents d ON d.onboarding_id = po.id
     WHERE po.status IN ('draft','docs_uploaded','submitted')
       AND po.created_at::date BETWEEN ?::date AND ?::date
     GROUP BY po.id
     ORDER BY docs_uploaded ASC, po.created_at ASC
     LIMIT 30
  `, [range.from, range.to]);

  const emailStatus = await db.raw(`
    SELECT datamaster_email_status AS status, COUNT(*)::int AS n
      FROM pharmacy_onboardings
     WHERE created_at::date BETWEEN ?::date AND ?::date
     GROUP BY datamaster_email_status
  `, [range.from, range.to]);

  return {
    range,
    funnel: funnel.rows,
    stage_times: {
      avg_hours_to_submit: stages.rows[0]?.avg_hours_to_submit ? Number(Number(stages.rows[0].avg_hours_to_submit).toFixed(1)) : null,
      avg_hours_to_decision: stages.rows[0]?.avg_hours_to_decision ? Number(Number(stages.rows[0].avg_hours_to_decision).toFixed(1)) : null,
    },
    splits: splits.rows[0] || {},
    pending_docs: docsGap.rows,
    email_status: emailStatus.rows,
    generated_at: new Date().toISOString(),
  };
}

// ── 9. DATA QUALITY ───────────────────────────────────────────────────────

async function dataQuality() {
  const out = {};

  // Duplicates flagged in review queue
  try {
    const dup = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE flag_type = 'duplicate' AND queue_status = 'pending')::int AS duplicates_pending,
        COUNT(*) FILTER (WHERE queue_status = 'pending')::int AS queue_total_pending,
        COALESCE(MIN(created_at) FILTER (WHERE queue_status = 'pending'), NULL) AS oldest_pending
      FROM review_queue_items
    `);
    out.review_queue = dup.rows[0] || { duplicates_pending: 0, queue_total_pending: 0, oldest_pending: null };
  } catch (_) { out.review_queue = null; }

  // Missing photos (visit reports with no photo row)
  try {
    const missing = await db.raw(`
      SELECT COUNT(*)::int AS missing_photos
        FROM visit_reports vr
       WHERE NOT EXISTS (SELECT 1 FROM visit_photos vp WHERE vp.visit_id = vr.id)
         AND vr.created_at >= NOW() - INTERVAL '90 days'
    `);
    out.missing_photos_90d = num(missing.rows[0]?.missing_photos);
  } catch (_) { out.missing_photos_90d = null; }

  // Quadrant divergence
  try {
    const qd = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE quadrant IS NOT NULL AND quadrant_derived IS NOT NULL AND quadrant <> quadrant_derived)::int AS quadrant_divergence,
        COUNT(*) FILTER (WHERE quadrant IS NULL)::int AS missing_quadrant,
        COUNT(*)::int AS total_pharmacies
      FROM pharmacies
    `);
    out.quadrants = qd.rows[0] || {};
  } catch (_) { out.quadrants = null; }

  // Pareto divergence between pharmacies and marzam_clients
  try {
    const pd = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE p.pareto IS NOT NULL AND mc.pareto IS NOT NULL AND p.pareto <> mc.pareto)::int AS pareto_divergence,
        COUNT(*)::int AS total_pairs
      FROM marzam_clients mc
      JOIN pharmacies p ON p.id = mc.pharmacy_id
    `);
    out.pareto = pd.rows[0] || {};
  } catch (_) { out.pareto = null; }

  // Geocode coverage
  try {
    const geo = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE home_lat IS NOT NULL)::int AS geocoded,
        COUNT(*)::int AS total
      FROM users
      WHERE role = 'representante' AND is_active = true
    `);
    out.geocoding = {
      geocoded: num(geo.rows[0]?.geocoded),
      total: num(geo.rows[0]?.total),
      pct: num(geo.rows[0]?.total) > 0
        ? Number(((num(geo.rows[0]?.geocoded) * 100) / num(geo.rows[0]?.total)).toFixed(1)) : null,
    };
  } catch (_) { out.geocoding = null; }

  // Source distribution (pharmacies)
  try {
    const src = await db.raw(`
      SELECT source, COUNT(*)::int AS n FROM pharmacies GROUP BY source ORDER BY n DESC
    `);
    out.pharmacy_sources = src.rows;
  } catch (_) { out.pharmacy_sources = []; }

  // Sync warnings 7d
  try {
    if (await tableExists('bq_sync_warnings')) {
      const warn = await db.raw(`
        SELECT COUNT(*)::int AS n
          FROM bq_sync_warnings
         WHERE created_at >= NOW() - INTERVAL '7 days'
      `);
      out.sync_warnings_7d = num(warn.rows[0]?.n);
    } else {
      out.sync_warnings_7d = 0;
    }
  } catch (_) { out.sync_warnings_7d = null; }

  // Import jobs failed/partial 30d
  try {
    const jobs = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'partial')::int AS partial,
        COUNT(*)::int AS total
      FROM import_jobs
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    out.import_jobs_30d = jobs.rows[0] || {};
  } catch (_) { out.import_jobs_30d = null; }

  out.generated_at = new Date().toISOString();
  return out;
}

// ── 10. SYSTEM ────────────────────────────────────────────────────────────

async function system() {
  const out = {};

  // Cron runs
  try {
    if (await tableExists('cron_runs')) {
      const cronRows = await db('cron_runs').orderBy('job_key').select('*');
      out.cron_runs = cronRows.map((r) => ({
        job_key: r.job_key,
        last_run_at: r.last_run_at,
        last_status: r.last_status,
        last_payload: r.last_payload,
        lag_seconds: r.last_run_at
          ? Math.round((Date.now() - new Date(r.last_run_at).getTime()) / 1000)
          : null,
      }));
    } else {
      out.cron_runs = [];
    }
  } catch (_) { out.cron_runs = []; }

  // Routes API spend
  try {
    const today = todayISO();
    const monthStart = startOfMonthISO();
    const spend = await db.raw(`
      SELECT
        (SELECT COALESCE(SUM(est_cost_usd), 0) FROM routes_api_spend WHERE day = ?::date) AS today_usd,
        (SELECT COALESCE(SUM(est_cost_usd), 0) FROM routes_api_spend WHERE day >= ?::date) AS mtd_usd,
        (SELECT COALESCE(SUM(matrix_calls), 0) FROM routes_api_spend WHERE day = ?::date) AS today_matrix_calls,
        (SELECT COALESCE(SUM(rejected_calls), 0) FROM routes_api_spend WHERE day = ?::date) AS today_rejected
    `, [today, monthStart, today, today]);
    const cap = Number(process.env.ROUTES_API_DAILY_CAP_USD) || 50;
    out.routes_api = {
      today_usd: num(spend.rows[0]?.today_usd),
      mtd_usd: num(spend.rows[0]?.mtd_usd),
      today_matrix_calls: num(spend.rows[0]?.today_matrix_calls),
      today_rejected_calls: num(spend.rows[0]?.today_rejected),
      daily_cap_usd: cap,
      pct_used: cap > 0
        ? Number(((num(spend.rows[0]?.today_usd) * 100) / cap).toFixed(1)) : null,
    };
  } catch (_) { out.routes_api = null; }

  // Live outbox depth
  try {
    if (await tableExists('live_event_outbox')) {
      const lob = await db.raw(`
        SELECT event_type, COUNT(*)::int AS n
          FROM live_event_outbox
         GROUP BY event_type
         ORDER BY n DESC
      `);
      out.live_outbox = lob.rows;
    } else {
      out.live_outbox = [];
    }
  } catch (_) { out.live_outbox = []; }

  // Audit volume sparkline (last 14 days)
  try {
    const audit = await db.raw(`
      WITH days AS (
        SELECT generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, '1 day'::interval)::date AS d
      )
      SELECT d.d::text AS day, COALESCE(c.n, 0)::int AS n
        FROM days d
        LEFT JOIN (
          SELECT created_at::date AS day, COUNT(*) AS n
            FROM audit_events
           WHERE created_at >= CURRENT_DATE - INTERVAL '13 days'
           GROUP BY 1
        ) c ON c.day = d.d
       ORDER BY d.d
    `);
    out.audit_volume_14d = audit.rows;
  } catch (_) { out.audit_volume_14d = []; }

  // Top entity types changed
  try {
    const top = await db.raw(`
      SELECT entity_type, COUNT(*)::int AS n
        FROM audit_events
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY entity_type
       ORDER BY n DESC
       LIMIT 10
    `);
    out.audit_top_entities_7d = top.rows;
  } catch (_) { out.audit_top_entities_7d = []; }

  // Active sessions
  try {
    if (await tableExists('visit_sessions')) {
      const sess = await db.raw(`
        SELECT COUNT(*)::int AS active
          FROM visit_sessions WHERE status = 'active'
      `);
      out.active_sessions = num(sess.rows[0]?.active);
    }
  } catch (_) { out.active_sessions = 0; }

  // Sync freshness — last successful import_jobs by kind
  try {
    const sync = await db.raw(`
      SELECT kind, MAX(finished_at) AS last_ok
        FROM import_jobs
       WHERE status = 'done'
       GROUP BY kind
       ORDER BY kind
    `);
    out.sync_freshness = sync.rows.map((r) => ({
      kind: r.kind,
      last_ok: r.last_ok,
      lag_hours: r.last_ok
        ? Math.round((Date.now() - new Date(r.last_ok).getTime()) / 3600000)
        : null,
    }));
  } catch (_) { out.sync_freshness = []; }

  out.generated_at = new Date().toISOString();
  return out;
}

// ── 11. AUDIT FEED ────────────────────────────────────────────────────────

async function auditFeed({ cursor, entityType, action, userId, limit = 50 } = {}) {
  const lim = Math.min(Number(limit) || 50, 200);
  const params = [];
  const where = [];

  if (cursor) {
    where.push(`ae.created_at < ?::timestamptz`);
    params.push(cursor);
  }
  if (entityType) { where.push(`ae.entity_type = ?`); params.push(entityType); }
  if (action) { where.push(`ae.action = ?`); params.push(action); }
  if (userId) { where.push(`ae.user_id = ?`); params.push(userId); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);

  const rows = await db.raw(`
    SELECT ae.id, ae.user_id, u.full_name AS user_name, u.role AS user_role,
           ae.action, ae.entity_type, ae.entity_id, ae.ip_address, ae.created_at
      FROM audit_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      ${whereClause}
      ORDER BY ae.created_at DESC
      LIMIT ?
  `, params);

  const items = rows.rows;
  const next_cursor = items.length === lim ? items[items.length - 1].created_at : null;
  return {
    items,
    next_cursor,
    generated_at: new Date().toISOString(),
  };
}

// ── 12. ANOMALIES ─────────────────────────────────────────────────────────

async function anomalies({ since } = {}) {
  const sinceTs = since || daysAgoISO(7);
  const buckets = [];

  // Active alerts (unresolved)
  try {
    if (await tableExists('alerts')) {
      const alertsRows = await db.raw(`
        SELECT a.id, a.rule_key, a.severity, a.subject_user_id, u.full_name AS subject_name,
               a.payload, a.created_at, a.expires_at
          FROM alerts a
          LEFT JOIN users u ON u.id = a.subject_user_id
         WHERE a.resolved_at IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > NOW())
           AND a.created_at >= ?::timestamptz
         ORDER BY
           CASE a.severity WHEN 'critical' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
           a.created_at DESC
         LIMIT 100
      `, [sinceTs]);
      for (const r of alertsRows.rows) {
        buckets.push({
          source: 'alert',
          severity: r.severity,
          title: r.rule_key,
          subject: r.subject_name,
          payload: r.payload,
          at: r.created_at,
        });
      }
    }
  } catch (_) { /* fine */ }

  // Crons in error
  try {
    if (await tableExists('cron_runs')) {
      const cronErrors = await db.raw(`
        SELECT job_key, last_run_at, last_status, last_payload
          FROM cron_runs
         WHERE last_status = 'error'
            OR last_run_at < NOW() - INTERVAL '24 hours'
         ORDER BY last_run_at DESC
      `);
      for (const r of cronErrors.rows) {
        buckets.push({
          source: 'cron',
          severity: 'warn',
          title: `Cron ${r.job_key}: ${r.last_status || 'stale'}`,
          payload: r.last_payload,
          at: r.last_run_at,
        });
      }
    }
  } catch (_) { /* fine */ }

  // Failed import jobs
  try {
    const failedJobs = await db.raw(`
      SELECT id, kind, status, errors, finished_at
        FROM import_jobs
       WHERE status IN ('failed','partial')
         AND created_at >= ?::timestamptz
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 30
    `, [sinceTs]);
    for (const r of failedJobs.rows) {
      buckets.push({
        source: 'import',
        severity: r.status === 'failed' ? 'critical' : 'warn',
        title: `Import ${r.kind}: ${r.status}`,
        payload: { errors_count: Array.isArray(r.errors) ? r.errors.length : 0 },
        at: r.finished_at,
      });
    }
  } catch (_) { /* fine */ }

  // Recent deviations
  try {
    const dev = await db.raw(`
      SELECT vpa.visitor_user_id, u.full_name AS visitor_name,
             vpa.deviation_reason, vpa.deviated_at
        FROM visit_plan_assignments vpa
        LEFT JOIN users u ON u.id = vpa.visitor_user_id
       WHERE vpa.deviated_at IS NOT NULL
         AND vpa.deviated_at >= ?::timestamptz
       ORDER BY vpa.deviated_at DESC
       LIMIT 20
    `, [sinceTs]);
    for (const r of dev.rows) {
      buckets.push({
        source: 'deviation',
        severity: 'info',
        title: `Desvío de ruta: ${r.visitor_name || '(sin nombre)'}`,
        subject: r.visitor_name,
        payload: { reason: r.deviation_reason },
        at: r.deviated_at,
      });
    }
  } catch (_) { /* fine */ }

  buckets.sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());

  return {
    since: sinceTs,
    items: buckets,
    counts_by_source: buckets.reduce((acc, b) => {
      acc[b.source] = (acc[b.source] || 0) + 1;
      return acc;
    }, {}),
    counts_by_severity: buckets.reduce((acc, b) => {
      acc[b.severity] = (acc[b.severity] || 0) + 1;
      return acc;
    }, {}),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  hero,
  trend,
  coverageHeatmap,
  hierarchy,
  operations,
  people,
  commercial,
  onboarding,
  dataQuality,
  system,
  auditFeed,
  anomalies,
  // exposed for tests
  _internals: {
    pctDelta,
    presenceFromPing,
    defaultRange,
    isDbConnectionError,
    cacheGet,
    cacheSet,
  },
};
