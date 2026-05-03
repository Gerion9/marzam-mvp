/**
 * Add scoring columns from `integration.int_marzam_prospect_scored` to the
 * `pharmacies` table.
 *
 *   quadrant         CHAR(2)   — 'Q1'..'Q4'  (alto / medio / bajo / muy bajo
 *                                 potencial de venta).  Source of truth: the
 *                                 column `quadrant` in the BQ scored table.
 *   final_score      NUMERIC   — 0..100 dataplor potential-of-sale score
 *                                 (column `final_score` in the BQ scored
 *                                 table, also seen historically as
 *                                 `composite_score` / `dataplor_100`).
 *   cpadre           VARCHAR   — `clave_mostradores_marzam` /
 *                                 `clave_mostrador` — non-null when the row
 *                                 is also a Marzam client (lets us join
 *                                 against `marzam_clients` if needed without
 *                                 going through `dataplor_id`).
 *
 * Why each one:
 *   - `quadrant` drives the 4-color overlay in the field-rep map and the
 *     "Mis rutas" heatmap.  Right now the column lives in BQ but is dropped
 *     during ingest, which forces the front-end to fall back to the static
 *     demo file.  After this migration `npm run bq:sync prospects` will
 *     populate it on every run.
 *   - `final_score` is the precursor that BlackPrint uses to derive the
 *     quadrant.  Storing it lets us re-derive Qx locally if the business
 *     rule changes, and lets us order rows by potential within a quadrant.
 *   - `cpadre` is the bridge to `marzam_clients` (the Marzam-side dataset).
 *     It's NULL for pure prospects and populated for rows that are also in
 *     the Marzam universe.
 *
 * The `quadrant` column is indexed because the map filters by Qx at every
 * pan/zoom and a sequential scan over ~180k rows of pharmacies is unaffordable.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('quadrant', 2);
    t.decimal('final_score', 6, 2);
    t.string('cpadre', 64);
  });

  // CHECK constraint so we never end up with garbage values from a future BQ
  // schema change (e.g. they start emitting 'q1' lowercase or 'TIER_A').
  await knex.raw(`
    ALTER TABLE pharmacies
      ADD CONSTRAINT pharmacies_quadrant_check
      CHECK (quadrant IS NULL OR quadrant IN ('Q1', 'Q2', 'Q3', 'Q4'));
  `);

  // Partial index — most rows in `pharmacies` are Marzam clients without a
  // quadrant; we only care about indexing the prospects (the ones the map
  // actually filters on).
  await knex.raw(`
    CREATE INDEX idx_pharmacies_quadrant
      ON pharmacies (quadrant)
      WHERE quadrant IS NOT NULL;
  `);

  await knex.raw(`
    CREATE INDEX idx_pharmacies_cpadre
      ON pharmacies (cpadre)
      WHERE cpadre IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_cpadre;');
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_quadrant;');
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_quadrant_check;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('cpadre');
    t.dropColumn('final_score');
    t.dropColumn('quadrant');
  });
};
