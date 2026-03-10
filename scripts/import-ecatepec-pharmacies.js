const path = require('path');

const db = require('../src/config/database');
const {
  DEFAULT_INPUT_PATH,
  buildNaturalKey,
  normalizePharmacies,
  readRawRows,
  toDatabaseRecord,
} = require('./ecatepec-data');

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_PATH,
    dryRun: argv.includes('--dry-run'),
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input' && argv[index + 1]) {
      args.input = path.resolve(argv[index + 1]);
      index += 1;
    } else if (token === '--limit' && argv[index + 1]) {
      args.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  return args;
}

async function loadExistingKeys() {
  const existing = await db('pharmacies').select('name', 'address');
  return new Set(existing.map((row) => buildNaturalKey({
    name: row.name,
    address: row.address,
    lat: 0,
    lng: 0,
  })));
}

function buildImportKey(pharmacy) {
  return buildNaturalKey({
    name: pharmacy.name,
    address: pharmacy.address,
    lat: 0,
    lng: 0,
  });
}

async function insertBatch(batch) {
  const rows = batch.map((pharmacy) => {
    const record = toDatabaseRecord(pharmacy);
    return {
      name: record.name,
      address: record.address,
      category: record.category,
      subcategory: record.subcategory,
      municipality: record.municipality,
      state: record.state,
      contact_phone: record.contact_phone,
      contact_person: record.contact_person,
      opening_hours: record.opening_hours,
      closing_hours: record.closing_hours,
      num_reviews: record.num_reviews,
      popularity_score: record.popularity_score,
      data_confidence_score: record.data_confidence_score,
      is_independent: record.is_independent,
      status: record.status,
      verification_status: record.verification_status,
      order_potential: record.order_potential,
      notes: record.notes,
      source: record.source,
      coordinates: db.raw(
        'ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography',
        [record.lng, record.lat],
      ),
    };
  });

  await db('pharmacies').insert(rows);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readRawRows(args.input);
  let pharmacies = normalizePharmacies(rows);

  if (Number.isFinite(args.limit) && args.limit > 0) {
    pharmacies = pharmacies.slice(0, args.limit);
  }

  const existingKeys = await loadExistingKeys();
  const toInsert = pharmacies.filter((pharmacy) => !existingKeys.has(buildImportKey(pharmacy)));

  console.log(`Ecatepec import source: ${args.input}`);
  console.log(`Normalized rows: ${pharmacies.length}`);
  console.log(`Rows to insert: ${toInsert.length}`);

  if (args.dryRun) {
    console.log('Dry run enabled. No rows were inserted.');
    return;
  }

  const batchSize = 200;
  for (let index = 0; index < toInsert.length; index += batchSize) {
    const batch = toInsert.slice(index, index + batchSize);
    await insertBatch(batch);
    console.log(`Inserted ${Math.min(index + batch.length, toInsert.length)} / ${toInsert.length}`);
  }

  console.log('Ecatepec import complete.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
