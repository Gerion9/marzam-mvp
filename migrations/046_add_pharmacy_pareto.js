/**
 * Add `pareto` to `pharmacies`.
 *
 *   pharmacies.pareto  CHAR(1) NULL  — 'A' / 'B' / 'C'
 *
 * Why on `pharmacies` (and not just on `marzam_clients`)?
 *   The user-facing universe in the field-rep map is `pharmacies` — every
 *   row, whether it's a Marzam client or a Blackprint prospect.  The
 *   classification rule is:
 *
 *     IF the row is a Marzam client (`source = 'marzam'`)
 *        → show by PARETO  (column `pharmacies.pareto`,  values A/B/C)
 *     ELSE (`source = 'blackprint'`)
 *        → show by QUADRANT (column `pharmacies.quadrant`, values Q1..Q4)
 *
 *   Keeping both signals colocated in `pharmacies` lets the FE render the
 *   overlay with one query (no JOIN against `marzam_clients` for this
 *   single attribute — saves us a join × millions of POIs).
 *
 *   The `pareto` value comes from `int_marzam_prospect_scored.tier_clean`
 *   on rows where `cliente_marzam = TRUE`.  For prospects the column is
 *   left NULL.  We don't try to keep this in lockstep with
 *   `marzam_clients.pareto` (filled by `syncDetalleMostrador` from a
 *   different BQ table) — they should always agree because they're the
 *   same business concept, but if BlackPrint ever publishes a discrepancy
 *   we want to *see* the discrepancy, not silently dedup.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('pareto', 1);
  });

  await knex.raw(`
    ALTER TABLE pharmacies
      ADD CONSTRAINT pharmacies_pareto_check
      CHECK (pareto IS NULL OR pareto IN ('A', 'B', 'C'));
  `);

  await knex.raw(`
    CREATE INDEX idx_pharmacies_pareto
      ON pharmacies (pareto)
      WHERE pareto IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_pareto;');
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_pareto_check;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('pareto');
  });
};
