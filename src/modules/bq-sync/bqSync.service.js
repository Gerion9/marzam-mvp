/**
 * Marzam Source Sync orchestrator.
 *
 * Runs the six sync jobs in order — they have read-after-write dependencies:
 *
 *   1) cuadro_basico    → users + employee_profiles
 *   2) prospect_scored  → pharmacies (universe)
 *   3) detalle_mostrador→ marzam_clients
 *   4) hierarchy        → branches, users.manager_id, users.branch_id
 *   5) clients_ecatepec → marzam_clients.dataplor_id ↔ pharmacies
 *   6) daily_sales      → daily_sales fact table (Marzam Execution Doc §9)
 *
 * Each job is idempotent. The whole orchestration is logged in `import_jobs`
 * so you can audit "when was the last full sync, how many rows changed".
 *
 * Safe-mode: if any of the destination tables (`users`, `branches`,
 * `marzam_clients`, `pharmacies`, `employee_profiles`) is missing — typical
 * during the bootstrap window when migrations have not been applied yet —
 * we short-circuit with `{ ok: false, reason: 'destination_not_ready' }`
 * **without throwing**, so the cron does not page on a known config gap.
 * See docs/ROADMAP-PRODUCTION.md for the unblocking plan.
 */

const db = require('../../config/database');
const syncCuadroBasico = require('./jobs/syncCuadroBasico');
const syncProspectScored = require('./jobs/syncProspectScored');
const syncDetalleMostrador = require('./jobs/syncDetalleMostrador');
const syncHierarchy = require('./jobs/syncHierarchy');
const syncClientsEcatepec = require('./jobs/syncClientsEcatepec');
const syncDailySales = require('./jobs/syncDailySales');

const JOB_RUNNERS = [
  syncCuadroBasico,
  syncProspectScored,
  syncDetalleMostrador,
  syncHierarchy,
  syncClientsEcatepec,
  // daily_sales runs last because it depends on marzam_clients populated by job 3.
  syncDailySales,
];

const REQUIRED_DESTINATION_TABLES = [
  'users',
  'branches',
  'marzam_clients',
  'pharmacies',
  'employee_profiles',
  'bq_sync_warnings',
];

async function checkDestinationReady() {
  const placeholders = REQUIRED_DESTINATION_TABLES.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.raw(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (${placeholders})`,
    REQUIRED_DESTINATION_TABLES,
  );
  const present = new Set(rows.map((r) => r.table_name));
  const missing = REQUIRED_DESTINATION_TABLES.filter((t) => !present.has(t));
  return { ready: missing.length === 0, missing };
}

async function runAll({ limitPerJob = null, force = false } = {}) {
  const startedAt = Date.now();

  const dest = await checkDestinationReady();
  if (!dest.ready && !force) {
    // eslint-disable-next-line no-console
    console.warn(
      `[bq-sync] skipping run: destination DB is not ready (missing: ${dest.missing.join(', ')}). `
      + 'Set force=true to attempt anyway.',
    );
    return {
      ok: false,
      reason: 'destination_not_ready',
      missing_tables: dest.missing,
      duration_ms: Date.now() - startedAt,
      results: [],
    };
  }

  const results = [];
  for (const job of JOB_RUNNERS) {
    try {
      const r = await job.run({ limit: limitPerJob });
      results.push(r);
      // eslint-disable-next-line no-console
      console.log(`[bq-sync] ${r.name} ok in ${r.duration_ms}ms`, r);
    } catch (err) {
      results.push({ name: job.JOB_NAME, error: err.message });
      // eslint-disable-next-line no-console
      console.warn(`[bq-sync] ${job.JOB_NAME} failed: ${err.message}`);
    }
  }

  // Refresh the sales rollups MV after daily_sales lands.  Best-effort: a
  // missing MV (pre-mig 056) or a contention error must not fail the run.
  try {
    const exists = await db.raw(`SELECT to_regclass('mv_pharmacy_sales_rollups') AS t`);
    if (exists.rows?.[0]?.t) {
      // CONCURRENTLY requires the MV to have been populated at least once;
      // try concurrent first, fall back to a plain refresh on its first run.
      try {
        await db.raw('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_pharmacy_sales_rollups');
      } catch (concurrentErr) {
        if (/no data/i.test(concurrentErr.message) || /first refresh/i.test(concurrentErr.message)) {
          await db.raw('REFRESH MATERIALIZED VIEW mv_pharmacy_sales_rollups');
        } else {
          throw concurrentErr;
        }
      }
      results.push({ name: 'mv_pharmacy_sales_rollups', refreshed: true });
    }
  } catch (err) {
    results.push({ name: 'mv_pharmacy_sales_rollups', error: err.message });
  }

  const failed = results.some((r) => r.error);
  return { ok: !failed, duration_ms: Date.now() - startedAt, results };
}

module.exports = {
  runAll,
  checkDestinationReady,
  REQUIRED_DESTINATION_TABLES,
};
