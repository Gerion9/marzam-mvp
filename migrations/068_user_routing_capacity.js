/**
 * users — extiende capacidades de routing para el modelo de auto propio.
 *
 *   travel_minutes_cap     — máximo minutos de manejo por jornada (default 360 = 6h).
 *                            Distinto de daily_minutes_cap (jornada total, default 480).
 *                            Una jornada con 7h de manejo y 1h de servicio infringiría éste
 *                            aunque cumpliera el daily_minutes_cap.
 *   daily_km_cap           — tope diario de kilómetros (default 200). Protege contra rutas
 *                            largas en zonas dispersas que serían operativamente caras.
 *   preferred_travel_mode  — 'DRIVE' por default. Reservado para mix futuro DRIVE/WALK/etc.
 *
 * Validados en planGenerator.tryFit cuando el flag PLAN_USE_COST_COEFFS está activo.
 */

exports.up = async function up(knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('users', 'travel_minutes_cap'),
    knex.schema.hasColumn('users', 'daily_km_cap'),
    knex.schema.hasColumn('users', 'preferred_travel_mode'),
  ]);
  const [hasTravel, hasKm, hasMode] = cols;
  if (!hasTravel || !hasKm || !hasMode) {
    await knex.schema.alterTable('users', (t) => {
      if (!hasTravel) t.integer('travel_minutes_cap').notNullable().defaultTo(360);
      if (!hasKm) t.integer('daily_km_cap').notNullable().defaultTo(200);
      if (!hasMode) t.text('preferred_travel_mode').notNullable().defaultTo('DRIVE');
    });
  }
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_travel_mode_check'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_travel_mode_check
          CHECK (preferred_travel_mode IN ('DRIVE','TWO_WHEELER','WALK','BICYCLE'));
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_travel_mode_check;');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('travel_minutes_cap');
    t.dropColumn('daily_km_cap');
    t.dropColumn('preferred_travel_mode');
  });
};
