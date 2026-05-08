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
    // 1. Cruz: source x business_type
    const cross = await knex.raw(`
      SELECT
        COALESCE(source, '(null)')        AS source,
        COALESCE(business_type, '(null)') AS business_type,
        COUNT(*)::int AS n
      FROM pharmacies
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    console.log('--- source x business_type ---');
    console.table(cross.rows);

    // 2. Timestamps con hora exacta
    const byHour = await knex.raw(`
      SELECT
        DATE_TRUNC('hour', created_at)    AS hora,
        COALESCE(business_type, '(null)') AS business_type,
        COUNT(*)::int AS n
      FROM pharmacies
      GROUP BY 1, 2
      ORDER BY hora ASC, n DESC
    `);
    console.log('\n--- creadas por hora x business_type ---');
    console.table(byHour.rows);

    // 3. updated_at: ¿se actualizaron después?
    const updates = await knex.raw(`
      SELECT
        DATE_TRUNC('hour', updated_at)    AS hora_update,
        COALESCE(business_type, '(null)') AS business_type,
        COUNT(*)::int AS n
      FROM pharmacies
      GROUP BY 1, 2
      ORDER BY hora_update ASC, n DESC
    `);
    console.log('\n--- updated_at x business_type ---');
    console.table(updates.rows);

    // 4. Muestra de las 1285 con business_type NULL
    const sample = await knex.raw(`
      SELECT id, source, business_type, name,
             dataplor_id, clave_mostrador,
             pareto, quadrant_derived, final_score,
             created_at, updated_at
        FROM pharmacies
       WHERE business_type IS NULL
       ORDER BY created_at
       LIMIT 5
    `);
    console.log('\n--- muestra de filas con business_type NULL ---');
    console.table(sample.rows);

    // 5. ¿Qué columnas tienen estas filas? ¿Tienen final_score / quadrant?
    const coverage = await knex.raw(`
      SELECT
        COUNT(*)                                                   AS total,
        COUNT(*) FILTER (WHERE final_score IS NOT NULL)            AS con_score,
        COUNT(*) FILTER (WHERE quadrant_derived IS NOT NULL)       AS con_quadrant,
        COUNT(*) FILTER (WHERE pareto IS NOT NULL)                 AS con_pareto,
        COUNT(*) FILTER (WHERE name IS NOT NULL AND name <> '')    AS con_name,
        COUNT(*) FILTER (WHERE address IS NOT NULL AND address <> '') AS con_address,
        COUNT(*) FILTER (WHERE geocoded_relevance IS NOT NULL)     AS con_geo_rel
      FROM pharmacies
      WHERE business_type IS NULL
    `);
    console.log('\n--- cobertura de campos en filas con business_type NULL ---');
    console.table(coverage.rows);

    // 6. Mismo análisis para filas CON business_type
    const coverage2 = await knex.raw(`
      SELECT
        business_type,
        COUNT(*)::int                                              AS total,
        COUNT(*) FILTER (WHERE final_score IS NOT NULL)::int       AS con_score,
        COUNT(*) FILTER (WHERE quadrant_derived IS NOT NULL)::int  AS con_quadrant,
        COUNT(*) FILTER (WHERE pareto IS NOT NULL)::int            AS con_pareto
      FROM pharmacies
      WHERE business_type IS NOT NULL
      GROUP BY business_type
    `);
    console.log('\n--- cobertura para filas CON business_type ---');
    console.table(coverage2.rows);

    // 7. ¿Tienen los IDs de prospect/cliente?
    const idStatus = await knex.raw(`
      SELECT
        CASE
          WHEN business_type IS NULL THEN 'NULL'
          ELSE business_type
        END AS bt,
        COUNT(*) FILTER (WHERE dataplor_id IS NOT NULL)::int       AS con_dataplor,
        COUNT(*) FILTER (WHERE dataplor_id IS NULL)::int           AS sin_dataplor,
        COUNT(*) FILTER (WHERE clave_mostrador IS NOT NULL)::int   AS con_clave
      FROM pharmacies
      GROUP BY 1
    `);
    console.log('\n--- IDs por business_type ---');
    console.table(idStatus.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
  }
})();
