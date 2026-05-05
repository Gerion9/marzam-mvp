/**
 * Sync daily sales from `stg_marzam_detalle_mostrador._1.._31` columns
 * into `daily_sales(marzam_client_id, sale_date, amount)`.
 *
 * Marzam Execution Doc §9: "Daily sales API ingest" → ranks reps and
 * powers KPI "actual sale vs sales target" + rolling 7/30 windows.
 *
 * Source schema (empirical, validated 2026-05-03):
 *   - cpadre              → key into marzam_clients
 *   - _1, _2, ..., _31    → daily totals for the period in the same row
 *   - _30_1, _31_1        → counter columns; we IGNORE here (TBD with data team)
 *   - period / mes / fecha (any of these, optional) → month context
 *
 * The period is inferred in this order:
 *   1) source row column `period` (date in MM-YYYY or YYYY-MM-01),
 *   2) `mes` + `anio`,
 *   3) the env var `MARZAM_SALES_PERIOD` (YYYY-MM),
 *   4) FALLBACK = current month.  We log a warning if (4) is hit.
 *
 * Idempotency: UPSERT on (marzam_client_id, sale_date). Re-runs overwrite
 * the same day's value, so nightly re-syncs are safe.
 *
 * Defensive behavior when the table or columns are missing: the job exits
 * cleanly with `rows: 0` and a `warning` reason — does not throw — so a
 * deployment without the source feed doesn't break the cron.
 */

const db = require('../../../config/database');
const { BQ_TABLES, fetchAll, asNumeric: asNumber, asString } = require('../bqHelpers');

const JOB_NAME = 'daily_sales';
const DAY_COLUMN_PREFIX = '_';

function envPeriod() {
  const raw = process.env.MARZAM_SALES_PERIOD;
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return { year, month };
}

function inferPeriod(row) {
  // Try a `period` column (date or text).
  if (row.period) {
    if (row.period instanceof Date) {
      return { year: row.period.getUTCFullYear(), month: row.period.getUTCMonth() + 1 };
    }
    const s = String(row.period);
    let m = s.match(/^(\d{4})-(\d{1,2})/);
    if (m) return { year: Number(m[1]), month: Number(m[2]) };
    m = s.match(/^(\d{1,2})[-/](\d{4})/);
    if (m) return { year: Number(m[2]), month: Number(m[1]) };
  }
  // Try `mes` + `anio` columns.
  const mes = asNumber(row.mes);
  const anio = asNumber(row.anio || row.year);
  if (mes && anio) return { year: anio, month: mes };
  // Env override.
  const env = envPeriod();
  if (env) return env;
  // Fallback: current month.
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function dayColumnsPresent(row) {
  const out = [];
  for (let d = 1; d <= 31; d += 1) {
    const key = `${DAY_COLUMN_PREFIX}${d}`;
    if (Object.prototype.hasOwnProperty.call(row, key)) out.push({ day: d, key });
  }
  return out;
}

function isoDay(year, month, day) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

async function ensureClientId(trx, cpadre) {
  if (!cpadre) return null;
  const row = await trx('marzam_clients').select('id').where({ cpadre }).first();
  return row || null;
}

// Provision a monthly partition for `daily_sales` if it doesn't exist yet.
// The helper function `ensure_monthly_partition` was created in mig 027.
async function ensurePartition(year, month) {
  const sale_date = `${year}-${String(month).padStart(2, '0')}-01`;
  await db.raw('SELECT ensure_monthly_partition(?::date)', [sale_date]);
}

async function run({ limit = null, period = null } = {}) {
  const startedAt = Date.now();
  let rows;
  try {
    rows = await fetchAll(BQ_TABLES.DETALLE_MOSTRADOR, { limit });
  } catch (err) {
    console.warn(`[bq-sync:${JOB_NAME}] source table unavailable: ${err.message}`);
    return { name: JOB_NAME, rows: 0, inserted: 0, updated: 0, skipped: 0, warning: 'source_unavailable', duration_ms: Date.now() - startedAt };
  }
  if (!rows.length) {
    return { name: JOB_NAME, rows: 0, inserted: 0, updated: 0, skipped: 0, warning: 'empty_source', duration_ms: Date.now() - startedAt };
  }

  // Detect day columns by sniffing the first row. If none found, the source
  // schema doesn't expose daily breakdowns and we exit gracefully.
  const sample = rows[0];
  const dayCols = dayColumnsPresent(sample);
  if (!dayCols.length) {
    console.warn(`[bq-sync:${JOB_NAME}] no _1.._31 columns in source; skipping daily breakdown.`);
    return {
      name: JOB_NAME,
      rows: rows.length,
      inserted: 0,
      updated: 0,
      skipped: rows.length,
      warning: 'no_daily_columns',
      duration_ms: Date.now() - startedAt,
    };
  }

  const stats = { rows: rows.length, inserted: 0, updated: 0, skipped: 0, no_match: 0 };

  // Verify destination table exists; if not, log + bail cleanly. This keeps
  // pre-migration deploys safe (mig 027 created daily_sales).
  const exists = await db.raw(`SELECT to_regclass('daily_sales') AS t`);
  if (!exists.rows?.[0]?.t) {
    return { name: JOB_NAME, rows: rows.length, inserted: 0, updated: 0, skipped: rows.length, warning: 'daily_sales_missing', duration_ms: Date.now() - startedAt };
  }

  // Pre-provision the partition for each (year, month) we'll touch, so we
  // don't redundantly call ensure_monthly_partition once per row.
  const periodsTouched = new Set();

  for (const raw of rows) {
    const cpadre = asString(raw.cpadre || raw.c_padre);
    if (!cpadre) {
      stats.skipped += 1;
      continue;
    }
    const client = await ensureClientId(db, cpadre);
    if (!client) {
      stats.no_match += 1;
      continue;
    }
    const { year, month } = period || inferPeriod(raw);
    const periodKey = `${year}-${month}`;
    if (!periodsTouched.has(periodKey)) {
      try {
        await ensurePartition(year, month);
        periodsTouched.add(periodKey);
      } catch (err) {
        console.warn(`[bq-sync:${JOB_NAME}] partition ${periodKey}: ${err.message}`);
      }
    }

    // Build payload of (sale_date, amount) for non-null days.  We persist 0
    // too — a real "no sale" day is information for the rolling-30 window.
    const payload = [];
    for (const { day, key } of dayCols) {
      const value = asNumber(raw[key]);
      if (value === null || value === undefined) continue;
      payload.push({
        marzam_client_id: client.id,
        sale_date: isoDay(year, month, day),
        amount: value,
        is_devolution: false,
        is_contact_center: false,
        imported_at: db.fn.now(),
      });
    }
    if (!payload.length) continue;

    // UPSERT one cpadre's worth of days inside a single statement so a partial
    // failure rolls back this client's batch but doesn't stop the loop.
    try {
      await db('daily_sales')
        .insert(payload)
        .onConflict(['marzam_client_id', 'sale_date'])
        .merge({
          amount: db.raw('EXCLUDED.amount'),
          imported_at: db.fn.now(),
        });
      stats.inserted += payload.length;
    } catch (err) {
      console.warn(`[bq-sync:${JOB_NAME}] cpadre=${cpadre}: ${err.message}`);
      stats.skipped += payload.length;
    }
  }

  return { name: JOB_NAME, ...stats, partitions_provisioned: periodsTouched.size, duration_ms: Date.now() - startedAt };
}

module.exports = { run, JOB_NAME };
