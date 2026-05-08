require('dotenv').config();

const knexBq = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.OTHER_USER_BQ,
    password: process.env.OTHER_PASSWORD_BQ,
  },
});

const knexApp = require('knex')({
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
    // Conteo total de la otra tabla
    const total = await knexBq.raw(`
      SELECT COUNT(*)::int AS n FROM staging.stg_marzam_prospect_scored
    `);
    console.log('staging.stg_marzam_prospect_scored total:', total.rows[0].n);

    // Columnas
    const cols = await knexBq.raw(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_schema='staging' AND table_name='stg_marzam_prospect_scored'
       ORDER BY ordinal_position
    `);
    console.log('\n--- columnas ---');
    console.table(cols.rows);

    // Muestra
    const sample = await knexBq.raw(`
      SELECT * FROM staging.stg_marzam_prospect_scored LIMIT 3
    `);
    console.log('\n--- 3 filas de muestra ---');
    sample.rows.forEach((r, i) => {
      console.log(`Fila ${i + 1}:`);
      Object.entries(r).forEach(([k, v]) => {
        if (v !== null && v !== '') console.log(`  ${k}: ${v}`);
      });
    });

    // Cruzar contra los 1285 dataplor_ids huerfanos
    const orphans = await knexApp.raw(`
      SELECT dataplor_id FROM pharmacies
       WHERE business_type IS NULL AND dataplor_id IS NOT NULL
    `);
    const orphanIds = orphans.rows.map((r) => r.dataplor_id);

    const psIds = await knexBq.raw(`
      SELECT DISTINCT dataplor_id FROM staging.stg_marzam_prospect_scored
       WHERE dataplor_id IS NOT NULL
    `);
    const psSet = new Set(psIds.rows.map((r) => r.dataplor_id));

    const matched = orphanIds.filter((id) => psSet.has(id));
    console.log(`\nHuerfanas que coinciden con stg_marzam_prospect_scored: ${matched.length}/${orphanIds.length}`);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knexBq.destroy();
    await knexApp.destroy();
  }
})();
