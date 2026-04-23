exports.up = async function (knex) {
  await knex.schema.createTable('colonias', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));

    t.integer('objectid').unique();
    t.string('postalcode', 10);
    t.string('state_name', 255);
    t.string('municipality_name', 255);
    t.string('settlement_name', 500).notNullable();
    t.string('settlement_type', 100);

    t.enum('security_level', ['acceptable', 'caution', 'not_acceptable']).defaultTo('acceptable');

    t.decimal('area_m2', 18, 2);
    t.decimal('shape_length', 18, 9);
    t.decimal('shape_area', 18, 12);

    t.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE colonias
      ADD COLUMN geom geometry(Polygon, 4326);
  `);
  await knex.raw(`
    CREATE INDEX idx_colonias_geom ON colonias USING GIST (geom);
  `);
  await knex.raw(`
    CREATE INDEX idx_colonias_municipality ON colonias (municipality_name);
  `);
  await knex.raw(`
    CREATE INDEX idx_colonias_security ON colonias (security_level);
  `);
  await knex.raw(`
    CREATE INDEX idx_colonias_settlement ON colonias (settlement_name);
  `);

  await knex.schema.alterTable('pharmacies', (t) => {
    t.uuid('colonia_id').references('id').inTable('colonias').onDelete('SET NULL');
  });
  await knex.raw(`
    CREATE INDEX idx_pharmacies_colonia ON pharmacies (colonia_id);
  `);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('colonia_id');
  });
  await knex.schema.dropTableIfExists('colonias');
};
