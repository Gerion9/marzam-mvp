#!/usr/bin/env node
/**
 * Bootstrap users from the virtual access directory (.env config) into the real users table.
 *
 * Useful for migrating from AUTH_DIRECTORY_PROVIDER=virtual to a database-backed directory.
 *
 * Idempotent: skips users already present (by email).
 */

const bcrypt = require('bcryptjs');
const db = require('../src/config/database');
const accessDirectory = require('../src/services/accessDirectory');

const SALT_ROUNDS = 10;

async function upsertUser(virtualUser, ecatepecTerritoryId) {
  const existing = await db('users').where({ email: virtualUser.email }).first();
  if (existing) {
    console.log(`  = ${virtualUser.email} — already exists`);
    return existing;
  }

  const password_hash = await bcrypt.hash(virtualUser.password, SALT_ROUNDS);
  const role = virtualUser.role === 'manager' ? 'national_admin' : virtualUser.role;
  const [row] = await db('users')
    .insert({
      id: virtualUser.db_user_id,
      email: virtualUser.email,
      full_name: virtualUser.full_name,
      password_hash,
      role,
      is_active: !!virtualUser.is_active,
    })
    .returning('*');
  console.log(`  + ${virtualUser.email} (${role})`);

  if (role === 'field_rep' && ecatepecTerritoryId) {
    await db('user_territories').insert({
      user_id: row.id,
      territory_id: ecatepecTerritoryId,
    });
    console.log(`    ↳ assigned to Ecatepec`);
  }
  return row;
}

async function main() {
  console.log('Bootstrapping users from virtual directory...\n');

  const ecatepec = await db('territories').where({ code: 'MX-EMX-ECA' }).first();
  if (!ecatepec) {
    console.warn('  ! Ecatepec territory not found — run npm run seed:territories first.');
  }
  const ecatepecId = ecatepec?.id || null;

  const virtualUsers = accessDirectory.listUsers();
  for (const user of virtualUsers) {
    // eslint-disable-next-line no-await-in-loop
    await upsertUser(user, ecatepecId);
  }

  console.log(`\nDone. Bootstrapped ${virtualUsers.length} users.`);
  await db.destroy();
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exitCode = 1;
  db.destroy();
});
