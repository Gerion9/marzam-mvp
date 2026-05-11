/**
 * pharmacies + marzam_clients — required_skills / estimated_visit_minutes /
 * hard_window_start / hard_window_end.
 *
 * - required_skills (JSONB nullable): array de skills (catálogo
 *   src/constants/userSkills.js) que el visitor debe poseer EN AL MENOS UNO.
 *   NULL o array vacío significa "cualquier usuario elegible" (default).
 *
 * - estimated_visit_minutes (INT nullable): tiempo de servicio por visita.
 *   NULL → planGenerator usa `users.service_minutes_per_stop` (default global
 *   por rep, hoy 45). Valores típicos 15-45 según complejidad. Permite ajustar
 *   por farmacia individual cuando el cliente confirme el dato.
 *
 * - hard_window_start / hard_window_end (TIME nullable): ventanas duras de
 *   atención. Modelado pero NO enforzado a menos que
 *   `PLAN_HARD_WINDOWS_ENFORCED=true` (feature flag separado del optimizer).
 *   El campo opening_hours_v2 (mig 070) sigue siendo la fuente para soft
 *   windows; este par es para forzar (cuando el cliente lo confirme).
 *
 * Índice GIN sobre required_skills para soportar
 *   WHERE required_skills @> '["new_pharmacy_capture"]'::jsonb
 * en queries del planGenerator (filtra pool de farmacias por skill del rep).
 */

const PHARMACY_TABLES = ['pharmacies', 'marzam_clients'];

exports.up = async function up(knex) {
  for (const table of PHARMACY_TABLES) {
    const hasTable = await knex.schema.hasTable(table);
    if (!hasTable) continue;

    const [hasReq, hasMin, hasWStart, hasWEnd] = await Promise.all([
      knex.schema.hasColumn(table, 'required_skills'),
      knex.schema.hasColumn(table, 'estimated_visit_minutes'),
      knex.schema.hasColumn(table, 'hard_window_start'),
      knex.schema.hasColumn(table, 'hard_window_end'),
    ]);

    if (!hasReq || !hasMin || !hasWStart || !hasWEnd) {
      await knex.schema.alterTable(table, (t) => {
        if (!hasReq) t.jsonb('required_skills').defaultTo(null);
        if (!hasMin) t.integer('estimated_visit_minutes').defaultTo(null);
        if (!hasWStart) t.time('hard_window_start').defaultTo(null);
        if (!hasWEnd) t.time('hard_window_end').defaultTo(null);
      });
    }

    // CHECK: si ambos windows están seteados, start < end. NULLs permitidos.
    await knex.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${table}_hard_window_order_check'
            AND conrelid = '${table}'::regclass
        ) THEN
          ALTER TABLE ${table}
            ADD CONSTRAINT ${table}_hard_window_order_check
            CHECK (
              hard_window_start IS NULL
              OR hard_window_end IS NULL
              OR hard_window_start < hard_window_end
            );
        END IF;
      END $$;
    `);

    // CHECK: estimated_visit_minutes positivo (NULL permitido).
    await knex.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${table}_estimated_visit_minutes_check'
            AND conrelid = '${table}'::regclass
        ) THEN
          ALTER TABLE ${table}
            ADD CONSTRAINT ${table}_estimated_visit_minutes_check
            CHECK (estimated_visit_minutes IS NULL OR estimated_visit_minutes > 0);
        END IF;
      END $$;
    `);

    // GIN sobre required_skills (parcial: solo donde no es NULL para no
    // engordar el índice innecesariamente — la mayoría de filas tendrán NULL).
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_${table}_required_skills_gin
        ON ${table} USING GIN (required_skills)
        WHERE required_skills IS NOT NULL;
    `);
  }
};

exports.down = async function down(knex) {
  for (const table of PHARMACY_TABLES) {
    const hasTable = await knex.schema.hasTable(table);
    if (!hasTable) continue;
    await knex.raw(`DROP INDEX IF EXISTS idx_${table}_required_skills_gin;`);
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_hard_window_order_check;`);
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_estimated_visit_minutes_check;`);
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('required_skills');
      t.dropColumn('estimated_visit_minutes');
      t.dropColumn('hard_window_start');
      t.dropColumn('hard_window_end');
    });
  }
};
