exports.up = async function (knex) {
  await knex.schema.createTable('pharmacies', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));

    // --- Base POI data (BlackPrint snapshot) ---
    t.string('name', 500).notNullable();
    t.text('address');
    // coordinates stored as geography(Point,4326) via raw PostGIS
    t.string('category', 255);
    t.string('subcategory', 255);
    t.string('municipality', 255);
    t.string('state', 255);

    // Contact
    t.string('contact_phone', 100);
    t.string('contact_person', 255);
    t.text('social_links');

    // Hours
    t.string('opening_hours', 255);
    t.string('closing_hours', 255);
    t.date('date_of_opening');

    // Scores
    t.integer('num_reviews');
    t.decimal('popularity_score', 3, 2); // 1.00–5.00
    t.decimal('data_confidence_score', 3, 2);

    // --- Operational fields ---
    t.boolean('is_independent').defaultTo(true);
    t.enum('status', [
      'active', 'pending_review', 'closed', 'invalid', 'duplicate', 'moved',
    ]).defaultTo('active');
    t.enum('verification_status', ['unverified', 'verified', 'flagged']).defaultTo('unverified');

    // Field-enriched
    t.string('last_visit_outcome', 50);
    t.timestamp('last_visited_at');
    t.uuid('assigned_rep_id').references('id').inTable('users').onDelete('SET NULL');
    t.decimal('order_potential', 12, 2);
    t.text('notes');

    t.enum('source', ['blackprint', 'field_rep', 'marzam']).defaultTo('blackprint');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Add geography column and spatial index
  await knex.raw(`
    ALTER TABLE pharmacies
      ADD COLUMN coordinates geography(Point, 4326);
  `);
  await knex.raw(`
    CREATE INDEX idx_pharmacies_coordinates
      ON pharmacies USING GIST (coordinates);
  `);
  await knex.raw(`
    CREATE INDEX idx_pharmacies_geom
      ON pharmacies USING GIST ((coordinates::geometry));
  `);
  await knex.raw(`
    CREATE INDEX idx_pharmacies_municipality
      ON pharmacies (municipality);
  `);
  await knex.raw(`
    CREATE INDEX idx_pharmacies_status
      ON pharmacies (status);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('pharmacies');
};
