/**
 * Add `admin` role to the users.role CHECK constraint.
 *
 * Per Marzam Execution Doc §3, admin is the top-of-hierarchy role — only role
 * allowed to edit A/B/C client classification, edit sales targets, create or
 * delete users, and manage global configuration. BlackPrint + 1–3 Marzam
 * admins will hold this role; everyone else is director_sucursal or below.
 *
 * No data backfill — admin users are seeded explicitly post-migration.
 */

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'director_sucursal', 'gerente_ventas', 'supervisor', 'representante'));
  `);
};

exports.down = async function down(knex) {
  // Demote any admins to director_sucursal before tightening the constraint.
  await knex('users').where({ role: 'admin' }).update({ role: 'director_sucursal' });
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('director_sucursal', 'gerente_ventas', 'supervisor', 'representante'));
  `);
};
