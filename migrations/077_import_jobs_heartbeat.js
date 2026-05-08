/**
 * Adds a heartbeat column to import_jobs so the worker tick can reclaim
 * crashed/zombie processing rows.
 *
 * Background — see audit Fix #4 (docs/qa-fix-plan.md):
 *   src/modules/imports/imports.service.js#runWorkerTick uses
 *   `forUpdate().skipLocked()` to claim a job. Postgres releases the row
 *   lock automatically when the worker connection dies, but the row stays
 *   `status='processing'` forever — and the next tick happily picks it up
 *   again with stale cursor/totals (or, depending on the SELECT, skips it
 *   thinking it's still in flight).
 *
 * Fix: stamp `last_heartbeat_at` at pickup and between chunks. The pickup
 * query reclaims rows whose heartbeat is older than IMPORT_JOB_TTL_MIN
 * (default 5 min). Active workers stay locked via skipLocked; only zombies
 * become reclaimable.
 *
 * The migration is purely additive — older worker code that doesn't write
 * the column keeps working (column is nullable; reclaim filter accepts NULL
 * heartbeats with old started_at as a fallback signal).
 */

exports.up = async function up(knex) {
  // Defensive: only run on environments where import_jobs exists.
  const hasTable = await knex.schema.hasTable('import_jobs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('import_jobs', 'last_heartbeat_at');
  if (!hasCol) {
    await knex.schema.alterTable('import_jobs', (t) => {
      t.timestamp('last_heartbeat_at', { useTz: true }).nullable();
    });
  }
  // Index supports the pickup query: WHERE status IN (...) AND
  // (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - interval).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS import_jobs_status_heartbeat_idx
      ON import_jobs (status, last_heartbeat_at)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS import_jobs_status_heartbeat_idx');
  const hasTable = await knex.schema.hasTable('import_jobs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('import_jobs', 'last_heartbeat_at');
  if (hasCol) {
    await knex.schema.alterTable('import_jobs', (t) => {
      t.dropColumn('last_heartbeat_at');
    });
  }
};
