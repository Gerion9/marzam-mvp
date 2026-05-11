/**
 * user_preferences — bag jsonb por usuario para preferencias de UI.
 *
 * Primer consumidor: estado del sistema de tutorial guiado (preferences.tutorial =
 * { seen, seenAt, dismissedForever, completedTours: [], lastTourId, lastStepIdx }).
 *
 * El cliente persiste en localStorage para boot instantáneo y sincroniza vía
 * PATCH /api/users/me/preferences (last-write-wins por updated_at). El jsonb
 * permite extensión futura (otras preferencias UX, por ejemplo idioma del UI
 * cuando se internacionalice) sin migración nueva.
 *
 * ON DELETE CASCADE: si un user se borra (improbable — normalmente solo se
 * desactiva), sus preferencias se van con él. No hay dato auditable aquí.
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('user_preferences');
  if (exists) return;

  await knex.schema.createTable('user_preferences', (t) => {
    t.uuid('user_id')
      .primary()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.jsonb('preferences').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS ix_user_preferences_updated_at
      ON marzam_app.user_preferences(updated_at);
  `);

  // Trigger para autoupdate de updated_at — barato, evita lógica en app code.
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION marzam_app.user_preferences_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS trg_user_preferences_updated_at ON marzam_app.user_preferences;
    CREATE TRIGGER trg_user_preferences_updated_at
      BEFORE UPDATE ON marzam_app.user_preferences
      FOR EACH ROW
      EXECUTE FUNCTION marzam_app.user_preferences_set_updated_at();
  `);
};

exports.down = async function down(knex) {
  await knex.schema.raw('DROP TRIGGER IF EXISTS trg_user_preferences_updated_at ON marzam_app.user_preferences;');
  await knex.schema.raw('DROP FUNCTION IF EXISTS marzam_app.user_preferences_set_updated_at();');
  await knex.schema.raw('DROP INDEX IF EXISTS marzam_app.ix_user_preferences_updated_at;');
  await knex.schema.dropTableIfExists('user_preferences');
};
