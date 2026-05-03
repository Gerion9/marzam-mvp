/**
 * Persistent log of soft warnings emitted by the BQ sync jobs.
 *
 * Distinct from `audit_events` because these are NOT user actions — they're
 * data quality findings that a director can review and "resolve" (e.g.
 * "two employees share the same email in cuadro_basico — pick one").
 *
 * Categories (free-form code, but document common ones here):
 *   - email_conflict        : another user already owns the email coming from BQ
 *   - email_invalid         : email value is malformed
 *   - role_unknown          : role/puesto from BQ is not in our enum
 *   - manager_unresolved    : manager_employee_code points to a row not in BQ
 *   - branch_missing        : employee has no branch_code
 *   - duplicate_employee    : same employee_code appears twice in BQ
 *   - cpadre_no_pharmacy    : marzam_clients row has cpadre but no matching dataplor_id
 *   - cpadre_no_marzam_client: clients_ecatepec referenced cpadre absent from marzam_clients
 *
 * Idempotency: a job is allowed to UPSERT warnings on (job_name, code, subject)
 * so re-runs don't bloat the table.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('bq_sync_warnings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('job_name', 80).notNullable();
    t.string('code', 80).notNullable();
    t.string('severity', 16).notNullable().defaultTo('warn');
    t.string('subject', 255); // e.g. employee_code, cpadre, dataplor_id
    t.jsonb('detail').notNullable().defaultTo('{}');
    t.boolean('resolved').notNullable().defaultTo(false);
    t.timestamp('first_seen_at').defaultTo(knex.fn.now());
    t.timestamp('last_seen_at').defaultTo(knex.fn.now());
    t.integer('occurrence_count').notNullable().defaultTo(1);
    t.uuid('resolved_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('resolved_at');
    t.text('resolution_note');
  });

  // Idempotent UPSERT key — same (job, code, subject) is the same warning
  await knex.raw(`
    CREATE UNIQUE INDEX uq_bq_sync_warnings_logical
      ON bq_sync_warnings (job_name, code, COALESCE(subject, ''))
  `);
  await knex.raw(`
    CREATE INDEX idx_bq_sync_warnings_unresolved
      ON bq_sync_warnings (resolved, last_seen_at DESC)
      WHERE resolved = false
  `);
  await knex.raw(`
    CREATE INDEX idx_bq_sync_warnings_severity
      ON bq_sync_warnings (severity, last_seen_at DESC)
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('bq_sync_warnings');
};
