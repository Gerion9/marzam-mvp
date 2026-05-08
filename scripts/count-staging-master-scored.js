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
      SELECT
        COUNT(*)                                  AS total,
        COUNT(*) FILTER (WHERE record_type = 'PROSPECT') AS prospects,
        COUNT(*) FILTER (WHERE record_type = 'CLIENT')   AS clients,
        COUNT(*) FILTER (WHERE record_type IS NULL)      AS sin_record_type,
        COUNT(DISTINCT dataplor_id) FILTER (WHERE dataplor_id IS NOT NULL) AS unique_dataplor,
        COUNT(DISTINCT mostradores) FILTER (WHERE mostradores IS NOT NULL) AS unique_mostradores
      FROM staging.stg_marzam_master_scored_farmacias
    `);
    const cons = await knex.raw(`
      SELECT
        COUNT(*)                                  AS total,
        COUNT(*) FILTER (WHERE record_type = 'PROSPECT') AS prospects,
        COUNT(*) FILTER (WHERE record_type = 'CLIENT')   AS clients,
        COUNT(*) FILTER (WHERE record_type IS NULL)      AS sin_record_type,
        COUNT(DISTINCT dataplor_id) FILTER (WHERE dataplor_id IS NOT NULL) AS unique_dataplor,
        COUNT(DISTINCT mostradores) FILTER (WHERE mostradores IS NOT NULL) AS unique_mostradores
      FROM staging.stg_marzam_master_scored_consultorios
    `);

    console.log('--- staging.stg_marzam_master_scored_farmacias ---');
    console.table(farm.rows);

    console.log('\n--- staging.stg_marzam_master_scored_consultorios ---');
    console.table(cons.rows);

    // Cross-table dedup analysis: how many CLIENT mostradores are shared
    // between farmacias and consultorios?  This is the "byte-identical
    // duplicate CLIENT rows" claim from the sync code.
    const overlap = await knex.raw(`
      SELECT COUNT(*) AS shared_clients
        FROM staging.stg_marzam_master_scored_farmacias f
        JOIN staging.stg_marzam_master_scored_consultorios c
          ON f.mostradores = c.mostradores
       WHERE f.record_type = 'CLIENT'
         AND c.record_type = 'CLIENT'
    `);
    console.log('\n--- CLIENT rows shared between both tables (by mostradores) ---');
    console.table(overlap.rows);

    // Por mercado/estado para que tengas más contexto.
    const byState = await knex.raw(`
      SELECT
        COALESCE(mercado, estado, '(sin estado)') AS mercado,
        record_type,
        COUNT(*) AS n
      FROM staging.stg_marzam_master_scored_farmacias
      GROUP BY 1, 2
      ORDER BY mercado, record_type
    `);
    console.log('\n--- farmacias por mercado x record_type ---');
    console.table(byState.rows);

    const byStateCons = await knex.raw(`
      SELECT
        COALESCE(mercado, estado, '(sin estado)') AS mercado,
        record_type,
        COUNT(*) AS n
      FROM staging.stg_marzam_master_scored_consultorios
      GROUP BY 1, 2
      ORDER BY mercado, record_type
    `);
    console.log('\n--- consultorios por mercado x record_type ---');
    console.table(byStateCons.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
  }
})();
