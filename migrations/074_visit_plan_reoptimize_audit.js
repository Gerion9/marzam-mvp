/**
 * visit_plan_reoptimizations — append-only audit de reoptimizaciones intradía.
 *
 * Cada llamada a POST /api/visit-plans/:id/reoptimize-day inserta UNA row aquí,
 * con el trigger (rep_breakdown / urgent_insert / cap_exceed / manual), payload,
 * IDs de assignments tocados, conteo de locks y tiempo de ejecución.
 *
 * NO afecta scope_hash del plan — la idempotencia del plan original sobrevive.
 * El plan publicado sigue identificable por el unique index de migración 059.
 *
 * Endpoint GET /:id/reoptimizations lista las reoptimizaciones del plan en
 * orden cronológico. UI plan-editor lo muestra en panel lateral "historial".
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('visit_plan_reoptimizations');
  if (!has) {
    await knex.schema.createTable('visit_plan_reoptimizations', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.uuid('visit_plan_id').notNullable().references('id').inTable('visit_plans').onDelete('CASCADE');
      t.date('scheduled_date').notNullable();
      t.uuid('triggered_by').references('id').inTable('users').onDelete('SET NULL');
      t.text('trigger_kind').notNullable();
      t.jsonb('payload').notNullable();
      t.specificType('affected_assignment_ids', 'uuid[]');
      t.integer('locked_count').notNullable().defaultTo(0);
      t.integer('released_count').notNullable().defaultTo(0);
      t.integer('ms_elapsed');
      t.text('outcome').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`
      ALTER TABLE visit_plan_reoptimizations
        ADD CONSTRAINT vpr_trigger_kind_check
        CHECK (trigger_kind IN ('rep_breakdown','urgent_insert','cap_exceed','manual'));
    `);
    await knex.raw(`
      ALTER TABLE visit_plan_reoptimizations
        ADD CONSTRAINT vpr_outcome_check
        CHECK (outcome IN ('success','partial','rejected'));
    `);
    await knex.raw(`
      CREATE INDEX idx_vpr_plan_date ON visit_plan_reoptimizations (visit_plan_id, scheduled_date);
    `);
    await knex.raw(`
      CREATE INDEX idx_vpr_created_at ON visit_plan_reoptimizations (created_at DESC);
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_plan_reoptimizations');
};
