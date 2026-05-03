/**
 * branches — Marzam "GERENCIA" / Sucursal entity.
 *
 * Each branch has a director (director_sucursal) and is optionally linked to a
 * top-level territory (region) used for scoping.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('branches', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('name', 255).notNullable();
    t.string('code', 64).notNullable().unique();
    t.uuid('director_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('region_territory_id').references('id').inTable('territories').onDelete('SET NULL');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX idx_branches_director ON branches (director_user_id);');
  await knex.raw('CREATE INDEX idx_branches_region ON branches (region_territory_id);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('branches');
};
