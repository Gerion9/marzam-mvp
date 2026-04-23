exports.up = async function (knex) {
  await knex.schema.alterTable('colonias', (t) => {
    t.uuid('territory_id').references('id').inTable('territories').onDelete('SET NULL');
  });
  await knex.raw(`CREATE INDEX idx_colonias_territory ON colonias (territory_id);`);

  await knex.schema.alterTable('pharmacies', (t) => {
    t.uuid('territory_id').references('id').inTable('territories').onDelete('SET NULL');
  });
  await knex.raw(`CREATE INDEX idx_pharmacies_territory ON pharmacies (territory_id);`);

  await knex.schema.alterTable('territory_assignments', (t) => {
    t.uuid('territory_id').references('id').inTable('territories').onDelete('SET NULL');
  });
  await knex.raw(`CREATE INDEX idx_assignments_territory ON territory_assignments (territory_id);`);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('territory_assignments', (t) => {
    t.dropColumn('territory_id');
  });
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('territory_id');
  });
  await knex.schema.alterTable('colonias', (t) => {
    t.dropColumn('territory_id');
  });
};
