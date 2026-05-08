/**
 * Hard schedule fields per Marzam Execution Doc §6.2/§6.3:
 *
 *   "Hard schedule enforced: route must be started and completed; deviations
 *    require reason"
 *
 * Adds to visit_plan_assignments:
 *   - expected_start_time: when the rep is supposed to begin this stop
 *   - actual_start_time:   set when the rep clicks "Iniciar" on this stop
 *   - deviation_reason:    set if the stop was skipped or its order changed
 *   - deviated_at:         timestamp of the deviation event
 *
 * Adds to visit_plans:
 *   - expected_route_start: window start for the whole route (HH:MM)
 *   - expected_route_end:   window end (HH:MM)
 *   - hard_schedule:        boolean flag — when true, late starts trigger alerts
 *
 * The brief calls "highest potential customers visited later" a SOFT constraint;
 * we leave that to the planGenerator's ordering logic, not a separate column.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.timestamp('expected_start_time');
    t.timestamp('actual_start_time');
    t.text('deviation_reason');
    t.timestamp('deviated_at');
  });
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vpa_actual_start
      ON visit_plan_assignments (actual_start_time);
  `);

  await knex.schema.alterTable('visit_plans', (t) => {
    t.string('expected_route_start', 5);  // HH:MM
    t.string('expected_route_end', 5);    // HH:MM
    t.boolean('hard_schedule').notNullable().defaultTo(true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visit_plans', (t) => {
    t.dropColumn('hard_schedule');
    t.dropColumn('expected_route_end');
    t.dropColumn('expected_route_start');
  });
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_actual_start;');
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.dropColumn('deviated_at');
    t.dropColumn('deviation_reason');
    t.dropColumn('actual_start_time');
    t.dropColumn('expected_start_time');
  });
};
