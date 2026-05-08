/**
 * visit_targets — frequency × mirror-effect matrix, parametrized.
 *
 * Replaces the hardcoded matrix from the "Estrategia Comercial Abr-May 2026"
 * deck. Rows are unique per (branch_id, pareto_class, channel, role,
 * effective_from). branch_id NULL means a global default that applies to every
 * branch unless that branch has its own override.
 *
 * Seed at the end of `up()` plants the values from slide 23.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_targets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('branch_id').references('id').inTable('branches').onDelete('CASCADE');
    t.string('pareto_class', 1);
    t.string('channel', 32).notNullable().defaultTo('visit');
    t.string('role', 64).notNullable();
    t.integer('head_count');
    t.integer('daily_contacts_per_person').notNullable().defaultTo(0);
    t.integer('monthly_target');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.date('effective_from').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
    t.date('effective_to');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE visit_targets
      ADD CONSTRAINT visit_targets_pareto_check
      CHECK (pareto_class IS NULL OR pareto_class IN ('A', 'B', 'C'));
  `);
  await knex.raw(`
    ALTER TABLE visit_targets
      ADD CONSTRAINT visit_targets_channel_check
      CHECK (channel IN ('visit', 'contact_center'));
  `);

  // A composite index that supports `resolve_visit_target` lookups.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_visit_targets_uniq
      ON visit_targets (
        COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(pareto_class, ''),
        channel,
        role,
        effective_from
      );
  `);
  await knex.raw('CREATE INDEX idx_visit_targets_branch ON visit_targets (branch_id);');
  await knex.raw('CREATE INDEX idx_visit_targets_role_pareto ON visit_targets (role, pareto_class);');

  // -------------------------------------------------------------------------
  // Seed: slide 23 of the Apr-May 2026 deck.
  // branch_id = NULL → global default. Each branch may clone & override later.
  // -------------------------------------------------------------------------
  const seed = [
    // Visits (channel = 'visit')
    { pareto_class: 'A', channel: 'visit', role: 'director_sucursal', head_count: 1,   daily_contacts_per_person: 7,  monthly_target: 140 },
    { pareto_class: 'A', channel: 'visit', role: 'gerente_ventas',    head_count: 6,   daily_contacts_per_person: 8,  monthly_target: 840 },
    { pareto_class: 'A', channel: 'visit', role: 'supervisor',        head_count: 11,  daily_contacts_per_person: 3,  monthly_target: 660 },
    { pareto_class: 'B', channel: 'visit', role: 'supervisor',        head_count: 11,  daily_contacts_per_person: 2,  monthly_target: 563 },
    { pareto_class: 'C', channel: 'visit', role: 'representante',     head_count: 157, daily_contacts_per_person: 23, monthly_target: 4628 },

    // Contact center (channel = 'contact_center'). 74 personas total
    // (19 metropolitana + 55 Guadalajara). 130 efectivas/colaborador/mes.
    { pareto_class: 'A', channel: 'contact_center', role: 'contact_center_agent', head_count: 74, daily_contacts_per_person: 0,  monthly_target: 0 },
    { pareto_class: 'B', channel: 'contact_center', role: 'contact_center_agent', head_count: 74, daily_contacts_per_person: 15, monthly_target: 26640 },
    { pareto_class: 'C', channel: 'contact_center', role: 'contact_center_agent', head_count: 74, daily_contacts_per_person: 30, monthly_target: 2220 },
  ];

  for (const row of seed) {
    await knex('visit_targets').insert({
      branch_id: null,
      ...row,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_targets');
};
