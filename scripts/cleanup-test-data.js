/**
 * Cleanup test data from external tables.
 * Only deletes rows created by the smoke/UAT test pipeline (flex_parameter_2 containing "Pilot Rep").
 * Does NOT touch the POI catalog (ing_poi_farmacias_ecatepec).
 *
 * Usage: node scripts/cleanup-test-data.js [--dry-run]
 */
require('dotenv').config({ override: true });
const getExternalDatabase = require('../src/config/externalDatabase');
const config = require('../src/config');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  if (config.dataBackend !== 'external') {
    console.log('DATA_BACKEND is not external. Nothing to clean.');
    return;
  }

  const db = getExternalDatabase();

  const surveyTable = config.externalData.fieldSurveyTable;
  const locationsTable = config.externalData.deviceLocationsTable;

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE DELETE'}`);
  console.log(`Survey table:    ${surveyTable}`);
  console.log(`Locations table: ${locationsTable}`);
  console.log('');

  const surveyCount = await db.raw(
    `SELECT count(*) AS cnt FROM ${surveyTable} WHERE flex_parameter_2 LIKE 'Pilot Rep%'`,
  );
  const surveyRows = Number(surveyCount.rows[0]?.cnt || 0);
  console.log(`Survey test rows found: ${surveyRows}`);

  const locCount = await db.raw(
    `SELECT count(*) AS cnt FROM ${locationsTable}`,
  );
  const locRows = Number(locCount.rows[0]?.cnt || 0);
  console.log(`Location rows found:    ${locRows}`);

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run without --dry-run to delete.');
    process.exit(0);
  }

  if (surveyRows > 0) {
    await db.raw(
      `DELETE FROM ${surveyTable} WHERE flex_parameter_2 LIKE 'Pilot Rep%'`,
    );
    console.log(`Deleted ${surveyRows} survey test rows.`);
  }

  if (locRows > 0) {
    await db.raw(`DELETE FROM ${locationsTable}`);
    console.log(`Deleted ${locRows} location rows.`);
  }

  console.log('\nCleanup complete.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
