/**
 * Sync `stg_marzam_detalle_mostrador` → marzam_clients.
 *
 * UPSERT key: cpadre.
 */

const db = require('../../../config/database');
const {
  BQ_TABLES,
  fetchAll,
  buildKeyMap,
  pickFirst,
  asString,
  asInt,
  asBool,
  asDate,
} = require('../bqHelpers');

const JOB_NAME = 'detalle_mostrador';

const COL_CANDIDATES = {
  // PARENT account (1-to-many).  Format like '99307' (5 digits).
  cpadre: ['cpadre', 'c_padre', 'cuenta_padre'],
  // LEAF mostrador (1-to-1 per pharmacy).  Format like 'A37636' / 'D87628'.
  // Empirically validated as the join key against
  // `int_marzam_prospect_scored.clave_mostradores_marzam`.
  // NOTE: in BQ the source column is literally named `mostradores` —
  // misleading but that's what BlackPrint ships.  We expose it under the
  // sane name `clave_mostrador` from this point on.
  clave_mostrador: ['mostradores', 'clave_mostrador'],
  dataplor_id: ['dataplor_id', 'id_dataplor', 'match_dataplor_id'],
  farmacia_nombre: ['farmacia', 'nombre_farmacia', 'farmacia_nombre', 'razon_social', 'nombre'],
  direccion: ['direccion', 'domicilio'],
  delegacion_municipio: ['delegacion_municipio', 'delegacion', 'municipio'],
  poblacion: ['poblacion', 'plaza'],
  pareto: ['pareto'],
  perfil: ['perfil'],
  unefarm: ['unefarm', 'une_farm'],
  is_independent: ['independiente', 'is_independent'],
  contact_center: ['contact_center', 'cc', 'es_cc'],
  // BlackPrint historically ships `mostradores` as the per-counter STRING
  // ID (covered above as clave_mostrador), so we DON'T also try to coerce
  // it to a numeric count here.  If a future schema brings back a real
  // counter we'll revisit.
  num_mostradores: ['num_mostradores'],
  cliente_visita: ['cliente_visita', 'tipo_visita'],
  ruta: ['ruta'],
  liberacion_de_ruta: ['liberacion_de_ruta', 'liberacion_ruta'],
  agente: ['representante', 'agente'],
  // Hierarchy: present in detalle_mostrador, missing in cuadro_basico
  gerencia: ['gerencia', 'division'],
  gerente_nombre: ['gerente'],
  supervisor_code: ['supervisor'],
  supervisor_nombre: ['supervisor_nombre'],
  // Monthly totals — feed sales_targets.acumulado / avance / objetivo
  acumulado: ['acumulado'],
  avance: ['avance'],
  objetivo: ['objetivo_o_presupuesto'],
  importe_para_objetivo: ['importe_para_objetivo'],
  devoluciones: ['devoluciones'],
  mostradores_con_venta: ['mostradores_con_venta'],
  mostradores_para_venta: ['mostradores_para_venta'],
  visitas_pedido: ['visitas_pedido'],
  clientes_cc: ['clientes_cc'],
};

function __getCandidatesForInspector() { return COL_CANDIDATES; }

async function run({ limit = null } = {}) {
  const startedAt = Date.now();
  const rows = await fetchAll(BQ_TABLES.DETALLE_MOSTRADOR, { limit });
  if (!rows.length) {
    return { name: JOB_NAME, rows: 0, inserted: 0, updated: 0, skipped: 0, duration_ms: Date.now() - startedAt };
  }
  const keyMap = buildKeyMap(rows[0]);
  const stats = { rows: rows.length, inserted: 0, updated: 0, skipped: 0 };

  for (const raw of rows) {
    const cpadre = asString(pickFirst(raw, COL_CANDIDATES.cpadre, keyMap));
    if (!cpadre) {
      stats.skipped += 1;
      continue;
    }

    const pareto = asString(pickFirst(raw, COL_CANDIDATES.pareto, keyMap))?.toUpperCase() || null;
    if (pareto && !['A', 'B', 'C'].includes(pareto)) {
      stats.skipped += 1;
      continue;
    }

    const claveMostrador = asString(pickFirst(raw, COL_CANDIDATES.clave_mostrador, keyMap));
    const data = {
      cpadre,
      clave_mostrador: claveMostrador,
      dataplor_id: asString(pickFirst(raw, COL_CANDIDATES.dataplor_id, keyMap)),
      farmacia_nombre: asString(pickFirst(raw, COL_CANDIDATES.farmacia_nombre, keyMap)),
      delegacion_municipio: asString(pickFirst(raw, COL_CANDIDATES.delegacion_municipio, keyMap)),
      poblacion: asString(pickFirst(raw, COL_CANDIDATES.poblacion, keyMap)),
      pareto,
      perfil: asString(pickFirst(raw, COL_CANDIDATES.perfil, keyMap)),
      unefarm: asBool(pickFirst(raw, COL_CANDIDATES.unefarm, keyMap)) ?? false,
      is_independent: asBool(pickFirst(raw, COL_CANDIDATES.is_independent, keyMap)) ?? true,
      contact_center: asBool(pickFirst(raw, COL_CANDIDATES.contact_center, keyMap)) ?? false,
      mostradores: asInt(pickFirst(raw, COL_CANDIDATES.num_mostradores, keyMap)),
      cliente_visita: asString(pickFirst(raw, COL_CANDIDATES.cliente_visita, keyMap)),
      ruta: asString(pickFirst(raw, COL_CANDIDATES.ruta, keyMap)),
      liberacion_de_ruta: asDate(pickFirst(raw, COL_CANDIDATES.liberacion_de_ruta, keyMap)),
      agente: asString(pickFirst(raw, COL_CANDIDATES.agente, keyMap)),
      last_imported_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    try {
      const existing = await db('marzam_clients').select('id').where({ cpadre }).first();
      if (existing) {
        await db('marzam_clients').where({ id: existing.id }).update(data);
        stats.updated += 1;
      } else {
        await db('marzam_clients').insert(data);
        stats.inserted += 1;
      }
    } catch (err) {
      console.warn(`[bq-sync:${JOB_NAME}] cpadre=${cpadre}: ${err.message}`);
      stats.skipped += 1;
    }
  }

  // Post-step: propagate authoritative `marzam_clients.pareto` into the
  // unified `pharmacies.pareto` so the field-rep map can render Marzam
  // clients with their correct A/B/C bucket without joining at query time.
  //
  //   The link is the LEAF `clave_mostrador` (1-to-1 per pharmacy):
  //     - `marzam_clients.clave_mostrador` ← from BQ `mostradores`
  //                                          (e.g. 'A37636', 'D87628')
  //     - `pharmacies.clave_mostrador`     ← from BQ
  //                                          `clave_mostradores_marzam`
  //                                          (same shape, same values)
  //
  //   Empirical match rate against real BQ data: ~55 % (rows that exist
  //   in detalle_mostrador but not yet in prospect_scored simply skip).
  //
  //   For prospects (`pharmacies.clave_mostrador IS NULL` because they
  //   aren't Marzam clients) this UPDATE is a no-op — they keep the
  //   pareto value that syncProspectScored wrote from `tier_clean`.
  const propagated = await propagateMarzamPareto();
  return { name: JOB_NAME, ...stats, ...propagated, duration_ms: Date.now() - startedAt };
}

/**
 * Override `pharmacies.pareto` for Marzam clients with the value coming
 * from the Marzam-specific source table (`stg_marzam_detalle_mostrador`,
 * mirrored into `marzam_clients`).  Joins on `clave_mostrador` — the
 * LEAF mostrador identifier, not the cuenta padre.
 */
async function propagateMarzamPareto() {
  const result = await db.raw(`
    UPDATE pharmacies p
       SET pareto     = mc.pareto,
           updated_at = NOW()
      FROM marzam_clients mc
     WHERE p.clave_mostrador IS NOT NULL
       AND p.clave_mostrador = mc.clave_mostrador
       AND mc.pareto IS NOT NULL
       AND p.pareto IS DISTINCT FROM mc.pareto
  `);
  const propagated = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  return { marzam_pareto_propagated: propagated };
}

module.exports = { run, JOB_NAME, __getCandidatesForInspector, propagateMarzamPareto };
