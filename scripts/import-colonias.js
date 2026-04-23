const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('../src/config/database');

const DEFAULT_INPUT_PATH = path.join(__dirname, '..', 'data', 'colonias_ecatepec.csv');

function toText(value) {
  return String(value ?? '').trim() || null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseCoordinatesJson(raw) {
  if (!raw) return null;
  try {
    const coords = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(coords) || coords.length < 3) return null;
    const ring = coords.map(([lng, lat]) => [lng, lat]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push([...ring[0]]);
    }
    return { type: 'Polygon', coordinates: [ring] };
  } catch {
    return null;
  }
}

function readRows(inputPath) {
  const csvContents = fs.readFileSync(inputPath, 'utf8');
  const workbook = XLSX.read(csvContents, { raw: false, type: 'string' });
  const firstSheet = workbook.SheetNames[0];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
}

function normalizeRow(row) {
  const geojson = parseCoordinatesJson(row.geometry_coords_json);
  if (!geojson) return null;

  const settlementName = toText(row.sett_name);
  if (!settlementName) return null;

  return {
    objectid: toNumber(row.objectid),
    postalcode: toText(row.postalcode),
    state_name: toText(row.st_name),
    municipality_name: toText(row.mun_name),
    settlement_name: settlementName,
    settlement_type: toText(row.sett_type),
    security_level: 'acceptable',
    area_m2: toNumber(row.area),
    shape_length: toNumber(row.shape_leng),
    shape_area: toNumber(row.shape_area),
    geojson,
  };
}

async function run() {
  const args = process.argv.slice(2);
  const inputPath = args.includes('--input') ? path.resolve(args[args.indexOf('--input') + 1]) : DEFAULT_INPUT_PATH;
  const dryRun = args.includes('--dry-run');

  const rawRows = readRows(inputPath);
  const colonias = rawRows.map(normalizeRow).filter(Boolean);

  const existingObjectIds = new Set(
    (await db('colonias').select('objectid').whereNotNull('objectid')).map((r) => r.objectid),
  );
  const toInsert = colonias.filter((c) => !existingObjectIds.has(c.objectid));

  console.log(`Source: ${inputPath}`);
  console.log(`Parsed rows: ${colonias.length}`);
  console.log(`Already in DB: ${existingObjectIds.size}`);
  console.log(`Rows to insert: ${toInsert.length}`);

  if (dryRun) {
    console.log('Dry run — no rows inserted.');
    return;
  }

  const batchSize = 50;
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const rows = batch.map((c) => ({
      objectid: c.objectid,
      postalcode: c.postalcode,
      state_name: c.state_name,
      municipality_name: c.municipality_name,
      settlement_name: c.settlement_name,
      settlement_type: c.settlement_type,
      security_level: c.security_level,
      area_m2: c.area_m2,
      shape_length: c.shape_length,
      shape_area: c.shape_area,
      geom: db.raw(
        `ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)`,
        [JSON.stringify(c.geojson)],
      ),
    }));
    await db('colonias').insert(rows);
    console.log(`Inserted ${Math.min(i + batch.length, toInsert.length)} / ${toInsert.length}`);
  }

  console.log('Colonia import complete.');

  const updated = await db.raw(`
    UPDATE pharmacies p
    SET colonia_id = c.id
    FROM colonias c
    WHERE p.colonia_id IS NULL
      AND ST_Within(p.coordinates::geometry, c.geom)
  `);
  console.log(`Backfilled colonia_id for ${updated.rowCount || 0} pharmacies.`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
