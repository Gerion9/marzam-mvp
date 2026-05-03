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
    const totals = await knex.raw(`
      SELECT
        COUNT(*)                                                                AS total,
        COUNT(*) FILTER (WHERE source = 'blackprint')                           AS prospects,
        COUNT(*) FILTER (WHERE source = 'marzam')                               AS clients,
        COUNT(*) FILTER (WHERE business_type = 'pharmacy')                      AS pharmacies,
        COUNT(*) FILTER (WHERE business_type = 'consultorio')                   AS consultorios,
        COUNT(*) FILTER (WHERE coordinates IS NOT NULL)                         AS with_coords,
        COUNT(*) FILTER (WHERE final_score IS NOT NULL)                         AS with_score,
        COUNT(*) FILTER (WHERE quadrant_derived IS NOT NULL)                    AS with_quadrant_derived,
        COUNT(*) FILTER (WHERE dataplor_id IS NOT NULL)                         AS with_dataplor_id
      FROM pharmacies
    `);

    const byQuadrant = await knex.raw(`
      SELECT quadrant_derived, COUNT(*) AS n
        FROM pharmacies
       WHERE quadrant_derived IS NOT NULL
       GROUP BY quadrant_derived
       ORDER BY quadrant_derived
    `);

    console.log('--- pharmacies counts ---');
    console.table(totals.rows);
    console.log('--- by quadrant_derived (NTILE 4) ---');
    console.table(byQuadrant.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
  }
})();
