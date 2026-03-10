exports.up = async function (knex) {
  await knex.schema.createTable('territory_assignments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));

    // polygon stored as geometry(Polygon,4326) via raw PostGIS
    t.uuid('rep_id').references('id').inTable('users').onDelete('SET NULL');

    t.string('campaign_objective', 255).notNullable();
    t.enum('priority', ['low', 'normal', 'high', 'urgent']).defaultTo('normal');
    t.date('due_date');
    t.integer('visit_goal').defaultTo(0);

    t.enum('status', ['unassigned', 'assigned', 'in_progress', 'completed'])
      .notNullable()
      .defaultTo('unassigned');

    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE territory_assignments
      ADD COLUMN polygon geometry(Polygon, 4326);
  `);
  await knex.raw(`
    CREATE INDEX idx_assignments_polygon
      ON territory_assignments USING GIST (polygon);
  `);
  await knex.raw(`
    CREATE INDEX idx_assignments_rep_status
      ON territory_assignments (rep_id, status);
  `);

  // Assignment stops (pharmacy-level route order inside an assignment)
  await knex.schema.createTable('assignment_stops', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('assignment_id').notNullable()
      .references('id').inTable('territory_assignments').onDelete('CASCADE');
    t.uuid('pharmacy_id').notNullable()
      .references('id').inTable('pharmacies').onDelete('CASCADE');
    t.integer('route_order').notNullable();
    t.enum('stop_status', ['pending', 'skipped', 'completed']).defaultTo('pending');
    t.timestamp('completed_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_stops_assignment
      ON assignment_stops (assignment_id, route_order);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('assignment_stops');
  await knex.schema.dropTableIfExists('territory_assignments');
};
