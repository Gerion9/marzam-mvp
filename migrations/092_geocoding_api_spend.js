/**
 * Geocoding API daily spend tracker (BlackPrint admin observability).
 *
 * Mirrors the shape of routes_api_spend (mig 061) but tracks the Google
 * Geocoding API surface. One row per UTC day, UPSERT-incremented from
 * src/services/geocoder.js on every call (cache hit, Google call, or
 * rejected/failed).
 *
 * SKU pricing (Google Maps Platform Geocoding, 2026):
 *   Geocoding API:  $5 / 1000 calls (first 100k tier; degrades thereafter)
 *
 * For simplicity we record a flat $0.005/call. If usage approaches the tier
 * boundary the BlackPrint cost-summary endpoint can apply tier pricing in
 * post-processing; the row data is enough to recompute exactly.
 *
 * Used by:
 *   - GET /api/blackprint/cost-summary  (today / MTD / YTD)
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('geocoding_api_spend');
  if (has) return;
  await knex.schema.createTable('geocoding_api_spend', (t) => {
    t.date('day').primary();
    t.integer('geocoding_calls').notNullable().defaultTo(0);
    t.integer('cache_hits').notNullable().defaultTo(0);
    t.integer('rejected_calls').notNullable().defaultTo(0);
    t.decimal('est_cost_usd', 10, 4).notNullable().defaultTo(0);
    t.timestamp('first_call_at').defaultTo(knex.fn.now());
    t.timestamp('last_call_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('geocoding_api_spend');
};
