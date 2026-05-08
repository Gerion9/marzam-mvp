/**
 * Routing foundations — Marzam Execution Doc §10 (route optimization).
 *
 * Adds the columns and tables that unlock real driving-time route generation.
 * Until this migration the planGenerator was running round-robin without any
 * geographic awareness: no rep depot, no driving matrix, no caution polygon
 * penalty. After 057:
 *
 *   users
 *     home_lat/home_lng           — rep depot (where the workday starts/ends)
 *     home_geohash7               — populated by app on insert/update for cache key
 *     daily_minutes_cap           — workday budget in minutes (default 480 = 8h)
 *     service_minutes_per_stop    — stop service time incl. parking (default 45)
 *
 *   route_matrix_cache (NEW)
 *     Asymmetric driving-time cache for Routes API responses, keyed by
 *     (origin_geohash7, dest_geohash7, hour_bucket, day_type, routing_preference).
 *     TTL 7 days; nightly purge at 23 days satisfies Google ToS 30-day limit on
 *     derived lat/lng data.
 *
 *   visit_plan_assignments
 *     expected_arrival_time       — ETA at the stop (start of service)
 *     expected_travel_minutes     — drive time from previous stop
 *     expected_service_minutes    — service + parking minutes for this stop
 *     polyline_to_next            — encoded polyline used to draw the trail and
 *                                   to test ST_Intersects against caution polygons
 *
 *   visit_plans
 *     metrics                     — JSONB snapshot of plan-level totals for
 *                                   post-mortem dashboards (drive_minutes,
 *                                   service_minutes, variance_minutes,
 *                                   caution_arcs, unassigned_count)
 *
 * Why a regular geohash7 column instead of GENERATED ALWAYS AS:
 *   PostgreSQL has no native geohash function; pulling in pg_geohash is overkill.
 *   The app writes the column on user upsert (cheap, ~10 reps per branch).
 */

exports.up = async function up(knex) {
  // ─── users: depot + capacity ────────────────────────────────────────────
  await knex.schema.alterTable('users', (t) => {
    t.double('home_lat');
    t.double('home_lng');
    t.specificType('home_geohash7', 'char(7)');
    t.integer('daily_minutes_cap').notNullable().defaultTo(480);
    t.integer('service_minutes_per_stop').notNullable().defaultTo(45);
  });
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_home_geohash7
      ON users (home_geohash7)
      WHERE home_geohash7 IS NOT NULL;
  `);

  // ─── route_matrix_cache ─────────────────────────────────────────────────
  await knex.schema.createTable('route_matrix_cache', (t) => {
    t.specificType('origin_geohash7', 'char(7)').notNullable();
    t.specificType('dest_geohash7', 'char(7)').notNullable();
    // hour_bucket: 0=valle (10-13h, 21-7h), 1=pico-am (8-10h), 2=pico-pm (17-20h),
    // 3=mid-pm (13-17h). Only 0 is used by TRAFFIC_UNAWARE; the others are reserved
    // for TRAFFIC_AWARE day-of sequencing.
    t.smallint('hour_bucket').notNullable();
    t.smallint('day_type').notNullable(); // 0=weekday, 1=saturday
    t.text('routing_preference').notNullable(); // TRAFFIC_AWARE | TRAFFIC_UNAWARE
    t.integer('duration_seconds').notNullable();
    t.integer('distance_meters').notNullable();
    // Encoded polyline of the route segment, used to test caution-polygon
    // intersection in planGenerator. May be NULL when Routes API returned only
    // the matrix without geometry (e.g. cheap fallback).
    t.text('polyline');
    t.timestamp('computed_at').defaultTo(knex.fn.now());
    t.timestamp('expires_at').notNullable();
    t.primary(['origin_geohash7', 'dest_geohash7', 'hour_bucket', 'day_type', 'routing_preference']);
  });
  await knex.raw(`
    ALTER TABLE route_matrix_cache
      ADD CONSTRAINT route_matrix_cache_routing_preference_check
      CHECK (routing_preference IN ('TRAFFIC_AWARE', 'TRAFFIC_UNAWARE'));
  `);
  await knex.raw(`
    CREATE INDEX idx_rmc_expires
      ON route_matrix_cache (expires_at);
  `);

  // ─── visit_plan_assignments: ETAs + trail polyline ──────────────────────
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.timestamp('expected_arrival_time');
    t.smallint('expected_travel_minutes');
    t.smallint('expected_service_minutes');
    t.text('polyline_to_next');
  });

  // ─── visit_plans: post-mortem metrics ───────────────────────────────────
  await knex.schema.alterTable('visit_plans', (t) => {
    t.jsonb('metrics');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visit_plans', (t) => {
    t.dropColumn('metrics');
  });
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.dropColumn('polyline_to_next');
    t.dropColumn('expected_service_minutes');
    t.dropColumn('expected_travel_minutes');
    t.dropColumn('expected_arrival_time');
  });
  await knex.raw('DROP INDEX IF EXISTS idx_rmc_expires;');
  await knex.schema.dropTableIfExists('route_matrix_cache');
  await knex.raw('DROP INDEX IF EXISTS idx_users_home_geohash7;');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('service_minutes_per_stop');
    t.dropColumn('daily_minutes_cap');
    t.dropColumn('home_geohash7');
    t.dropColumn('home_lng');
    t.dropColumn('home_lat');
  });
};
