/**
 * users.external_id — bridge column between the canonical UUID stored in
 * `users.id` and the legacy/virtual identifier emitted by the access
 * directory (`u-dir-001`, `u-rep-001`, …).
 *
 * The runtime accessDirectory derives `db_user_id = uuidv5(virtual_id, NS)`
 * deterministically, so JWT subjects line up with `users.id` without any
 * lookup. `external_id` is purely a debugging/auditing aid: it lets analysts
 * cross-reference DB rows against the AUTH_DIRECTORY_JSON and against any
 * BigQuery extracts that still emit virtual ids.
 *
 * No FK is enforced — the column is informational and may be NULL for users
 * that were created directly through the API.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('external_id', 128);
  });
  await knex.raw(
    'CREATE UNIQUE INDEX idx_users_external_id ON users (external_id) WHERE external_id IS NOT NULL;',
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_users_external_id;');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('external_id');
  });
};
