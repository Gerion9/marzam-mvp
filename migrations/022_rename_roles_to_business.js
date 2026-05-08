/**
 * Rename roles to Marzam business nomenclature.
 *
 *   national_admin    → director_sucursal
 *   regional_manager  → gerente_ventas
 *   area_coordinator  → supervisor
 *   field_rep         → representante
 *
 * Backfill rows first, THEN swap the CHECK constraint, so we never violate it
 * mid-transaction.
 */

const RENAMES = [
  ['national_admin', 'director_sucursal'],
  ['regional_manager', 'gerente_ventas'],
  ['area_coordinator', 'supervisor'],
  ['field_rep', 'representante'],
  // Legacy 'manager' rows (pre-018) are also normalized to director_sucursal.
  ['manager', 'director_sucursal'],
];

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');

  for (const [oldRole, newRole] of RENAMES) {
    await knex('users').where({ role: oldRole }).update({ role: newRole });
  }

  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('director_sucursal', 'gerente_ventas', 'supervisor', 'representante'));
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');

  for (const [oldRole, newRole] of RENAMES) {
    if (oldRole === 'manager') continue;
    await knex('users').where({ role: newRole }).update({ role: oldRole });
  }

  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('manager', 'field_rep', 'national_admin', 'regional_manager', 'area_coordinator'));
  `);
};
