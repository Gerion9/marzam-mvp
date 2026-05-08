/**
 * rate_limit_buckets — distributed token-bucket counters in Postgres.
 *
 * The pre-audit code used express-rate-limit with the default in-memory store.
 * On Vercel that store is per-serverless-instance, which means a user can
 * cycle between cold-start instances and multiply the limit by N. This table
 * gives us a single global counter that all instances see, at the cost of
 * one INSERT-on-conflict round-trip per request.
 *
 * Used by src/middleware/rateLimitDb.js. Purge cron in admin.routes.js drops
 * rows whose `expires_at` has passed (default daily at 09:45 UTC).
 *
 * Composite PK so each (caller, window_start) lives in its own row — old
 * windows simply expire instead of being mutated. This keeps the row hot for
 * the duration of one window and avoids contention from late writes that
 * arrive after the window has rolled.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('rate_limit_buckets');
  if (has) return;

  await knex.schema.createTable('rate_limit_buckets', (t) => {
    t.text('bucket_key').notNullable();
    t.timestamp('window_start').notNullable();
    t.integer('count').notNullable().defaultTo(0);
    t.timestamp('expires_at').notNullable();
    t.primary(['bucket_key', 'window_start']);
  });

  await knex.raw(`
    CREATE INDEX idx_rlb_expires
      ON rate_limit_buckets (expires_at);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('rate_limit_buckets');
};
