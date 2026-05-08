/**
 * sse_tickets — short-lived single-use credentials for SSE connections.
 *
 * Pre-audit, the live stream endpoint accepted `?token=<full JWT>` in the
 * query string. EventSource cannot set headers, so this was the only path —
 * but the JWT then ended up in Vercel access logs, browser history, and
 * Referer headers. If the URL leaked anywhere, the attacker had the long
 * (8h) JWT. See audit S5.
 *
 * The fix is a token-exchange endpoint (POST /api/auth/sse-ticket) that takes
 * the full JWT in an Authorization header and returns a UUID ticket. The
 * client then connects to /api/live/stream?ticket=<uuid>. Tickets are
 * short-lived (default 60s) so the leak window is bounded.
 *
 * Schema notes:
 *   - `payload` mirrors the verified JWT claims (id, role, scope, etc.) so
 *     the auth middleware can hydrate req.user without re-fetching from
 *     `users`. This keeps SSE connect latency low.
 *   - `used_at` is informational. We allow ticket re-use within the expiry
 *     window so SSE reconnects don't have to round-trip through a fresh
 *     exchange — the time bound is the only security control.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('sse_tickets');
  if (has) return;

  await knex.schema.createTable('sse_tickets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable();
    t.jsonb('payload').notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_sse_tickets_expires
      ON sse_tickets (expires_at);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sse_tickets');
};
