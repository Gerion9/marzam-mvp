/**
 * Audit retention — `audit_events` is append-only and grows forever today.
 * This migration adds the archive table that the new monthly cron uses.
 *
 * Background — audit Fix #10 (docs/qa-fix-plan.md):
 *   Decision: retention = 2 years (730 days, env AUDIT_RETENTION_DAYS).
 *   Strategy: archive-then-delete to preserve forensic value while bounding
 *   the active table. The archive table can be dumped to cold storage on a
 *   slower cadence.
 *
 * Schema mirrors `audit_events` exactly so we can `INSERT ... SELECT`. The
 * monthly cron (registered in admin.routes.js as cronAuditRetention) does:
 *
 *   WITH old AS (
 *     DELETE FROM audit_events
 *     WHERE created_at < NOW() - INTERVAL '${days} days'
 *     RETURNING *
 *   )
 *   INSERT INTO audit_events_archive SELECT * FROM old;
 *
 * The CTE inside a single statement guarantees the move is atomic — no
 * window where rows are missing from both tables.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('audit_events_archive');
  if (has) return;

  await knex.schema.createTable('audit_events_archive', (t) => {
    // Same columns as audit_events. NOT a primary key here so an
    // INSERT/SELECT from the live table copies ids verbatim without a
    // potential pk collision in case of double-archive (defensive).
    t.uuid('id').notNullable();
    // No FK on user_id — preserves rows even if a user is deleted later.
    t.uuid('user_id');
    t.string('action', 255).notNullable();
    t.string('entity_type', 100);
    t.uuid('entity_id');
    t.jsonb('before_state');
    t.jsonb('after_state');
    t.string('ip_address', 45);
    t.timestamp('created_at');
    // When this archive row was written by the retention cron.
    t.timestamp('archived_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_audit_archive_created_at
      ON audit_events_archive (created_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_audit_archive_id
      ON audit_events_archive (id);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('audit_events_archive');
};
