/**
 * bq_sync_checkpoints — per-job checkpoint marker for the bq-sync orchestrator.
 *
 * Pre-audit, the 6-job orchestrator (bqSync.service.runAll) re-ran every job
 * every 6h regardless of whether the previous run had succeeded. With the 6
 * jobs running in series and each potentially scanning thousands of rows,
 * the worker risked the Vercel function timeout (15min Pro). If it timed
 * out mid-way, the next tick re-did everything from scratch — wasted work
 * and increased risk of partial-state inconsistency.
 *
 * This table tracks the last successful run per job_key so the orchestrator
 * can skip jobs that have a fresh checkpoint (configurable via
 * BQ_SYNC_CHECKPOINT_TTL_SECONDS, default 6h). See P3 in the audit.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('bq_sync_checkpoints');
  if (has) return;

  await knex.schema.createTable('bq_sync_checkpoints', (t) => {
    t.text('job_key').primary();
    t.timestamp('last_run_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_success_at');
    t.text('last_status').notNullable().defaultTo('pending');
    t.jsonb('last_payload');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('bq_sync_checkpoints');
};
