/**
 * Fix the cpadre/clave_mostrador naming bug introduced in migration 044.
 *
 * BACKGROUND
 * ----------
 * Empirical exploration of the BQ source tables (2026-04-30) confirmed:
 *
 *   `int_marzam_prospect_scored.clave_mostradores_marzam`
 *      = LEAF mostrador identifier (e.g., 'A37636', 'D87628')
 *      Format: 1 letter + 5 digits, ALWAYS unique per pharmacy.
 *
 *   `stg_marzam_detalle_mostrador.cpadre`
 *      = PARENT account identifier (e.g., '99307')
 *      Format: 5 digits.  ONE-to-MANY with leaf mostradores
 *      (one cuenta padre groups many farmacias).
 *
 *   `stg_marzam_detalle_mostrador.mostradores`
 *      = LEAF mostrador identifier (same format as
 *      `clave_mostradores_marzam` above).  This is the actual join key.
 *
 * Migration 044 mapped both into a `cpadre` column under the
 * (mistaken) assumption that they represented the same concept.  In
 * reality `pharmacies.cpadre` ended up storing LEAF values while
 * `marzam_clients.cpadre` stored PARENT values — a join between them
 * produces 0 matches (validated empirically).
 *
 * THIS MIGRATION
 * --------------
 *   1) RENAME `pharmacies.cpadre` → `pharmacies.clave_mostrador`
 *      (its actual semantic — leaf mostrador).  The old index is
 *      recreated under the new name.
 *
 *   2) ADD `marzam_clients.clave_mostrador` (new column).  The existing
 *      `marzam_clients.cpadre` stays as-is (its meaning is correct:
 *      parent account).  The new column is filled by syncDetalleMostrador
 *      from `stg_marzam_detalle_mostrador.mostradores`.
 *
 * After this migration, propagateMarzamPareto can join correctly:
 *   pharmacies.clave_mostrador  ↔  marzam_clients.clave_mostrador
 */

exports.up = async function up(knex) {
  // ── 1) pharmacies.cpadre → pharmacies.clave_mostrador ──
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_cpadre;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.renameColumn('cpadre', 'clave_mostrador');
  });
  await knex.raw(`
    CREATE INDEX idx_pharmacies_clave_mostrador
      ON pharmacies (clave_mostrador)
      WHERE clave_mostrador IS NOT NULL;
  `);

  // ── 2) marzam_clients.clave_mostrador (new) ──
  await knex.schema.alterTable('marzam_clients', (t) => {
    t.string('clave_mostrador', 32);
  });
  await knex.raw(`
    CREATE INDEX idx_marzam_clients_clave_mostrador
      ON marzam_clients (clave_mostrador)
      WHERE clave_mostrador IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  // ── revert (2) ──
  await knex.raw('DROP INDEX IF EXISTS idx_marzam_clients_clave_mostrador;');
  await knex.schema.alterTable('marzam_clients', (t) => {
    t.dropColumn('clave_mostrador');
  });
  // ── revert (1) ──
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_clave_mostrador;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.renameColumn('clave_mostrador', 'cpadre');
  });
  await knex.raw(`
    CREATE INDEX idx_pharmacies_cpadre
      ON pharmacies (cpadre)
      WHERE cpadre IS NOT NULL;
  `);
};
