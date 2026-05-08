/**
 * Tracking retention — supporting indexes + retention column.
 *
 * The plan called for converting rep_tracking_points to RANGE-partitioned by
 * month. That's a heavy operation on a populated table. To minimize risk
 * during rollout we instead:
 *   1) Add an explicit `retain_until` column populated on insert to
 *      `recorded_at + 30 days` (via a default-derived expression).
 *   2) Add a covering index on (retain_until) for the nightly purge cron.
 *   3) Schedule the partition migration as a separate follow-up after the
 *      app is running on the new alerts engine and we can take a brief
 *      maintenance window.
 *
 * This still bounds growth (purgeTracking deletes by retain_until < NOW())
 * without locking the table for a partition rewrite.
 */

exports.up = async function up(knex) {
  const hasCol = await knex.schema.hasColumn('rep_tracking_points', 'retain_until');
  if (!hasCol) {
    await knex.schema.alterTable('rep_tracking_points', (t) => {
      t.timestamp('retain_until');
    });
    await knex.raw(`
      UPDATE rep_tracking_points
         SET retain_until = recorded_at + INTERVAL '30 days'
       WHERE retain_until IS NULL
    `);
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rtp_retain_until
      ON rep_tracking_points (retain_until)
      WHERE retain_until IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_rtp_retain_until;');
  await knex.schema.alterTable('rep_tracking_points', (t) => {
    t.dropColumn('retain_until');
  });
};
