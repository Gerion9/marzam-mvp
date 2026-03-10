const bcrypt = require('bcryptjs');
const path = require('path');

const db = require('../src/config/database');
const assignmentService = require('../src/modules/assignments/assignments.service');
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
    reps: 50,
    password: 'Rep2026!',
    municipality: 'Ecatepec de Morelos',
    campaign_objective: 'Prospecting',
    priority: 'high',
    due_date: null,
    wave_id: `ecatepec-wave-${new Date().toISOString().slice(0, 10)}`,
    max_per_rep: null,
    skip_import: false,
    skip_distribute: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input' && argv[index + 1]) {
      args.input = path.resolve(argv[index + 1]);
      index += 1;
    } else if (token === '--reps' && argv[index + 1]) {
      args.reps = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (token === '--password' && argv[index + 1]) {
      args.password = argv[index + 1];
      index += 1;
    } else if (token === '--municipality' && argv[index + 1]) {
      args.municipality = argv[index + 1];
      index += 1;
    } else if (token === '--objective' && argv[index + 1]) {
      args.campaign_objective = argv[index + 1];
      index += 1;
    } else if (token === '--priority' && argv[index + 1]) {
      args.priority = argv[index + 1];
      index += 1;
    } else if (token === '--due-date' && argv[index + 1]) {
      args.due_date = argv[index + 1];
      index += 1;
    } else if (token === '--wave-id' && argv[index + 1]) {
      args.wave_id = argv[index + 1];
      index += 1;
    } else if (token === '--max-per-rep' && argv[index + 1]) {
      args.max_per_rep = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (token === '--skip-import') {
      args.skip_import = true;
    } else if (token === '--skip-distribute') {
      args.skip_distribute = true;
    }
  }

  return args;
}

async function ensureManager() {
  const manager = await db('users')
    .where({ role: 'manager', is_active: true })
    .orderBy('created_at', 'asc')
    .first();

  if (!manager) {
    const err = new Error('No active manager user found. Run seeds first.');
    err.status = 422;
    throw err;
  }

  return manager;
}

async function ensurePilotReps(count, password) {
  const hash = await bcrypt.hash(password, 10);
  const existing = await db('users')
    .where({ role: 'field_rep' })
    .orderBy('full_name', 'asc');

  const existingByEmail = new Map(existing.map((user) => [user.email, user]));
  const created = [];

  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const email = `rep${suffix}@marzam.mx`;
    if (existingByEmail.has(email)) continue;
    created.push({
      email,
      password_hash: hash,
      full_name: `Pilot Rep ${suffix}`,
      role: 'field_rep',
      is_active: true,
    });
  }

  if (created.length) {
    await db('users').insert(created);
  }

  return db('users')
    .where({ role: 'field_rep', is_active: true })
    .orderBy('full_name', 'asc')
    .limit(count);
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

async function importEcatepecIfNeeded(inputPath) {
  const currentCount = await db('pharmacies').count('id as count').first();
  if (Number(currentCount?.count || 0) > 0) {
    return { skipped: true, inserted: 0 };
  }

  const rows = readRawRows(inputPath);
  const pharmacies = normalizePharmacies(rows);
  const existingKeys = await loadExistingKeys();
  const toInsert = pharmacies.filter((pharmacy) => !existingKeys.has(buildNaturalKey({
    name: pharmacy.name,
    address: pharmacy.address,
    lat: 0,
    lng: 0,
  })));

  const batchSize = 200;
  for (let index = 0; index < toInsert.length; index += batchSize) {
    const batch = toInsert.slice(index, index + batchSize);
    const payload = batch.map((pharmacy) => {
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
    await db('pharmacies').insert(payload);
  }

  return { skipped: false, inserted: toInsert.length };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const manager = await ensureManager();
  const reps = await ensurePilotReps(args.reps, args.password);
  const repIds = reps.map((rep) => rep.id);

  const importResult = args.skip_import
    ? { skipped: true, inserted: 0 }
    : await importEcatepecIfNeeded(args.input);

  let distributionResult = null;
  if (!args.skip_distribute) {
    distributionResult = await assignmentService.distributeWave({
      municipality: args.municipality,
      rep_ids: repIds,
      campaign_objective: args.campaign_objective,
      priority: args.priority,
      due_date: args.due_date,
      created_by: manager.id,
      wave_id: args.wave_id,
      max_pharmacies_per_rep: args.max_per_rep || undefined,
    });
  }

  console.log(JSON.stringify({
    importResult,
    createdRepCount: repIds.length,
    distributionResult,
  }, null, 2));
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
