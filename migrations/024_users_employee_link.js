/**
 * Extend users with employee/HR linkage:
 *
 *   employee_code    — RH key (matches Excel padron column "CLAVE")
 *   employee_number  — RH "NO. EMPLEADO"
 *   manager_id       — self-referential chain of command
 *   branch_id        — Marzam GERENCIA / Sucursal
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('employee_code', 64);
    t.string('employee_number', 64);
    t.uuid('manager_id').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('branch_id').references('id').inTable('branches').onDelete('SET NULL');
  });

  await knex.raw('CREATE UNIQUE INDEX idx_users_employee_code ON users (employee_code) WHERE employee_code IS NOT NULL;');
  await knex.raw('CREATE UNIQUE INDEX idx_users_employee_number ON users (employee_number) WHERE employee_number IS NOT NULL;');
  await knex.raw('CREATE INDEX idx_users_manager ON users (manager_id);');
  await knex.raw('CREATE INDEX idx_users_branch ON users (branch_id);');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_users_employee_code;');
  await knex.raw('DROP INDEX IF EXISTS idx_users_employee_number;');
  await knex.raw('DROP INDEX IF EXISTS idx_users_manager;');
  await knex.raw('DROP INDEX IF EXISTS idx_users_branch;');

  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('employee_code');
    t.dropColumn('employee_number');
    t.dropColumn('manager_id');
    t.dropColumn('branch_id');
  });
};
