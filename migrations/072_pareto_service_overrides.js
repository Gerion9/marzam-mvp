/**
 * pareto_service_overrides — service time por categoría Pareto.
 *
 * Una farmacia A (high-value) toma 60 min (más referencias, más material POS).
 * Una farmacia C toma 30 min. El default global de users.service_minutes_per_stop
 * (45) es demasiado bajo para A's y demasiado alto para C's.
 *
 * Resolución de service time en planGenerator:
 *   1. users.service_minutes_per_stop (override por rep, si está set explicitly)
 *   2. pareto_service_overrides[pharmacy.pareto].service_minutes
 *   3. DEFAULT_SERVICE_MINUTES (45)
 *
 * Solo activo cuando feature flag PLAN_ENABLE_PARETO_SERVICE=true.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('pareto_service_overrides');
  if (!has) {
    await knex.schema.createTable('pareto_service_overrides', (t) => {
      t.specificType('pareto', 'CHAR(1)').primary();
      t.smallint('service_minutes').notNullable();
      t.text('applies_to_kind').notNullable().defaultTo('both');
      t.boolean('active').notNullable().defaultTo(true);
    });
    await knex.raw(`
      ALTER TABLE pareto_service_overrides
        ADD CONSTRAINT pareto_service_overrides_pareto_check
        CHECK (pareto IN ('A','B','C','D'));
    `);
    await knex.raw(`
      ALTER TABLE pareto_service_overrides
        ADD CONSTRAINT pareto_service_overrides_kind_check
        CHECK (applies_to_kind IN ('client','prospect','both'));
    `);
    await knex.raw(`
      INSERT INTO pareto_service_overrides (pareto, service_minutes) VALUES
        ('A', 60),
        ('B', 45),
        ('C', 30),
        ('D', 30);
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pareto_service_overrides');
};
