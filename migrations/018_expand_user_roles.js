exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('manager', 'field_rep', 'national_admin', 'regional_manager', 'area_coordinator'));
  `);

  await knex('users').where({ role: 'manager' }).update({ role: 'national_admin' });
};

exports.down = async function (knex) {
  await knex('users').where({ role: 'national_admin' }).update({ role: 'manager' });
  await knex('users').where({ role: 'regional_manager' }).update({ role: 'manager' });
  await knex('users').where({ role: 'area_coordinator' }).update({ role: 'manager' });

  await knex.raw(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('manager', 'field_rep'));
  `);
};
