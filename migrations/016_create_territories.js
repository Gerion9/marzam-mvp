exports.up = async function (knex) {
  await knex.schema.createTable('territories', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('parent_id').references('id').inTable('territories').onDelete('SET NULL');
    t.enum('level', ['national', 'regional', 'municipal', 'zone']).notNullable();
    t.string('name', 255).notNullable();
    t.string('code', 64).unique();
    t.jsonb('metadata').defaultTo('{}');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE territories
      ADD COLUMN geom geometry(MultiPolygon, 4326);
  `);
  await knex.raw(`CREATE INDEX idx_territories_geom ON territories USING GIST (geom);`);
  await knex.raw(`CREATE INDEX idx_territories_parent ON territories (parent_id);`);
  await knex.raw(`CREATE INDEX idx_territories_level ON territories (level);`);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('territories');
};
