/**
 * Add dataplor_id to pharmacies and marzam_clients.
 *
 * Closes the BlackPrint↔Marzam match: BQ table
 * `staging.stg_marzam_clients_ecatepec` carries the dataplor_id that lives in
 * BlackPrint's `pharmacies` table. Once both sides have it, the ETL job
 * `sync-clients-ecatepec` can do a single UPDATE to fill `pharmacy_id` on the
 * Marzam side.
 *
 *   pharmacies.dataplor_id      — UNIQUE (one BlackPrint row per dataplor_id)
 *   marzam_clients.dataplor_id  — non-unique (a marzam client may not have one
 *                                  yet, and corner cases like duplicate cpadre
 *                                  → same dataplor_id should be flagged not
 *                                  rejected at DB level)
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('dataplor_id', 128);
  });
  await knex.schema.alterTable('marzam_clients', (t) => {
    t.string('dataplor_id', 128);
  });

  await knex.raw('CREATE UNIQUE INDEX idx_pharmacies_dataplor_id ON pharmacies (dataplor_id) WHERE dataplor_id IS NOT NULL;');
  await knex.raw('CREATE INDEX idx_marzam_clients_dataplor_id ON marzam_clients (dataplor_id);');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pharmacies_dataplor_id;');
  await knex.raw('DROP INDEX IF EXISTS idx_marzam_clients_dataplor_id;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('dataplor_id');
  });
  await knex.schema.alterTable('marzam_clients', (t) => {
    t.dropColumn('dataplor_id');
  });
};
