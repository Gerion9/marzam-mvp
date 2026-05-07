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
  // Use to_regclass + the connection's search_path so the check works against
  // whatever schema knex is configured to use (currently `marzam_app`). The
  // earlier hard-coded `table_schema = 'public'` always returned missing
  // because the migrations live in `marzam_app`, not `public`.
  const present = new Set();
  for (const table of REQUIRED_DESTINATION_TABLES) {
    const { rows } = await db.raw(`SELECT to_regclass(?) AS t`, [table]);
    if (rows?.[0]?.t) present.add(table);
  }
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

  // A job is "unhealthy" if it threw OR returned status='failed' (schema drift,
  // warnings ratio exceeded, etc.). Surface both signals separately so an oncall
  // operator can tell apart "the worker crashed" from "data quality dropped".
  const errored = results.filter((r) => r.error);
  const flaggedFailed = results.filter((r) => r.status === 'failed');
  const ok = errored.length === 0 && flaggedFailed.length === 0;

  return {
    ok,
    duration_ms: Date.now() - startedAt,
    results,
    summary: {
      total: results.length,
      errored: errored.map((r) => ({ name: r.name, error: r.error })),
      flagged_failed: flaggedFailed.map((r) => ({
        name: r.name,
        failure: r.failure,
        missing_required: r.missing_required,
      })),
    },
  };
}

module.exports = {
  runAll,
  checkDestinationReady,
  REQUIRED_DESTINATION_TABLES,
};
