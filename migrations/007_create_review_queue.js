exports.up = async function (knex) {
  await knex.schema.createTable('review_queue_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.uuid('visit_id').references('id').inTable('visit_reports').onDelete('SET NULL');

    t.enum('flag_type', [
      'new_pharmacy',
      'duplicate',
      'closed',
      'moved',
      'wrong_category',
      'chain_not_independent',
      'invalid',
    ]).notNullable();

    t.text('reason');
    t.uuid('submitted_by').notNullable().references('id').inTable('users').onDelete('CASCADE');

    t.enum('queue_status', ['pending', 'approved', 'rejected']).defaultTo('pending');
    t.uuid('reviewed_by').references('id').inTable('users').onDelete('SET NULL');
    t.text('review_notes');
    t.timestamp('reviewed_at');

    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_review_queue_status
      ON review_queue_items (queue_status, created_at);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('review_queue_items');
};
