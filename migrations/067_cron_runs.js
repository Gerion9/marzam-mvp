/**
 * cron_runs — observability table for Vercel Cron jobs.
 *
 * Each registered job upserts here on every run. The
 * /api/admin/scheduler/health endpoint reads the table so an admin can spot
 * a job that hasn't fired in 24h.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('cron_runs');
  if (has) return;
  await knex.schema.createTable('cron_runs', (t) => {
    t.text('job_key').primary();
    t.timestamp('last_run_at');
    t.text('last_status');
    t.jsonb('last_payload');
  });
  await knex.raw(`
    ALTER TABLE cron_runs
      ADD CONSTRAINT cron_runs_status_check
      CHECK (last_status IN ('ok','error','running'));
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cron_runs');
};
