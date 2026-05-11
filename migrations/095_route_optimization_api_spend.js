/**
 * Google Route Optimization API daily spend tracker.
 *
 * Sibling de `routes_api_spend` (mig 061) y `geocoding_api_spend` (mig 092),
 * pero para el SKU de Route Optimization API (VRP managed). Se incrementa por
 * UPSERT desde `src/services/routeOptimization.js` en cada llamada exitosa,
 * rechazada por budget o fallida.
 *
 * Pricing (tentativo, ajustar en `src/services/pricing.js` cuando Google
 * confirme post-marzo 2025):
 *   $0.13 por shipment procesado (Route Optimization API basic tier).
 *
 * El feature está detrás de `PLAN_USE_OPTIMIZATION_API` (default OFF). La
 * tabla existe igual para que el dashboard de BlackPrint la lea sin error
 * cuando el flag esté apagado (devuelve 0 / null).
 *
 * Consumida por:
 *   - GET /api/blackprint/cost-summary  (today / MTD / YTD)
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('route_optimization_api_spend');
  if (has) return;
  await knex.schema.createTable('route_optimization_api_spend', (t) => {
    t.date('day').primary();
    t.integer('optimization_calls').notNullable().defaultTo(0);
    t.integer('total_vehicles').notNullable().defaultTo(0);
    t.integer('total_shipments').notNullable().defaultTo(0);
    t.decimal('est_cost_usd', 10, 4).notNullable().defaultTo(0);
    t.integer('rejected_calls').notNullable().defaultTo(0);
    t.integer('failed_calls').notNullable().defaultTo(0);
    t.timestamp('first_call_at').defaultTo(knex.fn.now());
    t.timestamp('last_call_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('route_optimization_api_spend');
};
