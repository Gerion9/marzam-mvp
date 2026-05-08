/**
 * Audit P5 — partial index on pharmacies(municipality, status).
 *
 * Plan generation in src/modules/visit-plans/planGenerator.js filters the
 * candidate set by municipality + status across 3,121 rows; without this
 * index every plan-generation pass triggers a sequential scan. The partial
 * predicate `status IN ('A','B','C')` keeps the index small (skip uniformly
 * 'D' / 'X' / null status rows) which is fine because plan generation
 * never targets those.
 *
 * Non-concurrent because pharmacies has 3,121 rows and the migration runs
 * during a deploy window — the brief AccessExclusiveLock is acceptable.
 * Switch to `CREATE INDEX CONCURRENTLY` (and exports.config.transaction=false)
 * when row count crosses 100K.
 */

exports.up = async function up(knex) {
  // Idempotent — `IF NOT EXISTS` so a partial migration replay doesn't blow up.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pharmacies_municipality_status
      ON pharmacies (municipality, status)
      WHERE status IN ('A','B','C');
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_municipality_status;');
};
