/**
 * rep_tracking_points — link to visit_plan_assignments (new system) so the
 * estela can show "during which planned stop was this ping captured".
 *
 * The existing `assignment_id` column (mig 012) points to `territory_assignments`
 * (legacy pre-routing). DO NOT REUSE — it is still referenced by some older
 * coverage queries. The new column is additive.
 *
 * Also: visit_session_id link, useful for "show all pings within this rep's
 * session today" without scanning by recorded_at window.
 *
 * Partial index on (visit_plan_assignment_id, recorded_at DESC) is the hot
 * path for breadcrumb queries scoped to a single stop.
 */

exports.up = async function up(knex) {
  const checks = await Promise.all([
    knex.schema.hasColumn('rep_tracking_points', 'visit_plan_assignment_id'),
    knex.schema.hasColumn('rep_tracking_points', 'visit_session_id'),
  ]);
  const [hasVpa, hasSession] = checks;

  await knex.schema.alterTable('rep_tracking_points', (t) => {
    if (!hasVpa) t.uuid('visit_plan_assignment_id').references('id').inTable('visit_plan_assignments').onDelete('SET NULL');
    if (!hasSession) t.uuid('visit_session_id').references('id').inTable('visit_sessions').onDelete('SET NULL');
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rtp_vpa
      ON rep_tracking_points (visit_plan_assignment_id, recorded_at DESC)
      WHERE visit_plan_assignment_id IS NOT NULL;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rtp_session
      ON rep_tracking_points (visit_session_id, recorded_at)
      WHERE visit_session_id IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_rtp_session;');
  await knex.raw('DROP INDEX IF EXISTS idx_rtp_vpa;');
  await knex.schema.alterTable('rep_tracking_points', (t) => {
    t.dropColumn('visit_session_id');
    t.dropColumn('visit_plan_assignment_id');
  });
};
