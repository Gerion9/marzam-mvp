#!/usr/bin/env node
/**
 * Seed initial territory tree for Marzam.
 *
 * Creates:
 *   Mexico (national)
 *     ├── Estado de México (regional)
 *     │     └── Ecatepec (municipal)
 *     └── CDMX (regional)
 *
 * Idempotent: re-running only inserts missing rows (matched by code).
 */

const db = require('../src/config/database');

const SEED = [
  { code: 'MX', level: 'national', name: 'México', parent_code: null },
  { code: 'MX-EMX', level: 'regional', name: 'Estado de México', parent_code: 'MX' },
  { code: 'MX-CMX', level: 'regional', name: 'CDMX', parent_code: 'MX' },
  { code: 'MX-EMX-ECA', level: 'municipal', name: 'Ecatepec', parent_code: 'MX-EMX' },
];

async function upsertTerritory({ code, level, name, parent_code }) {
  const existing = await db('territories').where({ code }).first();
  if (existing) {
    console.log(`  = ${code} (${name}) — already exists`);
    return existing;
  }
  let parent_id = null;
  if (parent_code) {
    const parent = await db('territories').where({ code: parent_code }).first();
    if (!parent) throw new Error(`Parent territory ${parent_code} not found`);
    parent_id = parent.id;
  }
  const [row] = await db('territories')
    .insert({ code, level, name, parent_id })
    .returning('*');
  console.log(`  + ${code} (${name})`);
  return row;
}

async function backfillColoniasAndPharmacies() {
  console.log('\nBackfilling colonias.territory_id and pharmacies.territory_id...');

  const ecatepec = await db('territories').where({ code: 'MX-EMX-ECA' }).first();
  if (!ecatepec) {
    console.log('  Ecatepec territory not found, skipping backfill');
    return;
  }

  const coloniasUpdated = await db('colonias')
    .whereRaw(`LOWER(municipality_name) LIKE '%ecatepec%'`)
    .update({ territory_id: ecatepec.id });
  console.log(`  ✓ colonias linked to Ecatepec: ${coloniasUpdated}`);

  const pharmaciesUpdated = await db('pharmacies')
    .whereRaw(`LOWER(municipality) LIKE '%ecatepec%'`)
    .update({ territory_id: ecatepec.id });
  console.log(`  ✓ pharmacies linked to Ecatepec: ${pharmaciesUpdated}`);
}

async function main() {
  console.log('Seeding territories...\n');
  for (const t of SEED) {
    // eslint-disable-next-line no-await-in-loop
    await upsertTerritory(t);
  }
  await backfillColoniasAndPharmacies();
  console.log('\nDone.');
  await db.destroy();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
  db.destroy();
});
