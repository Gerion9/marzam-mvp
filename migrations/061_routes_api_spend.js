/**
 * Routes API daily spend tracker.
 *
 * One row per UTC day. Updated transactionally (UPSERT) on each Routes API
 * call inside src/services/routesMatrix.js. Used by:
 *   - the cost guard (rejects calls when est_cost_usd >= daily budget)
 *   - GET /api/admin/routes-budget (admin dashboard)
 *
 * SKU pricing (Google Maps Platform Routes, 2026):
 *   Compute Route Matrix (Essentials, TRAFFIC_UNAWARE):    $5 / 1000 elements
 *   Compute Route Matrix (Pro,        TRAFFIC_AWARE):     $10 / 1000 elements
 *   Compute Routes single (Essentials):                    $5 / 1000 calls
 *
 * The service writes the running USD estimate so the admin endpoint can
 * surface remaining budget without recomputing.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('routes_api_spend');
  if (has) return;
  await knex.schema.createTable('routes_api_spend', (t) => {
    t.date('day').primary();
    t.integer('matrix_calls').notNullable().defaultTo(0);
    t.integer('matrix_elements').notNullable().defaultTo(0);
    t.integer('route_calls').notNullable().defaultTo(0);
    t.decimal('est_cost_usd', 10, 4).notNullable().defaultTo(0);
    t.timestamp('first_call_at').defaultTo(knex.fn.now());
    t.timestamp('last_call_at').defaultTo(knex.fn.now());
    t.integer('rejected_calls').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('routes_api_spend');
};
