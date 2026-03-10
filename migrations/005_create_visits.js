exports.up = async function (knex) {
  await knex.schema.createTable('visit_reports', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('assignment_stop_id').references('id').inTable('assignment_stops').onDelete('SET NULL');
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');

    t.string('outcome', 50).notNullable();
    t.text('notes');
    t.decimal('order_potential', 12, 2);

    // Contact captured during visit
    t.string('contact_person', 255);
    t.string('contact_phone', 100);

    // Observations
    t.text('competitor_products');
    t.text('stock_observations');

    // Follow-up
    t.date('follow_up_date');
    t.text('follow_up_reason');

    // Flag reason (for outcomes that trigger review queue)
    t.text('flag_reason');

    // GPS at check-in
    t.decimal('checkin_lat', 10, 7);
    t.decimal('checkin_lng', 10, 7);

    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_visits_pharmacy ON visit_reports (pharmacy_id);
  `);
  await knex.raw(`
    CREATE INDEX idx_visits_rep_date ON visit_reports (rep_id, created_at DESC);
  `);

  // Visit photos
  await knex.schema.createTable('visit_photos', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('visit_id').notNullable().references('id').inTable('visit_reports').onDelete('CASCADE');
    t.string('file_path', 1000).notNullable();
    t.string('original_name', 500);
    t.string('mime_type', 100);
    t.integer('size_bytes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('visit_photos');
  await knex.schema.dropTableIfExists('visit_reports');
};
