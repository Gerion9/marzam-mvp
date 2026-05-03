/**
 * visit_sessions — "Modo Visita" sesiones cronometradas.
 *
 * Una sesión va desde que el usuario pulsa "Iniciar Modo Visita" hasta que
 * la cierra manualmente o el sistema la marca como `abandoned` (idle > N horas).
 *
 * Se usan para:
 * - Mostrar el cronómetro en vivo en la UI (tiempo desde primer check-in
 *   hasta último).
 * - Vincular cada `tracking.checkin` a una sesión (`current_visit_session_id`)
 *   y poder agregar KPIs: tiempo total, tiempo en farmacia vs en ruta,
 *   distancia, eficiencia, comparativa con promedio.
 * - Mostrar a los managers en "Mi Equipo" qué subordinados están actualmente
 *   en visita (presence_status = 'live').
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('branch_id').references('id').inTable('branches').onDelete('SET NULL');
    t.uuid('visit_plan_id').references('id').inTable('visit_plans').onDelete('SET NULL');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('ended_at');
    t.timestamp('last_ping_at');
    t.integer('pharmacies_planned').defaultTo(0);
    t.integer('pharmacies_visited').defaultTo(0);
    t.integer('total_distance_m');
    t.integer('idle_seconds').defaultTo(0);
    t.string('status', 16).notNullable().defaultTo('active');
    t.string('ended_reason', 32);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE visit_sessions
      ADD CONSTRAINT visit_sessions_status_check
      CHECK (status IN ('active','ended','abandoned'));
  `);

  // Solo una sesión activa por usuario a la vez.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_visit_sessions_user_active
      ON visit_sessions (user_id) WHERE status = 'active';
  `);
  await knex.raw('CREATE INDEX idx_visit_sessions_user ON visit_sessions (user_id, started_at DESC);');
  await knex.raw('CREATE INDEX idx_visit_sessions_branch ON visit_sessions (branch_id);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_sessions');
};
