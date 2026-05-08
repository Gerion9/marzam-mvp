/**
 * cost_coefficients — coeficientes económicos de la función objetivo del greedy + 2-opt.
 *
 * Jerarquía: scope_kind ∈ ('global','role','user'). resolveCostCoeffs en planGenerator
 * busca user → role → global. Se cachea por planRun para que un single plan use coeffs
 * estables aunque se editen en paralelo.
 *
 *   cost_per_km           — MXN por km recorrido (gasolina + desgaste).
 *   cost_per_hour         — MXN por hora de jornada (salario + carga).
 *   fixed_cost_per_day    — MXN base por activar al rep (depreciación + seguro prorrateado).
 *   alpha_duration        — peso en costFn(a,b) sobre duration en segundos.
 *   beta_distance         — peso en costFn(a,b) sobre distance en metros.
 *
 * Snapshot por plan en visit_plans.metrics.coeffs_snapshot — reportes históricos
 * usan el snapshot, no live, para que cambios de tarifa no rompan post-mortems pasados.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('cost_coefficients');
  if (!has) {
    await knex.schema.createTable('cost_coefficients', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.text('scope_kind').notNullable();
      t.text('scope_value');
      t.decimal('cost_per_km', 8, 4).notNullable();
      t.decimal('cost_per_hour', 8, 2).notNullable();
      t.decimal('fixed_cost_per_day', 10, 2).notNullable().defaultTo(0);
      t.decimal('alpha_duration', 6, 4).notNullable().defaultTo(1.0);
      t.decimal('beta_distance', 6, 4).notNullable().defaultTo(0.0);
      t.timestamp('effective_from').notNullable().defaultTo(knex.fn.now());
      t.timestamp('effective_to');
      t.text('notes');
      t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`
      ALTER TABLE cost_coefficients
        ADD CONSTRAINT cost_coefficients_scope_kind_check
        CHECK (scope_kind IN ('global','role','user'));
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX uq_cost_coeff_active
        ON cost_coefficients (scope_kind, COALESCE(scope_value, ''))
        WHERE effective_to IS NULL;
    `);
    await knex.raw(`
      INSERT INTO cost_coefficients
        (scope_kind, cost_per_km, cost_per_hour, alpha_duration, beta_distance, notes)
      VALUES
        ('global', 8.50, 120.00, 1.0, 0.0, 'Default seed: alpha=1 (puro tiempo). Calibrar tras observar realidad.');
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cost_coefficients');
};
