/**
 * error_log — append-only ledger of unhandled errors / 5xx responses.
 *
 * Pre-audit, errors were only logged to console (Vercel function logs). That
 * worked for ad-hoc triage but had no aggregation: "how many 500s in the last
 * hour?" or "which endpoint is failing for which user?" required scrubbing
 * raw text logs. With this table any admin can query the dashboard and
 * /api/admin/errors returns paginated results filterable by status, path,
 * and time window. Audit O4.
 *
 * Cron `purge-error-log` (added to vercel.json on a separate fix) trims rows
 * older than ERROR_LOG_RETENTION_DAYS (default 90). Errors should be a
 * trailing indicator, not a permanent archive.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('error_log');
  if (has) return;

  await knex.schema.createTable('error_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.timestamp('occurred_at').notNullable().defaultTo(knex.fn.now());
    t.text('request_id');
    t.uuid('user_id');
    t.text('method');
    t.text('path');
    t.integer('status');
    t.text('error_name');
    t.text('error_message');
    t.text('stack');
    t.jsonb('payload');
  });

  await knex.raw(`
    CREATE INDEX idx_error_log_occurred
      ON error_log (occurred_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_error_log_status_occurred
      ON error_log (status, occurred_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_error_log_request
      ON error_log (request_id);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('error_log');
};
