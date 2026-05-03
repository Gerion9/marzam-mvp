/**
 * visit_quotas — distribución de visitas por usuario y período.
 *
 * Regla de negocio (enforcement en el módulo quotas):
 *   - Director solo puede asignar/modificar quotas a gerentes (1 nivel abajo).
 *   - Gerente   → supervisores.
 *   - Supervisor → representantes.
 *   - Representante NO puede asignar nada.
 *
 * Cada quota guarda meta_nuevas + meta_clientes para que el dashboard de
 * efectividad pueda comparar a niveles iguales (gerente A vs B, etc).
 *
 * mode = 'uniform'   → todos los subordinados con la misma meta
 *        'custom'    → meta personalizada por usuario (una fila por subordinado)
 *
 * El período es un rango (period_start..period_end). Para no traslapar
 * múltiples quotas activas del mismo target_user, hay un índice único
 * parcial sobre (target_user_id, period_start) para el mismo set_by.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_quotas', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('set_by_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('target_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('mode', 16).notNullable().defaultTo('uniform'); // uniform | custom
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.integer('target_new').notNullable().defaultTo(0);
    t.integer('target_existing').notNullable().defaultTo(0);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE visit_quotas
      ADD CONSTRAINT visit_quotas_mode_check
      CHECK (mode IN ('uniform','custom'));
  `);
  await knex.raw(`
    ALTER TABLE visit_quotas
      ADD CONSTRAINT visit_quotas_period_check
      CHECK (period_end >= period_start);
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_visit_quotas_unique
      ON visit_quotas (target_user_id, period_start, period_end);
  `);
  await knex.raw('CREATE INDEX idx_visit_quotas_setter ON visit_quotas (set_by_user_id, period_start DESC);');
  await knex.raw('CREATE INDEX idx_visit_quotas_target ON visit_quotas (target_user_id, period_start DESC);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_quotas');
};
