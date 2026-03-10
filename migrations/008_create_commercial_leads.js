exports.up = async function (knex) {
  await knex.schema.createTable('commercial_leads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.uuid('visit_id').references('id').inTable('visit_reports').onDelete('SET NULL');

    t.enum('status', [
      'interested',
      'follow_up_required',
      'contact_captured',
      'converted',
      'lost',
    ]).defaultTo('interested');

    t.decimal('potential_sales', 12, 2);
    t.string('contact_person', 255);
    t.string('contact_phone', 100);
    t.text('notes');

    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_leads_pharmacy ON commercial_leads (pharmacy_id);
  `);
  await knex.raw(`
    CREATE INDEX idx_leads_status ON commercial_leads (status);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('commercial_leads');
};
