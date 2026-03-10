exports.up = async function (knex) {
  await knex.schema.createTable('audit_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');

    t.string('action', 255).notNullable();
    t.string('entity_type', 100);
    t.uuid('entity_id');

    t.jsonb('before_state');
    t.jsonb('after_state');
    t.string('ip_address', 45);

    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Append-only: no UPDATE or DELETE expected. Index for query by entity.
  await knex.raw(`
    CREATE INDEX idx_audit_entity
      ON audit_events (entity_type, entity_id, created_at DESC);
  `);
  await knex.raw(`
    CREATE INDEX idx_audit_user
      ON audit_events (user_id, created_at DESC);
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('audit_events');
};
