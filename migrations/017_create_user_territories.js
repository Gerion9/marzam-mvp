exports.up = async function (knex) {
  await knex.schema.createTable('user_territories', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('territory_id').notNullable().references('id').inTable('territories').onDelete('CASCADE');
    t.string('role_in_territory', 64);
    t.timestamp('valid_from').notNullable().defaultTo(knex.fn.now());
    t.timestamp('valid_to');
    t.uuid('assigned_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE UNIQUE INDEX idx_user_territories_active_unique
      ON user_territories (user_id, territory_id)
      WHERE valid_to IS NULL;
  `);
  await knex.raw(`CREATE INDEX idx_user_territories_user ON user_territories (user_id);`);
  await knex.raw(`CREATE INDEX idx_user_territories_territory ON user_territories (territory_id);`);
  await knex.raw(`CREATE INDEX idx_user_territories_active ON user_territories (valid_to) WHERE valid_to IS NULL;`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('user_territories');
};
