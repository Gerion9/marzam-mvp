require('dotenv').config();
const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.OTHER_USER_BQ,
    password: process.env.OTHER_PASSWORD_BQ,
  },
});

(async () => {
  try {
    const farm = await knex.raw(`
      SELECT record_type, COUNT(*) AS n
        FROM staging.stg_marzam_master_scored_farmacias
       GROUP BY record_type
       ORDER BY n DESC
    `);
    const cons = await knex.raw(`
      SELECT record_type, COUNT(*) AS n
        FROM staging.stg_marzam_master_scored_consultorios
       GROUP BY record_type
       ORDER BY n DESC
    `);
    console.log('--- master_scored_farmacias.record_type ---');
    console.table(farm.rows);
    console.log('--- master_scored_consultorios.record_type ---');
    console.table(cons.rows);

    // Sample one CLIENT and one PROSPECT row to see actual column values.
    const clientRows = await knex.raw(`
      SELECT record_type, dataplor_id, name, mostradores, tier_clean, pareto, latitude, longitude
        FROM staging.stg_marzam_master_scored_farmacias
       WHERE record_type = 'CLIENT'
       LIMIT 2
    `);
    console.log('--- sample CLIENT rows from farmacias ---');
    console.table(clientRows.rows);

    // Verify how the row keys come back (case, whitespace, etc.)
    if (clientRows.rows.length) {
      console.log('\n--- raw key inspection on first CLIENT row ---');
      const r = clientRows.rows[0];
      console.log('keys:', Object.keys(r).slice(0, 30).join(', '));
      console.log('record_type value:', JSON.stringify(r.record_type), 'typeof:', typeof r.record_type);
    }

    // Same on the consultorios side.
    const clientRowsCons = await knex.raw(`
      SELECT record_type, dataplor_id, name, mostradores, tier_clean
        FROM staging.stg_marzam_master_scored_consultorios
       WHERE record_type = 'CLIENT'
       LIMIT 1
    `);
    console.log('\n--- sample CLIENT row from consultorios ---');
    console.table(clientRowsCons.rows);

    // Dump every column of a single CLIENT row to find where the name lives.
    const fullClient = await knex.raw(`
      SELECT *
        FROM staging.stg_marzam_master_scored_farmacias
       WHERE record_type = 'CLIENT'
       LIMIT 1
    `);
    if (fullClient.rows.length) {
      console.log('\n--- ALL columns of a single CLIENT row (non-null only) ---');
      const r = fullClient.rows[0];
      const populated = {};
      for (const [k, v] of Object.entries(r)) {
        if (v !== null && v !== undefined && v !== '') populated[k] = v;
      }
      console.log(JSON.stringify(populated, null, 2));
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
  }
})();
