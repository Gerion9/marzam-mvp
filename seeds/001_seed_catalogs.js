const bcrypt = require('bcryptjs');

exports.seed = async function (knex) {
  // Idempotent: skip if manager already exists
  const existing = await knex('users').where({ email: 'admin@marzam.mx' }).first();
  if (existing) return;

  const hash = await bcrypt.hash('Marzam2026!', 10);

  await knex('users').insert({
    email: 'admin@marzam.mx',
    password_hash: hash,
    full_name: 'Administrador Marzam',
    role: 'manager',
  });
};
