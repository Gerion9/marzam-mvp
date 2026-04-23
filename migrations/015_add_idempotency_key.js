exports.up = async function (knex) {
  await knex.schema.alterTable('visit_reports', (t) => {
    t.string('idempotency_key', 64).nullable().unique();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('visit_reports', (t) => {
    t.dropColumn('idempotency_key');
  });
};
