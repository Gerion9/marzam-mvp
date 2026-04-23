exports.up = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('phone', 64);
    t.boolean('must_change_password').notNullable().defaultTo(false);
    t.timestamp('last_login_at');
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('phone');
    t.dropColumn('must_change_password');
    t.dropColumn('last_login_at');
    t.dropColumn('created_by');
  });
};
