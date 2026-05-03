require('dotenv').config();

const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 60000,
  },
  pool: { min: 0, max: 4, acquireTimeoutMillis: 90000 },
  acquireConnectionTimeout: 90000,
  searchPath: ['marzam_app', 'public'],
});

const EXPECTED_DELETE = 1285;
const EXPECTED_REMAINING_AFTER = 3121;

async function warmupPing() {
  for (let i = 0; i < 6; i++) {
    try {
      await knex.raw('SELECT 1');
      console.log(`  ping ${i + 1} OK`);
      return;
    } catch (e) {
      console.log(`  ping ${i + 1} falló: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('No se pudo conectar a la base de datos');
}

(async () => {
  let trx;
  try {
    console.log('1) Conectando…');
    await warmupPing();

    console.log('\n2) Verificación previa (qué vamos a borrar):');
    const beforeRow = await knex.raw(`
      SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE business_type IS NULL)    AS sin_bt,
        COUNT(*) FILTER (WHERE business_type IS NULL
                        AND source = 'blackprint')       AS target_borrado,
        COUNT(*) FILTER (WHERE business_type IS NULL
                        AND source = 'blackprint'
                        AND dataplor_id IS NOT NULL)     AS target_con_dataplor,
        COUNT(*) FILTER (WHERE business_type IS NULL
                        AND source = 'blackprint'
                        AND clave_mostrador IS NOT NULL) AS target_con_clave,
        COUNT(*) FILTER (WHERE business_type IS NULL
                        AND source = 'blackprint'
                        AND created_at < '2026-04-30 12:00:00 UTC') AS target_creadas_madrugada
      FROM pharmacies
    `);
    console.table(beforeRow.rows);

    const before = beforeRow.rows[0];
    const totalBefore = parseInt(before.total, 10);
    const targetCount = parseInt(before.target_borrado, 10);
    const conDataplor = parseInt(before.target_con_dataplor, 10);
    const conClave = parseInt(before.target_con_clave, 10);
    const creadasMadrugada = parseInt(before.target_creadas_madrugada, 10);

    console.log('\n3) Validaciones de seguridad:');

    const checks = [
      {
        nombre: `Total a borrar = ${EXPECTED_DELETE}`,
        ok: targetCount === EXPECTED_DELETE,
        valor: targetCount,
      },
      {
        nombre: 'Ninguna tiene clave_mostrador (no son clientes Marzam)',
        ok: conClave === 0,
        valor: conClave,
      },
      {
        nombre: 'Todas tienen dataplor_id (vienen del sync viejo)',
        ok: conDataplor === targetCount,
        valor: `${conDataplor}/${targetCount}`,
      },
      {
        nombre: 'Todas se crearon en la madrugada (antes de 12 UTC hoy)',
        ok: creadasMadrugada === targetCount,
        valor: `${creadasMadrugada}/${targetCount}`,
      },
      {
        nombre: `Filas restantes serán ${EXPECTED_REMAINING_AFTER}`,
        ok: totalBefore - targetCount === EXPECTED_REMAINING_AFTER,
        valor: totalBefore - targetCount,
      },
    ];

    let allPass = true;
    for (const c of checks) {
      const sym = c.ok ? '✅' : '❌';
      console.log(`  ${sym} ${c.nombre}  (got: ${c.valor})`);
      if (!c.ok) allPass = false;
    }

    if (!allPass) {
      console.error('\n⛔ Una validación falló. Abortando sin borrar nada.');
      process.exit(1);
    }

    console.log('\n4) Iniciando transacción…');
    trx = await knex.transaction();

    // Antes de borrar de pharmacies, hay que limpiar referencias FK.
    // Las tablas que referencian pharmacies(id):
    const refs = await trx.raw(`
      SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND ccu.table_name = 'pharmacies'
         AND ccu.column_name = 'id'
       ORDER BY tc.table_name
    `);
    console.log('\n5) Tablas que referencian pharmacies(id):');
    console.table(refs.rows);

    // Verificar si alguna de las huerfanas tiene referencias en otras tablas.
    // Si las hay, abortamos para que el usuario decida.
    for (const ref of refs.rows) {
      const { table_name, column_name } = ref;
      const refCount = await trx.raw(
        `SELECT COUNT(*)::int AS n FROM ${table_name}
          WHERE ${column_name} IN (
            SELECT id FROM pharmacies
             WHERE business_type IS NULL AND source = 'blackprint'
          )`
      );
      const n = refCount.rows[0].n;
      console.log(`  ${table_name}.${column_name} → ${n} referencias a huerfanas`);
      if (n > 0) {
        console.error(`\n⛔ Hay ${n} referencias activas en ${table_name}. Abortando para no romper FKs.`);
        await trx.rollback();
        process.exit(1);
      }
    }

    console.log('\n6) Ejecutando DELETE…');
    const result = await trx.raw(`
      DELETE FROM pharmacies
       WHERE business_type IS NULL
         AND source = 'blackprint'
       RETURNING id
    `);
    const deletedCount = result.rows.length;
    console.log(`  filas eliminadas: ${deletedCount}`);

    if (deletedCount !== EXPECTED_DELETE) {
      console.error(`\n⛔ Borradas (${deletedCount}) ≠ esperadas (${EXPECTED_DELETE}). Rollback.`);
      await trx.rollback();
      process.exit(1);
    }

    const afterCount = await trx.raw(
      `SELECT COUNT(*)::int AS total FROM pharmacies`
    );
    const totalAfter = afterCount.rows[0].total;
    console.log(`  total restante: ${totalAfter}`);

    if (totalAfter !== EXPECTED_REMAINING_AFTER) {
      console.error(`\n⛔ Total restante (${totalAfter}) ≠ esperado (${EXPECTED_REMAINING_AFTER}). Rollback.`);
      await trx.rollback();
      process.exit(1);
    }

    console.log('\n7) Verificación post-borrado por business_type:');
    const breakdown = await trx.raw(`
      SELECT
        COALESCE(business_type, '(null)') AS business_type,
        COALESCE(source, '(null)')        AS source,
        COUNT(*)::int                     AS n
      FROM pharmacies
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    console.table(breakdown.rows);

    console.log('\n8) ✅ Todo correcto. COMMIT.');
    await trx.commit();
    console.log('\n🎉 Listo. Pharmacies queda en 3,121 filas reales.');
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    if (trx) {
      try {
        await trx.rollback();
        console.log('  rollback OK');
      } catch (_) {}
    }
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
