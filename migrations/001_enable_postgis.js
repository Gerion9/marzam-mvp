exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
};

exports.down = async function (knex) {
  await knex.raw('DROP EXTENSION IF EXISTS postgis CASCADE');
  await knex.raw('DROP EXTENSION IF EXISTS "uuid-ossp"');
};
