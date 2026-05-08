/**
 * Geocoder cache — used by src/services/geocoder.js when converting
 * employee_profiles.domicilio_particular into users.home_lat/home_lng.
 *
 * Keyed by a normalized address string so repeated lookups for the same
 * address (different employees same household, manual edits, sync re-runs)
 * are free.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('geocode_cache');
  if (has) return;
  await knex.schema.createTable('geocode_cache', (t) => {
    t.text('normalized_address').primary();
    t.double('lat').notNullable();
    t.double('lng').notNullable();
    t.text('source').notNullable().defaultTo('google');
    t.text('formatted_address');
    t.timestamp('fetched_at').defaultTo(knex.fn.now());
    t.integer('hits').notNullable().defaultTo(0);
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_geocode_cache_fetched_at ON geocode_cache (fetched_at);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('geocode_cache');
};
