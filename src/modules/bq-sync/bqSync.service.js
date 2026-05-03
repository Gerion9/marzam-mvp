/**
 * Marzam Source Sync orchestrator.
 *
 * Runs the five sync jobs in order — they have read-after-write dependencies:
 *
 *   1) cuadro_basico    → users + employee_profiles
 *   2) prospect_scored  → pharmacies (universe)
 *   3) detalle_mostrador→ marzam_clients
 *   4) hierarchy        → branches, users.manager_id, users.branch_id
 *   5) clients_ecatepec → marzam_clients.dataplor_id ↔ pharmacies
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

const JOB_RUNNERS = [
  syncCuadroBasico,
  syncProspectScored,
  syncDetalleMostrador,
  syncHierarchy,
  syncClientsEcatepec,
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
  const failed = results.some((r) => r.error);
  return { ok: !failed, duration_ms: Date.now() - startedAt, results };
}

module.exports = {
  runAll,
  checkDestinationReady,
  REQUIRED_DESTINATION_TABLES,
};
