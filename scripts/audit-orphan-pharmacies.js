require('dotenv').config();

// Cliente para pharmacies (ingestion_user)
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

// Cliente para staging (josue_user)
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

(async () => {
  try {
    // 1. Saca dataplor_ids de las 1285 huerfanas
    const orphans = await knexApp.raw(`
      SELECT dataplor_id, name, pareto, final_score, created_at
        FROM pharmacies
       WHERE business_type IS NULL
    `);
    const orphanIds = orphans.rows.map((r) => r.dataplor_id).filter(Boolean);
    console.log(`Pharmacies sin business_type: ${orphans.rows.length}`);
    console.log(`Con dataplor_id: ${orphanIds.length}`);

    // 2. Saca todos los dataplor_id que existen en staging actual
    const farm = await knexBq.raw(`
      SELECT DISTINCT dataplor_id FROM staging.stg_marzam_master_scored_farmacias WHERE dataplor_id IS NOT NULL
    `);
    const cons = await knexBq.raw(`
      SELECT DISTINCT dataplor_id FROM staging.stg_marzam_master_scored_consultorios WHERE dataplor_id IS NOT NULL
    `);
    const stagingIds = new Set([
      ...farm.rows.map((r) => r.dataplor_id),
      ...cons.rows.map((r) => r.dataplor_id),
    ]);
    console.log(`\nDataplor_ids únicos en staging: ${stagingIds.size}`);
    console.log(`  - farmacias: ${farm.rows.length}`);
    console.log(`  - consultorios: ${cons.rows.length}`);

    // 3. ¿Cuántas huerfanas existen / no existen en staging?
    const inStaging = orphanIds.filter((id) => stagingIds.has(id));
    const notInStaging = orphanIds.filter((id) => !stagingIds.has(id));
    console.log(`\nHuerfanas que SÍ están en staging actual: ${inStaging.length}`);
    console.log(`Huerfanas que NO están en staging actual: ${notInStaging.length}`);

    // 4. Muestra de huerfanas que NO existen en staging
    if (notInStaging.length > 0) {
      const sampleIds = notInStaging.slice(0, 10);
      const sampleData = orphans.rows.filter((r) => sampleIds.includes(r.dataplor_id));
      console.log('\n--- muestra (10) de huerfanas que NO están en staging actual ---');
      console.table(sampleData);
    }

    // 5. ¿Hay otras tablas en staging que las puedan contener?
    // Busquemos cualquier tabla en staging que tenga columna dataplor_id
    const tablas = await knexBq.raw(`
      SELECT table_schema, table_name, column_name
        FROM information_schema.columns
       WHERE column_name ILIKE '%dataplor%'
       ORDER BY table_schema, table_name
    `);
    console.log('\n--- tablas con columna dataplor* ---');
    console.table(tablas.rows);

    // 6. Si las huerfanas no están en master_scored, ¿estarán en otra fuente?
    // Probemos staging.stg_marzam_clients_ecatepec
    if (notInStaging.length > 0) {
      const sampleIdsTuple = notInStaging.slice(0, 5).map((id) => `'${id}'`).join(',');
      try {
        const ecat = await knexBq.raw(`
          SELECT *
            FROM staging.stg_marzam_clients_ecatepec
           WHERE dataplor_id IN (${sampleIdsTuple})
           LIMIT 5
        `);
        console.log('\n--- ¿están en stg_marzam_clients_ecatepec? ---');
        console.log(`Encontradas: ${ecat.rows.length}`);
        if (ecat.rows.length) console.table(ecat.rows.slice(0, 2));
      } catch (e) {
        console.log('  (tabla no existe o sin permisos)');
      }
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knexApp.destroy();
    await knexBq.destroy();
  }
})();
