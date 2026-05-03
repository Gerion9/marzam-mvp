/**
 * visit_plans — header for a generated route plan.
 *
 * granularity is daily/weekly/monthly. Whatever it is, the plan is always
 * materialized as one row per (visitor_user_id, scheduled_date,
 * marzam_client_id) in `visit_plan_assignments` (035) — the granularity is
 * just a planning UX hint, not a schema choice.
 *
 * `config` jsonb captures a snapshot of the targets/overrides applied at
 * generation time. That makes the plan reproducible — if the director moves
 * the daily target from 23 to 25 mid-month, the existing published plan
 * doesn't silently rewrite itself.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('owner_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('scope_user_id').references('id').inTable('users').onDelete('CASCADE');
    t.uuid('branch_id').references('id').inTable('branches').onDelete('SET NULL');
    t.string('granularity', 16).notNullable();
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.string('status', 16).notNullable().defaultTo('draft');
    t.text('name');
    t.jsonb('config').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE visit_plans
      ADD CONSTRAINT visit_plans_granularity_check
      CHECK (granularity IN ('daily','weekly','monthly'));
  `);
  await knex.raw(`
    ALTER TABLE visit_plans
      ADD CONSTRAINT visit_plans_status_check
      CHECK (status IN ('draft','published','archived'));
  `);
  await knex.raw(`
    ALTER TABLE visit_plans
      ADD CONSTRAINT visit_plans_period_order_check
      CHECK (period_end >= period_start);
  `);

  await knex.raw('CREATE INDEX idx_visit_plans_owner ON visit_plans (owner_user_id);');
  await knex.raw('CREATE INDEX idx_visit_plans_scope ON visit_plans (scope_user_id);');
  await knex.raw('CREATE INDEX idx_visit_plans_branch_period ON visit_plans (branch_id, period_start);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_plans');
};
