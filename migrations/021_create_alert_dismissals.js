exports.up = async function (knex) {
  await knex.schema.createTable('alert_dismissals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('alert_key', 255).notNullable();
    t.timestamp('dismissed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at');
  });

  await knex.raw(`CREATE INDEX idx_alert_dismissals_user ON alert_dismissals (user_id);`);
  await knex.raw(`CREATE INDEX idx_alert_dismissals_key ON alert_dismissals (alert_key);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('alert_dismissals');
};
