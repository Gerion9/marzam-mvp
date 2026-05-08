/**
 * visit_plan_assignments — materialized rows: one per (visitor, day, client).
 *
 * This is the table the apps query: "what does Ana visit today?", "did Carlos
 * complete his Tuesday route?". Linked back to a `visit_plan` for grouping
 * and to a `visit_report` (visit_id) when the visit happens.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_plan_assignments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('visit_plan_id').notNullable().references('id').inTable('visit_plans').onDelete('CASCADE');
    t.uuid('visitor_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('marzam_client_id').notNullable().references('id').inTable('marzam_clients').onDelete('CASCADE');
    t.date('scheduled_date').notNullable();
    t.integer('route_order');
    t.string('channel', 32).notNullable().defaultTo('visit');
    t.string('status', 16).notNullable().defaultTo('planned');
    t.timestamp('completed_at');
    t.uuid('visit_id').references('id').inTable('visit_reports').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      ADD CONSTRAINT vpa_status_check
      CHECK (status IN ('planned','done','skipped','rescheduled'));
  `);
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      ADD CONSTRAINT vpa_channel_check
      CHECK (channel IN ('visit','contact_center'));
  `);

  // (visitor, date, client) is unique within a plan — prevents the generator
  // from double-booking the same visit twice.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_vpa_unique_per_plan
      ON visit_plan_assignments (visit_plan_id, visitor_user_id, scheduled_date, marzam_client_id);
  `);
  await knex.raw('CREATE INDEX idx_vpa_visitor_date ON visit_plan_assignments (visitor_user_id, scheduled_date);');
  await knex.raw('CREATE INDEX idx_vpa_plan ON visit_plan_assignments (visit_plan_id);');
  await knex.raw('CREATE INDEX idx_vpa_client ON visit_plan_assignments (marzam_client_id);');
  await knex.raw('CREATE INDEX idx_vpa_status_date ON visit_plan_assignments (status, scheduled_date);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_plan_assignments');
};
