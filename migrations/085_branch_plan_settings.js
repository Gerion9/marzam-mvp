/**
 * branches.plan_settings — per-branch configuration for the plan engine.
 *
 * Single JSONB column instead of a 1:1 table because:
 *   - settings are read on every plan generate (hot path) — saves a JOIN.
 *   - adding new keys (e.g. break_start_hhmm) won't need a migration.
 *   - validation lives at the service layer (branchPlanSettings.get with zod).
 *
 * Default reflects Marzam ops:
 *   - cutoff_hhmm '08:30'   — plans created before this hour can overwrite today.
 *   - working_days [0..5]   — Domingo..Viernes (JS getDay convention). Sábado=6 is
 *                              ALWAYS inhábil and is excluded by default.
 *   - timezone 'America/Mexico_City' — single TZ today, kept per-branch for future
 *                                       expansion (e.g. Sonora UTC-7).
 *   - expected_route_start/end — used as defaults when a plan does not specify
 *                                  its own route window.
 */

exports.up = async function up(knex) {
  const hasCol = await knex.schema.hasColumn('branches', 'plan_settings');
  if (hasCol) return;

  await knex.schema.alterTable('branches', (t) => {
    t.jsonb('plan_settings').notNullable().defaultTo(knex.raw(`'{
      "cutoff_hhmm": "08:30",
      "working_days": [0,1,2,3,4,5],
      "timezone": "America/Mexico_City",
      "expected_route_start": "08:00",
      "expected_route_end": "17:00"
    }'::jsonb`));
  });

  // Backfill existing rows (DEFAULT only applies to new INSERTs).
  await knex.raw(`
    UPDATE branches
       SET plan_settings = '{
         "cutoff_hhmm": "08:30",
         "working_days": [0,1,2,3,4,5],
         "timezone": "America/Mexico_City",
         "expected_route_start": "08:00",
         "expected_route_end": "17:00"
       }'::jsonb
     WHERE plan_settings IS NULL
        OR plan_settings = '{}'::jsonb
  `);
};

exports.down = async function down(knex) {
  const hasCol = await knex.schema.hasColumn('branches', 'plan_settings');
  if (!hasCol) return;
  await knex.schema.alterTable('branches', (t) => {
    t.dropColumn('plan_settings');
  });
};
