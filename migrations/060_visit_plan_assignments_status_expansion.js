/**
 * Expand visit_plan_assignments.status check to include the lifecycle states
 * the runtime actually uses:
 *
 *   planned       — generator output (initial)
 *   in_progress   — rep called POST /assignments/:id/start (NEW)
 *   done          — visit_reports row attached
 *   skipped       — manager or rep marked it (existing)
 *   deviated      — rep called /deviate with reason (NEW)
 *   rescheduled   — manager moved to a different day (existing)
 *
 * Also adds a partial index on (visitor_user_id, scheduled_date, status)
 * for the alerts engine query (route_not_started / route_deviated).
 */

exports.up = async function up(knex) {
  // Drop and recreate the status check with the expanded set.
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      DROP CONSTRAINT IF EXISTS vpa_status_check
  `);
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      ADD CONSTRAINT vpa_status_check
      CHECK (status IN ('planned','in_progress','done','skipped','deviated','rescheduled'))
  `);

  // Backfill in_progress: assignments with actual_start_time set but no completion.
  await knex.raw(`
    UPDATE visit_plan_assignments
       SET status = 'in_progress'
     WHERE actual_start_time IS NOT NULL
       AND completed_at IS NULL
       AND visit_id IS NULL
       AND status = 'planned'
  `);

  // Backfill deviated: assignments with deviation_reason set.
  await knex.raw(`
    UPDATE visit_plan_assignments
       SET status = 'deviated'
     WHERE deviation_reason IS NOT NULL
       AND status = 'skipped'
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vpa_active_status
      ON visit_plan_assignments (visitor_user_id, scheduled_date, status)
      WHERE status IN ('planned','in_progress')
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_active_status;');
  // Revert the check to the original set; rows in newly-added states must be
  // collapsed back first to avoid violation.
  await knex.raw(`
    UPDATE visit_plan_assignments
       SET status = 'planned'
     WHERE status = 'in_progress'
  `);
  await knex.raw(`
    UPDATE visit_plan_assignments
       SET status = 'skipped'
     WHERE status = 'deviated'
  `);
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      DROP CONSTRAINT IF EXISTS vpa_status_check
  `);
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      ADD CONSTRAINT vpa_status_check
      CHECK (status IN ('planned','done','skipped','rescheduled'))
  `);
};
