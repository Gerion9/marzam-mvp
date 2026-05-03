require('dotenv').config();
const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  searchPath: ['marzam_app', 'public'],
});

(async () => {
  try {
    const total = await knex.raw(`
      SELECT
        COUNT(*) FILTER (WHERE clave_mostrador IS NOT NULL) AS with_clave,
        COUNT(DISTINCT clave_mostrador) FILTER (WHERE clave_mostrador IS NOT NULL) AS distinct_clave
      FROM pharmacies
    `);
    console.log('--- pharmacies clave_mostrador stats ---');
    console.table(total.rows);

    const dups = await knex.raw(`
      SELECT clave_mostrador, COUNT(*) AS n
        FROM pharmacies
       WHERE clave_mostrador IS NOT NULL
       GROUP BY clave_mostrador
       HAVING COUNT(*) > 1
       ORDER BY n DESC
       LIMIT 20
    `);
    console.log('\n--- duplicate clave_mostrador values in pharmacies (would block UNIQUE) ---');
    console.table(dups.rows);
    if (dups.rows.length === 0) {
      console.log('  (none — safe to add UNIQUE index on clave_mostrador WHERE NOT NULL)');
    }

    // What sources currently own rows with clave_mostrador?
    const bySource = await knex.raw(`
      SELECT source, COUNT(*) FILTER (WHERE clave_mostrador IS NOT NULL) AS with_clave
        FROM pharmacies
       GROUP BY source
    `);
    console.log('\n--- pharmacies with clave_mostrador, by source ---');
    console.table(bySource.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
  }
})();
