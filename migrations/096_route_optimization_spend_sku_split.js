/**
 * route_optimization_api_spend — split per-SKU counters.
 *
 * Mig 095 creó la tabla con totals agregados. Google factura Route Optimization
 * con dos SKUs distintos dinámicamente seleccionados por `vehicles.length` en
 * el payload:
 *
 *   1 vehicle    → "Single Vehicle Routing" (Pro)        free 5,000/mes, $10/1k post-free
 *   2+ vehicles  → "Fleet Routing"          (Enterprise) free 1,000/mes, $30/1k post-free
 *
 * Como el free tier y la curva difieren drásticamente, los counters globales
 * no permiten calcular costo real ni mostrar el progreso del free tier por
 * SKU. Esta migración añade contadores granulares.
 *
 * `validate_only_calls` separa las llamadas con solvingMode=VALIDATE_ONLY que
 * Google NO factura — útil para CI/CD sin quemar presupuesto.
 *
 * Las columnas existentes (optimization_calls, total_vehicles, total_shipments,
 * est_cost_usd) se preservan como agregados; las nuevas son su descomposición.
 */

exports.up = async function up(knex) {
  const tableExists = await knex.schema.hasTable('route_optimization_api_spend');
  if (!tableExists) return; // mig 095 no aplicada todavía — esta queda no-op

  const cols = await Promise.all([
    knex.schema.hasColumn('route_optimization_api_spend', 'single_vehicle_calls'),
    knex.schema.hasColumn('route_optimization_api_spend', 'single_vehicle_shipments'),
    knex.schema.hasColumn('route_optimization_api_spend', 'fleet_routing_calls'),
    knex.schema.hasColumn('route_optimization_api_spend', 'fleet_routing_shipments'),
    knex.schema.hasColumn('route_optimization_api_spend', 'validate_only_calls'),
  ]);
  const [hasSc, hasSs, hasFc, hasFs, hasVo] = cols;

  if (hasSc && hasSs && hasFc && hasFs && hasVo) return;

  await knex.schema.alterTable('route_optimization_api_spend', (t) => {
    if (!hasSc) t.integer('single_vehicle_calls').notNullable().defaultTo(0);
    if (!hasSs) t.integer('single_vehicle_shipments').notNullable().defaultTo(0);
    if (!hasFc) t.integer('fleet_routing_calls').notNullable().defaultTo(0);
    if (!hasFs) t.integer('fleet_routing_shipments').notNullable().defaultTo(0);
    if (!hasVo) t.integer('validate_only_calls').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  const tableExists = await knex.schema.hasTable('route_optimization_api_spend');
  if (!tableExists) return;
  await knex.schema.alterTable('route_optimization_api_spend', (t) => {
    t.dropColumn('single_vehicle_calls');
    t.dropColumn('single_vehicle_shipments');
    t.dropColumn('fleet_routing_calls');
    t.dropColumn('fleet_routing_shipments');
    t.dropColumn('validate_only_calls');
  });
};
