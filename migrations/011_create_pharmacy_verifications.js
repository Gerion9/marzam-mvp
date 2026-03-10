exports.up = async function (knex) {
  await knex.schema.createTable('pharmacy_verifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('assignment_id').references('id').inTable('territory_assignments').onDelete('SET NULL');
    t.uuid('assignment_stop_id').references('id').inTable('assignment_stops').onDelete('SET NULL');

    t.string('wave_id', 255);
    t.integer('route_order');
    t.enum('assignment_status', ['assigned', 'in_progress', 'completed', 'reassigned', 'cancelled'])
      .notNullable()
      .defaultTo('assigned');
    t.enum('visit_status', [
      'pending',
      'visited',
      'contact_made',
      'interested',
      'not_interested',
      'follow_up_required',
      'closed',
      'invalid',
      'duplicate',
      'moved',
      'wrong_category',
      'chain_not_independent',
      'not_found',
    ])
      .notNullable()
      .defaultTo('pending');
    t.enum('regularization_status', ['pending', 'verified', 'requires_follow_up', 'rejected'])
      .notNullable()
      .defaultTo('pending');
    t.enum('priority', ['low', 'normal', 'high', 'urgent']).notNullable().defaultTo('normal');
    t.string('municipality_snapshot', 255);
    t.string('state_snapshot', 255);

    t.timestamp('assigned_at').defaultTo(knex.fn.now());
    t.date('due_at');
    t.timestamp('started_at');
    t.timestamp('visited_at');

    t.decimal('checkin_lat', 10, 7);
    t.decimal('checkin_lng', 10, 7);
    t.decimal('distance_to_pharmacy_m', 10, 2);

    t.string('photo_url', 1000);
    t.string('gcs_bucket', 255);
    t.string('gcs_object_path', 1000);
    t.string('photo_mime_type', 120);
    t.integer('photo_size_bytes');
    t.timestamp('photo_uploaded_at');

    t.text('comment');
    t.string('contact_name', 255);
    t.string('contact_phone', 100);
    t.string('latest_outcome', 50);
    t.decimal('order_potential', 12, 2);

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_verifications_assignment_stop
      ON pharmacy_verifications (assignment_stop_id)
      WHERE assignment_stop_id IS NOT NULL;
  `);
  await knex.raw(`
    CREATE INDEX idx_verifications_pharmacy
      ON pharmacy_verifications (pharmacy_id, visited_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_verifications_rep
      ON pharmacy_verifications (rep_id, assignment_status, visited_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_verifications_assignment
      ON pharmacy_verifications (assignment_id, route_order);
  `);
  await knex.raw(`
    CREATE INDEX idx_verifications_wave
      ON pharmacy_verifications (wave_id);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('pharmacy_verifications');
};
