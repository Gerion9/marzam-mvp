/**
 * Add a partial UNIQUE index on `pharmacies.clave_mostrador` so the sync
 * can upsert Marzam-CLIENT rows by clave_mostrador (their canonical key)
 * the same way it already upserts BlackPrint-PROSPECT rows by dataplor_id.
 *
 * Why we need TWO conflict keys:
 *   - PROSPECT rows in `staging.stg_marzam_master_scored_*` have a real
 *     `dataplor_id` (UUID) but no `mostradores` (clave_mostrador).
 *   - CLIENT rows in the same tables are the inverse: `dataplor_id IS NULL`
 *     because Dataplor doesn't know them, but `mostradores` carries the
 *     Marzam-internal client code ('A44755', 'D87628', ...).
 *
 *   So neither key alone covers the universe — we need the partial unique
 *   constraint on each, and the sync chooses which `ON CONFLICT (...)`
 *   clause to use based on `record_type`.
 *
 * Verified 2026-04-30 (scripts/check-clave-mostrador-conflicts.js):
 *   pharmacies has 0 rows with non-null clave_mostrador today, so adding
 *   UNIQUE is safe — no manual dedup needed.
 *
 * Index naming mirrors `idx_pharmacies_dataplor_id` (migration 031).
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX idx_pharmacies_clave_mostrador_unique
      ON pharmacies (clave_mostrador)
      WHERE clave_mostrador IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_clave_mostrador_unique;');
};
