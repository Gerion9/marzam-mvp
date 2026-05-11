/**
 * users.user_skills — capacidades de captación / mantenimiento por persona.
 *
 * Aplica a TODOS los roles (rep, supervisor, gerente, director). Algunos
 * usuarios únicamente captan farmacias nuevas, otros solo mantienen cuentas
 * Marzam existentes, otros un mix. Catálogo controlado en
 * `src/constants/userSkills.js` (no requiere migration para extender).
 *
 * Semántica:
 *   - DEFAULT '[]' (sin restricción operativa — usuario puede atender cualquier
 *     target cuyo required_skills esté NULL / vacío).
 *   - Array poblado limita al usuario a targets cuyo required_skills intersecte
 *     este conjunto (intersección no-vacía).
 *
 * Índice GIN sobre el JSONB para soportar consultas del tipo
 *   WHERE user_skills @> '["marzam_maintenance"]'::jsonb
 * que planGenerator usa para filtrar pools de candidates.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('users', 'user_skills');
  if (!has) {
    await knex.schema.alterTable('users', (t) => {
      t.jsonb('user_skills').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    });
    // El DEFAULT solo aplica a INSERTs nuevos; backfill explícito para filas
    // existentes que pudieron quedar con NULL en el momento del ALTER.
    await knex.raw(`
      UPDATE users
         SET user_skills = '[]'::jsonb
       WHERE user_skills IS NULL
    `);
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_user_skills_gin
      ON users USING GIN (user_skills);
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_users_user_skills_gin;');
  const has = await knex.schema.hasColumn('users', 'user_skills');
  if (has) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('user_skills');
    });
  }
};
