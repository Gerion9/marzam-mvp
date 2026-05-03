/**
 * Sync `stg_marzam_clients_ecatepec` — close the BlackPrint↔Marzam match.
 *
 * For every (cpadre, dataplor_id) in the BQ table, ensure the corresponding
 * `marzam_clients` row carries the dataplor_id and links to the matching
 * `pharmacies.id`.
 */

const db = require('../../../config/database');
const {
  BQ_TABLES,
  fetchAll,
  buildKeyMap,
  pickFirst,
  asString,
} = require('../bqHelpers');

const JOB_NAME = 'clients_ecatepec';

const COL_CANDIDATES = {
  cpadre: ['cuenta_padre', 'cpadre', 'clave_mostrador', 'c_padre'],
  dataplor_id: ['match_dataplor_id', 'dataplor_id', 'id_dataplor'],
};

function __getCandidatesForInspector() { return COL_CANDIDATES; }

async function run({ limit = null } = {}) {
  const startedAt = Date.now();
  const rows = await fetchAll(BQ_TABLES.CLIENTS_ECATEPEC, { limit });
  if (!rows.length) {
    return { name: JOB_NAME, rows: 0, matched: 0, missing_marzam: 0, missing_pharmacy: 0, duration_ms: Date.now() - startedAt };
  }

  const keyMap = buildKeyMap(rows[0]);
  const stats = { rows: rows.length, matched: 0, missing_marzam: 0, missing_pharmacy: 0 };

  for (const raw of rows) {
    const cpadre = asString(pickFirst(raw, COL_CANDIDATES.cpadre, keyMap));
    const dataplorId = asString(pickFirst(raw, COL_CANDIDATES.dataplor_id, keyMap));
    if (!cpadre || !dataplorId) continue;

    const pharmacy = await db('pharmacies').select('id').where({ dataplor_id: dataplorId }).first();
    const marzamClient = await db('marzam_clients').select('id').where({ cpadre }).first();

    if (!marzamClient) {
      stats.missing_marzam += 1;
      continue;
    }
    if (!pharmacy) {
      // mark dataplor_id but no pharmacy yet
      await db('marzam_clients').where({ id: marzamClient.id }).update({
        dataplor_id: dataplorId,
        updated_at: db.fn.now(),
      });
      stats.missing_pharmacy += 1;
      continue;
    }

    await db('marzam_clients').where({ id: marzamClient.id }).update({
      dataplor_id: dataplorId,
      pharmacy_id: pharmacy.id,
      updated_at: db.fn.now(),
    });
    stats.matched += 1;
  }

  return { name: JOB_NAME, ...stats, duration_ms: Date.now() - startedAt };
}

module.exports = { run, JOB_NAME, __getCandidatesForInspector };
