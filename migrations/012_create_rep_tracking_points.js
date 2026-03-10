exports.up = async function (knex) {
  await knex.schema.createTable('rep_tracking_points', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('rep_name_snapshot', 255).notNullable();
    t.uuid('verification_id').references('id').inTable('pharmacy_verifications').onDelete('SET NULL');
    t.uuid('assignment_id').references('id').inTable('territory_assignments').onDelete('SET NULL');
    t.decimal('lat', 10, 7).notNullable();
    t.decimal('lng', 10, 7).notNullable();
    t.decimal('accuracy_meters', 8, 2);
    t.timestamp('recorded_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE rep_tracking_points
      ADD COLUMN point geography(Point, 4326);
  `);
  await knex.raw(`
    CREATE INDEX idx_rep_tracking_rep_time
      ON rep_tracking_points (rep_id, recorded_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_rep_tracking_assignment
      ON rep_tracking_points (assignment_id, recorded_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_rep_tracking_point
      ON rep_tracking_points USING GIST (point);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('rep_tracking_points');
};
