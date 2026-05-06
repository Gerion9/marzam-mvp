/**
 * Track WHERE a user's home_lat/home_lng came from.
 *
 *   geocoder       — proactive Google Geocoding API on import / address change
 *   gps_bootstrap  — degraded fallback: first accurate GPS ping (≤200m) when
 *                    the geocoder failed or has not run yet
 *   manual         — set by an admin via the user edit UI
 *
 * Used by:
 *   - tracking.service.recordPing — only overwrites home from GPS when
 *     home_geocode_source IS NULL OR 'gps_bootstrap', never overrides a
 *     geocoder/manual home
 *   - admin dashboards — show provenance so ops can audit where reps live
 */

exports.up = async function up(knex) {
  const hasAt = await knex.schema.hasColumn('users', 'home_geocoded_at');
  const hasSrc = await knex.schema.hasColumn('users', 'home_geocode_source');
  if (!hasAt || !hasSrc) {
    await knex.schema.alterTable('users', (t) => {
      if (!hasAt) t.timestamp('home_geocoded_at').nullable();
      if (!hasSrc) t.text('home_geocode_source').nullable();
    });
  }
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_home_geocode_source_check'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_home_geocode_source_check
          CHECK (home_geocode_source IS NULL OR home_geocode_source IN ('geocoder','gps_bootstrap','manual'));
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_home_geocode_source_check;');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('home_geocoded_at');
    t.dropColumn('home_geocode_source');
  });
};
