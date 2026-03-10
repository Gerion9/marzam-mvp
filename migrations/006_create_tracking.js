exports.up = async function (knex) {
  // GPS pings emitted while rep has an active route session
  await knex.schema.createTable('gps_pings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('assignment_id').references('id').inTable('territory_assignments').onDelete('SET NULL');
    t.decimal('lat', 10, 7).notNullable();
    t.decimal('lng', 10, 7).notNullable();
    t.decimal('accuracy_meters', 8, 2);
    t.timestamp('recorded_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE gps_pings
      ADD COLUMN point geography(Point, 4326);
  `);
  await knex.raw(`
    CREATE INDEX idx_pings_rep_time
      ON gps_pings (rep_id, recorded_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_pings_point
      ON gps_pings USING GIST (point);
  `);

  // Check-ins tied to a pharmacy stop
  await knex.schema.createTable('checkins', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.uuid('assignment_stop_id').references('id').inTable('assignment_stops').onDelete('SET NULL');
    t.decimal('lat', 10, 7).notNullable();
    t.decimal('lng', 10, 7).notNullable();
    t.decimal('distance_to_pharmacy_m', 10, 2);
    t.timestamp('checked_in_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_checkins_rep ON checkins (rep_id, checked_in_at DESC);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('checkins');
  await knex.schema.dropTableIfExists('gps_pings');
};
