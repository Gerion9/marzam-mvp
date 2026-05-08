/**
 * pharmacies — agrega opening_hours_v2 (jsonb estructurado) para soft-window scheduling.
 *
 * NO toca opening_hours/closing_hours legacy (string(255)) — esas siguen siendo la fuente.
 * El parser perezoso `openingHoursParser` corre en cron diario y popula opening_hours_v2.
 * Plan generator usa opening_hours_v2 cuando está parseado, fallback a default 09:00-19:00
 * cuando parse_status='unparseable' o NULL.
 *
 * Schema canónico:
 *   {
 *     "mon": [{"open":"09:30","close":"14:00"},{"open":"16:00","close":"21:00"}],
 *     "tue": [...], ..., "sun": [],
 *     "default_assumed": false   // true si el parser asumió default por falta de input
 *   }
 *
 * parse_status:
 *   'parsed'      — parser tuvo éxito sobre el string
 *   'unparseable' — parser no pudo interpretar; usa fallback default
 *   'manual'      — admin sobrescribió manualmente
 */

exports.up = async function up(knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('pharmacies', 'opening_hours_v2'),
    knex.schema.hasColumn('pharmacies', 'opening_hours_parsed_at'),
    knex.schema.hasColumn('pharmacies', 'opening_hours_parse_status'),
  ]);
  const [hasV2, hasParsedAt, hasStatus] = cols;
  if (!hasV2 || !hasParsedAt || !hasStatus) {
    await knex.schema.alterTable('pharmacies', (t) => {
      if (!hasV2) t.jsonb('opening_hours_v2');
      if (!hasParsedAt) t.timestamp('opening_hours_parsed_at');
      if (!hasStatus) t.text('opening_hours_parse_status');
    });
  }
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pharmacies_opening_hours_parse_status_check'
          AND conrelid = 'pharmacies'::regclass
      ) THEN
        ALTER TABLE pharmacies
          ADD CONSTRAINT pharmacies_opening_hours_parse_status_check
          CHECK (opening_hours_parse_status IS NULL
                 OR opening_hours_parse_status IN ('parsed','unparseable','manual'));
      END IF;
    END $$;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pharmacies_opening_hours_v2_gin
      ON pharmacies USING GIN (opening_hours_v2);
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pharmacies_opening_hours_parse_status
      ON pharmacies (opening_hours_parse_status)
      WHERE opening_hours_parse_status IS NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_opening_hours_parse_status;');
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_opening_hours_v2_gin;');
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_opening_hours_parse_status_check;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('opening_hours_v2');
    t.dropColumn('opening_hours_parsed_at');
    t.dropColumn('opening_hours_parse_status');
  });
};
