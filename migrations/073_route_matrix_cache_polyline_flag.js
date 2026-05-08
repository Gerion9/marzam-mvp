/**
 * route_matrix_cache — agrega metadata sobre presencia de polyline.
 *
 * IMPORTANTE: NO toca la PK del cache (origin_geohash7, dest_geohash7, hour_bucket,
 * day_type, routing_preference). El cache existente sigue válido al 100%.
 *
 * has_polyline               — backfilled desde polyline IS NOT NULL.
 *                              planGenerator usa este flag para decidir si necesita
 *                              llamar computeRoute (cache miss de polyline) o si la
 *                              matrix ya trajo polyline inline (mode='persist' con
 *                              ROUTES_INLINE_POLYLINE=true).
 * traffic_departure_bucket   — discretización fina del departureTime cuando
 *                              routing_preference='TRAFFIC_AWARE'. NULL para UNAWARE.
 *                              Permite evitar re-fetch si el departure está dentro
 *                              del mismo bucket aunque no exacto.
 */

exports.up = async function up(knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('route_matrix_cache', 'has_polyline'),
    knex.schema.hasColumn('route_matrix_cache', 'traffic_departure_bucket'),
  ]);
  const [hasFlag, hasBucket] = cols;
  if (!hasFlag || !hasBucket) {
    await knex.schema.alterTable('route_matrix_cache', (t) => {
      if (!hasFlag) t.boolean('has_polyline').notNullable().defaultTo(false);
      if (!hasBucket) t.smallint('traffic_departure_bucket');
    });
  }
  await knex.raw(`
    UPDATE route_matrix_cache SET has_polyline = TRUE
    WHERE polyline IS NOT NULL AND has_polyline = FALSE;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_rmc_has_polyline
      ON route_matrix_cache (has_polyline)
      WHERE has_polyline = TRUE;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_rmc_has_polyline;');
  await knex.schema.alterTable('route_matrix_cache', (t) => {
    t.dropColumn('has_polyline');
    t.dropColumn('traffic_departure_bucket');
  });
};
