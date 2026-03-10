const bcrypt = require('bcryptjs');

exports.seed = async function (knex) {
  const existing = await knex('users').where({ email: 'carlos@marzam.mx' }).first();
  if (existing) return;

  const hash = await bcrypt.hash('Rep2026!', 10);

  await knex('users').insert([
    { email: 'carlos@marzam.mx', password_hash: hash, full_name: 'Carlos Lopez', role: 'field_rep' },
    { email: 'ana@marzam.mx', password_hash: hash, full_name: 'Ana Martinez', role: 'field_rep' },
    { email: 'miguel@marzam.mx', password_hash: hash, full_name: 'Miguel Torres', role: 'field_rep' },
  ]);
};
