/**
 * Add a LOCAL, derived quadrant column to `pharmacies` so the field-rep map
 * has a 4-bucket potential signal that doesn't depend on BlackPrint's
 * upstream classification (which empirically lumps ~96 % of prospects into
 * Q1 — see notes/quadrant-analysis.md / commit message).
 *
 *   pharmacies.quadrant          ← source of truth from BQ
 *                                  (`integration.int_marzam_prospect_scored.quadrant`)
 *                                  Persisted as-is for auditing and so we
 *                                  can reconcile against BlackPrint at any
 *                                  time.  NEVER mutated post-sync.
 *
 *   pharmacies.quadrant_derived  ← computed by us via NTILE(4) over
 *                                  `final_score`, recomputed at the end of
 *                                  every prospect sync.  This is the column
 *                                  the UI consumes:
 *                                    Q1 = top 25 % by final_score (alto)
 *                                    Q2 = next 25 %                (medio)
 *                                    Q3 = next 25 %                (bajo)
 *                                    Q4 = bottom 25 %              (muy bajo)
 *
 * Why NTILE(4) instead of fixed cuts (≥75, ≥50, ≥25)?
 *   - We don't control the `final_score` scale; BlackPrint can rescale.
 *   - With percentile buckets, the map *always* shows ~equal numbers of
 *     each color → useful prioritization signal at any time.
 *   - Trade-off: a "Q1" today is not necessarily comparable to a "Q1"
 *     six months from now.  We accept that — the column is for *current*
 *     prioritization, not historical analytics (we have `final_score` and
 *     `quadrant` for that).
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('quadrant_derived', 2);
  });

  await knex.raw(`
    ALTER TABLE pharmacies
      ADD CONSTRAINT pharmacies_quadrant_derived_check
      CHECK (quadrant_derived IS NULL OR quadrant_derived IN ('Q1', 'Q2', 'Q3', 'Q4'));
  `);

  await knex.raw(`
    CREATE INDEX idx_pharmacies_quadrant_derived
      ON pharmacies (quadrant_derived)
      WHERE quadrant_derived IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_quadrant_derived;');
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_quadrant_derived_check;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('quadrant_derived');
  });
};
