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

// [P3] Per-job timeout to keep the whole worker under the Vercel 15-min cap.
// 4 minutes per job × 6 jobs = 24min worst case in series, but with checkpoint
// short-circuit a healthy run is well under 5min total. Override with env.
const PER_JOB_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.BQ_SYNC_PER_JOB_TIMEOUT_MS) || 4 * 60 * 1000,
);
const CHECKPOINT_TTL_MS = Math.max(
  60_000,
  Number(process.env.BQ_SYNC_CHECKPOINT_TTL_SECONDS)
    ? Number(process.env.BQ_SYNC_CHECKPOINT_TTL_SECONDS) * 1000
    : 6 * 60 * 60 * 1000,
);

async function readCheckpoint(jobKey) {
  try {
    const exists = await db.raw("SELECT to_regclass('bq_sync_checkpoints') AS t");
    if (!exists.rows?.[0]?.t) return null;
    const row = await db('bq_sync_checkpoints').where({ job_key: jobKey }).first();
    return row || null;
  } catch {
    return null;
  }
}

async function writeCheckpoint(jobKey, status, payload) {
  try {
    const exists = await db.raw("SELECT to_regclass('bq_sync_checkpoints') AS t");
    if (!exists.rows?.[0]?.t) return;
    const isSuccess = status === 'ok';
    await db.raw(
      `INSERT INTO bq_sync_checkpoints (job_key, last_run_at, last_success_at, last_status, last_payload)
       VALUES (?, NOW(), ${isSuccess ? 'NOW()' : 'NULL'}, ?, ?::jsonb)
       ON CONFLICT (job_key) DO UPDATE
         SET last_run_at = NOW(),
             ${isSuccess ? 'last_success_at = NOW(),' : ''}
             last_status = EXCLUDED.last_status,
             last_payload = EXCLUDED.last_payload`,
      [jobKey, status, JSON.stringify(payload || {})],
    );
  } catch {
    // best-effort
  }
}

async function recordWarning(jobKey, code, message) {
  try {
    const exists = await db.raw("SELECT to_regclass('bq_sync_warnings') AS t");
    if (!exists.rows?.[0]?.t) return;
    await db('bq_sync_warnings').insert({
      job_key: jobKey,
      code,
      message,
      occurred_at: db.fn.now(),
    });
  } catch { /* best-effort */ }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: ' + label + ' exceeded ' + ms + 'ms')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

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
    const jobKey = job.JOB_NAME;
    // [P3] Skip jobs whose last successful checkpoint is fresher than the
    // TTL — unless the caller explicitly forces a re-run. This is the main
    // defense against running the orchestrator into the Vercel 15-min cap.
    if (!force) {
      const cp = await readCheckpoint(jobKey);
      const successAge = cp?.last_success_at
        ? Date.now() - new Date(cp.last_success_at).getTime()
        : Infinity;
      if (Number.isFinite(successAge) && successAge < CHECKPOINT_TTL_MS) {
        results.push({
          name: jobKey,
          skipped: 'fresh_checkpoint',
          last_success_age_ms: successAge,
        });
        continue;
      }
    }

    try {
      const r = await withTimeout(
        job.run({ limit: limitPerJob }),
        PER_JOB_TIMEOUT_MS,
        jobKey,
      );
      results.push(r);
      await writeCheckpoint(jobKey, 'ok', r);
      // eslint-disable-next-line no-console
      console.log(`[bq-sync] ${r.name} ok in ${r.duration_ms}ms`, r);
    } catch (err) {
      const isTimeout = /^timeout:/.test(err.message);
      const status = isTimeout ? 'timeout' : 'error';
      results.push({ name: jobKey, error: err.message, status });
      await writeCheckpoint(jobKey, status, { message: err.message });
      if (isTimeout) {
        await recordWarning(jobKey, 'PER_JOB_TIMEOUT', err.message);
      }
      // eslint-disable-next-line no-console
      console.warn(`[bq-sync] ${jobKey} ${status}: ${err.message}`);
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
