/**
 * break_rules — pausas obligatorias del rep durante la jornada (lunch, admin, etc.).
 *
 * Modelo: misma jerarquía que cost_coefficients (global → role → user). Plan generator
 * inyecta un "stop fantasma" en el greedy con la duración pedida y una soft window
 * (earliest..latest). El stop NO se persiste en visit_plan_assignments — solo afecta
 * la secuenciación y el cursor de tiempo, y se cuenta en metrics.break_applied_per_user.
 *
 *   earliest / latest      — ventana suave dentro de la jornada (TIME local).
 *   duration_min           — minutos que dura la pausa.
 *   hard_required          — si true, plan generator garantiza la pausa aunque rompa cap
 *                             (downgrade unassigned). Si false, puede saltarse en días apretados.
 *   soft_penalty_per_min   — penalty por minuto fuera de la soft window (0 = neutro).
 *
 * Solo activo cuando feature flag PLAN_ENABLE_BREAKS=true.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('break_rules');
  if (!has) {
    await knex.schema.createTable('break_rules', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.text('scope_kind').notNullable();
      t.text('scope_value');
      t.text('kind').notNullable();
      t.specificType('earliest', 'TIME').notNullable();
      t.specificType('latest', 'TIME').notNullable();
      t.smallint('duration_min').notNullable();
      t.boolean('hard_required').notNullable().defaultTo(true);
      t.decimal('soft_penalty_per_min', 6, 2).notNullable().defaultTo(5.0);
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`
      ALTER TABLE break_rules
        ADD CONSTRAINT break_rules_scope_kind_check
        CHECK (scope_kind IN ('global','role','user'));
    `);
    await knex.raw(`
      ALTER TABLE break_rules
        ADD CONSTRAINT break_rules_kind_check
        CHECK (kind IN ('lunch','admin'));
    `);
    await knex.raw(`
      INSERT INTO break_rules
        (scope_kind, kind, earliest, latest, duration_min, hard_required, soft_penalty_per_min)
      VALUES
        ('global', 'lunch', '13:00', '14:30', 60, TRUE, 5.0);
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('break_rules');
};
