require('dotenv').config({ override: true });
const db = require('../src/config/externalDatabase')();
const config = require('../src/config');

(async () => {
  const survey = config.externalData.fieldSurveyTable;
  const poi = config.externalData.poiTable;

  const statusBreakdown = await db.raw(
    `SELECT flex_parameter_4 AS status, COUNT(*) AS filas, COUNT(DISTINCT id_pois) AS farmacias
     FROM ${survey} GROUP BY flex_parameter_4 ORDER BY filas DESC`,
  );
  console.log('=== field_survey_pharmacy ===');
  statusBreakdown.rows.forEach((r) => console.log(`  ${r.status}: ${r.filas} filas, ${r.farmacias} farmacias únicas`));

  const totalPoi = await db.raw(`SELECT COUNT(*) AS cnt FROM ${poi}`);
  console.log(`\n=== POI catalog: ${totalPoi.rows[0].cnt} farmacias ===`);

  const completedIds = await db.raw(
    `SELECT DISTINCT id_pois FROM ${survey} WHERE flex_parameter_4 = 'completed'`,
  );
  if (completedIds.rows.length) {
    console.log(`\nFarmacias con status 'completed' (smoke tests): ${completedIds.rows.length}`);
    completedIds.rows.forEach((r) => console.log(`  ${r.id_pois}`));
  }

  const assignedNotInPoi = await db.raw(
    `SELECT COUNT(DISTINCT s.id_pois) AS cnt
     FROM ${survey} s
     LEFT JOIN ${poi} p ON s.id_pois::text = p.id::text
     WHERE s.flex_parameter_4 = 'assigned' AND p.id IS NULL`,
  );
  console.log(`\nAsignadas sin match en POI catalog: ${assignedNotInPoi.rows[0].cnt}`);

  const diff = Number(totalPoi.rows[0].cnt) - 2029;
  console.log(`\nDiferencia catalogo vs asignadas: ${totalPoi.rows[0].cnt} - 2029 = ${diff}`);
  console.log('Motivo probable: esas farmacias ya tenían status completed/cancelled de smoke tests anteriores y la distribución las excluyó.');

  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
