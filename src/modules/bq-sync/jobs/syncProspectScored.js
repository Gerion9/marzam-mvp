/**
 * Sync the BlackPrint scored universe → `pharmacies`.
 *
 * SOURCE (2026-04 onwards): the pair
 *   - staging.stg_marzam_master_scored_farmacias    (1 825 rows)
 *   - staging.stg_marzam_master_scored_consultorios (1 500 rows)
 *
 * Both tables share an identical 98-column schema; only contents differ.
 * Together they cover BlackPrint's scored pharmacy universe (1 623 PROSPECT
 * + 202 CLIENT) AND the medical-consultorio universe (1 298 PROSPECT + 202
 * CLIENT).  The 202 CLIENT rows are LITERALLY duplicated across both
 * tables, so we dedup by `dataplor_id` — first writer (farmacias) wins.
 *
 * UPSERT key: `dataplor_id`.  Field-rep enrichment columns
 * (assigned_rep_id, last_visit_outcome, …) are preserved across runs.
 *
 * What this job populates on each row:
 *
 *   business_type ∈ {pharmacy, consultorio}
 *      Discriminator for the FE map (different shape per type).  Derived
 *      from which source table emitted the row; for the duplicated CLIENT
 *      rows we trust the farmacias table (Marzam clients are pharmacies
 *      by definition — Marzam doesn't sell to consultorios directly).
 *
 *   pareto ∈ {A, B, C}     ── only for CLIENTs (later)
 *      Initialised to NULL here.  syncDetalleMostrador overrides it via
 *      the `clave_mostrador` join with `marzam_clients.pareto`.
 *      For PROSPECTs `pareto` stays NULL — the FE displays the prospect's
 *      `quadrant` mapped Q1→A, Q2→B, Q3→C, Q4→D as a *cosmetic* tier; we
 *      DO NOT write that mapping into the BD because the A/B/C semantics
 *      in `pharmacies.pareto` are reserved for actual Marzam revenue
 *      classes.  See migration 046 for the rationale.
 *
 *   quadrant ∈ {Q1..Q4}
 *      Stored verbatim (after normalisation).  In master_scored the
 *      column ships descriptive labels like 'Q1_Stars', 'Q2_QuestionMarks',
 *      'Q3_Risk', 'Q4_Skip' — we strip the suffix.
 *
 *   final_score ∈ [0, 100]
 *   geocoded_relevance ∈ [0, 1]   ── only for CLIENTs
 *      Marzam doesn't ship real lat/lng for their clients yet, so
 *      BlackPrint geocoded the addresses and exposes the provider's
 *      relevance score.  The FE uses this to warn "Ubicación geocodeada
 *      · XX% confianza" on the popup.  Prospects already have field-
 *      collected lat/lng (Dataplor) so the column stays NULL for them.
 *
 *   source ∈ {marzam, blackprint}
 *      'marzam' for record_type='CLIENT', 'blackprint' for PROSPECT.
 *      Drives the FE legend split (Padrón Marzam vs Prospectos).
 */

const db = require('../../../config/database');
const {
  BQ_TABLES,
  fetchAll,
  buildKeyMap,
  pickFirst,
  asString,
  asNumeric,
  asBool,
} = require('../bqHelpers');

const JOB_NAME = 'prospect_scored';

const COL_CANDIDATES = {
  dataplor_id: ['dataplor_id', 'id_dataplor', 'place_id'],
  name: ['name', 'chain_name', 'nombre', 'farmacia_nombre', 'razon_social', 'farmacia'],
  address: ['address', 'direccion', 'domicilio'],
  municipality: ['municipality', 'city', 'municipio', 'delegacion', 'delegacion_municipio'],
  state: ['state', 'mercado', 'estado', 'entidad'],
  lat: ['latitude', 'lat', 'latitud'],
  lng: ['longitude', 'lng', 'lon', 'longitud'],
  // master_scored uses `record_type` ('CLIENT' / 'PROSPECT') — that's the
  // canonical signal.  The legacy `cliente_marzam` / `is_marzam_client`
  // boolean stays in candidates so older snapshots keep working.
  record_type: ['record_type'],
  is_marzam_client: ['cliente_marzam', 'is_marzam_client', 'es_cliente_marzam'],
  // LEAF mostrador identifier — formato 'A37636' / 'D87628'.  In master_scored
  // the column is literally `mostradores` (plural, but content is 1-a-1).
  // We persist as `pharmacies.clave_mostrador` and join against
  // `marzam_clients.clave_mostrador` (from `stg_marzam_detalle_mostrador.mostradores`).
  clave_mostrador: ['mostradores', 'clave_mostradores_marzam', 'clave_mostrador'],
  // Free-text vertical from Dataplor: "pharmacy", "drugstore", "doctor",
  // "medical_clinic", "medical_practice", …  Used to derive business_type.
  category: ['business_category', 'category', 'categoria'],
  // Pareto bucket as it ships from BlackPrint.  Kept as a candidate so the
  // legacy `int_marzam_prospect_scored` source keeps working — but on the
  // master_scored tables this is only populated for CLIENTs anyway.
  pareto: ['tier_clean', 'pareto', 'tier'],
  // Dataplor potential-of-sale score (0..100).  Canonical name on
  // master_scored is `final_score`; aliases cover legacy snapshots.
  final_score: ['final_score', 'composite_score', 'dataplor_100'],
  // Geocoding provider's confidence (0..1).  Only populated on CLIENT rows
  // in master_scored — Marzam doesn't ship real coordinates, so BlackPrint
  // geocodes the address and forwards the relevance score.
  // Note: master_scored ships the column as `geocode_relevance` (no trailing
  // 'd'); legacy snapshots used `geocoded_relevance`.  Both work via pickFirst.
  geocoded_relevance: ['geocoded_relevance', 'geocode_relevance'],
  neighborhood: ['neighborhood', 'colonia'],
  quadrant: ['quadrant'],
  // Address parts (populated on CLIENT rows when the canonical `address`
  // column is NULL — Marzam doesn't ship a single concatenated street, just
  // the components).  Used by composeAddress() as a fallback.
  street: ['calle'],
  street_number: ['num_ext', 'numero_exterior', 'numero'],
  // Marzam's CLIENT identifier in master_scored is literally `farmacia` —
  // already covered in COL_CANDIDATES.name above (pickFirst walks the list).
};

function __getCandidatesForInspector() { return COL_CANDIDATES; }

/**
 * Coerce whatever shape the source emits into the canonical 'Q1'..'Q4'
 * tokens the `pharmacies.quadrant` CHECK constraint expects.
 *
 * Accepted inputs (case/whitespace-insensitive):
 *   'Q1', 'q1', '1', 'Tier 1', 'T1', '  Q1  '          →  'Q1'
 *   'Q1_Stars', 'Q2_QuestionMarks', 'Q3_Risk', 'Q4_Skip'  →  'Q1'..'Q4'
 *   anything else                                       →  null
 *
 * The `Qn_Label` form ships in master_scored.
 */
function normalizeQuadrant(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().toUpperCase();
  // master_scored ships 'Q1_STARS' / 'Q2_QUESTIONMARKS' / 'Q3_RISK' /
  // 'Q4_SKIP'.  Match the leading Qn before the underscore.
  const labelMatch = cleaned.match(/^Q([1-4])(?:_|\b)/);
  if (labelMatch) return `Q${labelMatch[1]}`;
  // Fallback: legacy '1'..'4', 'Tier 1', etc.
  const stripped = cleaned.replace(/[^Q0-9]/g, '');
  const m = stripped.match(/Q?([1-4])/);
  return m ? `Q${m[1]}` : null;
}

/**
 * Coerce `tier_clean` / `pareto` / `tier` into 'A' / 'B' / 'C' or NULL.
 * Anything outside the canonical set becomes NULL so the CHECK constraint
 * on `pharmacies.pareto` never trips.
 */
function normalizePareto(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().toUpperCase();
  if (/^A$|^TIER[\s_]?A$|^PARETO[\s_]?A$|^1$/.test(cleaned)) return 'A';
  if (/^B$|^TIER[\s_]?B$|^PARETO[\s_]?B$|^2$/.test(cleaned)) return 'B';
  if (/^C$|^TIER[\s_]?C$|^PARETO[\s_]?C$|^3$/.test(cleaned)) return 'C';
  return null;
}

/**
 * Master_scored rows ship a `record_type` of 'CLIENT' or 'PROSPECT'.  For
 * back-compat with the legacy `int_marzam_prospect_scored` source we also
 * tolerate the boolean `cliente_marzam` flag.
 */
function isClientRow(raw, keyMap) {
  const rt = asString(pickFirst(raw, COL_CANDIDATES.record_type, keyMap));
  if (rt) return rt.trim().toUpperCase() === 'CLIENT';
  return asBool(pickFirst(raw, COL_CANDIDATES.is_marzam_client, keyMap)) === true;
}

/**
 * Pick `business_type` for a row.  Two signals, in order:
 *   1) the source table this row came from (passed in by the caller)
 *   2) `business_category` text — used as a tiebreaker / sanity check.
 *      pharmacy / drugstore → pharmacy.  doctor / medical_* / clinic → consultorio.
 */
function deriveBusinessType(raw, keyMap, sourceTableHint) {
  const cat = (asString(pickFirst(raw, COL_CANDIDATES.category, keyMap)) || '').toLowerCase();
  if (/pharm|drug|botica/.test(cat)) return 'pharmacy';
  if (/doctor|medic|consult|clinic/.test(cat)) return 'consultorio';
  return sourceTableHint || null;
}

// Tunable: rows per bulk-upsert round-trip. ~200 keeps each statement well
// under Postgres's 65535-bind-parameter limit (15 cols × 200 = 3000 binds)
// and gives us a good throughput/latency balance over the cross-region link
// to the BlackPrint Postgres.
const UPSERT_BATCH_SIZE = 200;

async function run({ limit = null } = {}) {
  const startedAt = Date.now();

  // Warm-up ping. The first write after a cold start frequently hits
  // ETIMEDOUT because knex's pool needs to establish a TLS handshake to the
  // GCP Postgres while we're already trying to push 200 rows through it.
  // A trivial SELECT lets the pool open a connection and keep it warm
  // before the bulk upsert hits.
  try {
    await db.raw('SELECT 1');
  } catch (err) {
    console.warn(`[bq-sync:${JOB_NAME}] warmup ping failed (${err.message}); continuing anyway`);
  }

  // Order matters for dedup: process farmacias first so the 202 CLIENT
  // rows that appear in both tables are written from the pharmacies side
  // (then the consultorios pass skips them via the dataplor_id seenIds set).
  const sources = [
    { table: BQ_TABLES.MASTER_SCORED_FARMACIAS,    typeHint: 'pharmacy' },
    { table: BQ_TABLES.MASTER_SCORED_CONSULTORIOS, typeHint: 'consultorio' },
  ];

  const stats = {
    rows: 0, inserted: 0, updated: 0, skipped: 0, by_source: {},
  };
  // PROSPECT rows are deduped by dataplor_id; CLIENT rows by clave_mostrador.
  // Two distinct seen-sets so a CLIENT and a PROSPECT can never collide.
  const seenDataplor = new Set();
  const seenClave = new Set();

  // Two queues — one per record type — because the upsert strategy
  // differs:
  //   PROSPECT → ON CONFLICT (dataplor_id)        — Dataplor-keyed
  //   CLIENT   → ON CONFLICT (clave_mostrador)    — Marzam-keyed
  // Each queue carries the source table so we can attribute counts.
  const prospectQueue = [];
  const clientQueue = [];

  for (const { table, typeHint } of sources) {
    const rows = await fetchAll(table, { limit }).catch((err) => {
      console.warn(`[bq-sync:${JOB_NAME}] failed to read ${table}: ${err.message}`);
      return [];
    });
    if (!rows.length) {
      stats.by_source[table] = { rows: 0, inserted: 0, updated: 0, skipped: 0 };
      continue;
    }
    const keyMap = buildKeyMap(rows[0]);
    stats.by_source[table] = { rows: rows.length, inserted: 0, updated: 0, skipped: 0 };
    stats.rows += rows.length;

    for (const raw of rows) {
      const isClient = isClientRow(raw, keyMap);
      const dataplorId = asString(pickFirst(raw, COL_CANDIDATES.dataplor_id, keyMap));
      const claveMostrador = asString(pickFirst(raw, COL_CANDIDATES.clave_mostrador, keyMap));

      // Pick the right canonical key + dedup set up front.  A row without a
      // usable key is unrecoverable — no way to upsert it idempotently.
      if (isClient) {
        if (!claveMostrador) {
          stats.by_source[table].skipped += 1;
          stats.skipped += 1;
          continue;
        }
        if (seenClave.has(claveMostrador)) {
          // CLIENT rows are byte-identical between farmacias and consultorios
          // (per Marzam: the 202 CLIENTs are pharmacies in both tables).
          // First writer wins — farmacias is processed first.
          stats.by_source[table].skipped += 1;
          continue;
        }
      } else {
        if (!dataplorId) {
          stats.by_source[table].skipped += 1;
          stats.skipped += 1;
          continue;
        }
        if (seenDataplor.has(dataplorId)) {
          stats.by_source[table].skipped += 1;
          continue;
        }
      }

      const name = asString(pickFirst(raw, COL_CANDIDATES.name, keyMap));
      if (!name) {
        stats.by_source[table].skipped += 1;
        stats.skipped += 1;
        continue;
      }

      const lat = asNumeric(pickFirst(raw, COL_CANDIDATES.lat, keyMap));
      const lng = asNumeric(pickFirst(raw, COL_CANDIDATES.lng, keyMap));

      const quadrant = normalizeQuadrant(asString(pickFirst(raw, COL_CANDIDATES.quadrant, keyMap)));
      const finalScore = asNumeric(pickFirst(raw, COL_CANDIDATES.final_score, keyMap));
      const businessType = deriveBusinessType(raw, keyMap, typeHint);

      // geocoded_relevance is only meaningful for CLIENT rows — Marzam
      // didn't ship lat/lng so BlackPrint geocoded their addresses and
      // attached the provider's relevance score.  For PROSPECT rows the
      // lat/lng comes directly from Dataplor (field-collected) so we
      // intentionally leave the column NULL — that NULL is the "trust
      // this point" signal the FE picks up.
      const geocodedRelevance = isClient
        ? asNumeric(pickFirst(raw, COL_CANDIDATES.geocoded_relevance, keyMap))
        : null;

      // pareto wiring (per business spec, revisited 2026-04-30):
      //   - For PROSPECTS: leave NULL.  The FE displays the *quadrant*
      //     mapped Q1→A, Q2→B, Q3→C, Q4→D as a cosmetic tier — that
      //     mapping never lands in the BD because A/B/C in pharmacies.pareto
      //     are reserved for real Marzam revenue classes.
      //   - For CLIENTS: write the source value if present (BlackPrint's
      //     own tier_clean), but it'll be overridden by syncDetalleMostrador
      //     via the clave_mostrador join with marzam_clients.pareto.  This
      //     gives us a sensible default if detalle_mostrador hasn't run yet.
      const pareto = isClient
        ? normalizePareto(asString(pickFirst(raw, COL_CANDIDATES.pareto, keyMap)))
        : null;

      const data = {
        // dataplor_id is NULL for CLIENT rows — that's expected per the
        // partial unique index (`WHERE dataplor_id IS NOT NULL`).
        dataplor_id: dataplorId || null,
        name,
        address: composeAddress(raw, keyMap),
        municipality: asString(pickFirst(raw, COL_CANDIDATES.municipality, keyMap)),
        state: asString(pickFirst(raw, COL_CANDIDATES.state, keyMap)),
        category: asString(pickFirst(raw, COL_CANDIDATES.category, keyMap)),
        business_type: businessType,
        source: isClient ? 'marzam' : 'blackprint',
        pareto,
        quadrant,
        final_score: finalScore,
        geocoded_relevance: geocodedRelevance,
        clave_mostrador: claveMostrador,
        lat,
        lng,
      };

      if (isClient) {
        clientQueue.push({ sourceTable: table, data });
        seenClave.add(claveMostrador);
      } else {
        prospectQueue.push({ sourceTable: table, data });
        seenDataplor.add(dataplorId);
      }
    }
  }

  // Bulk upsert each queue with its own conflict key.  Doing them in two
  // passes keeps the SQL statements simple — each ON CONFLICT clause
  // references exactly one inferred unique constraint.
  await runBulkUpsertLoop(prospectQueue, 'dataplor_id', stats);
  await runBulkUpsertLoop(clientQueue, 'clave_mostrador', stats);

  // Post-sync: quadrant derivation is now frozen weekly via
  // /api/admin/quadrants/snapshot (Vercel Cron, Sunday 02:00 CDMX) and read
  // from `quadrant_snapshot`. Mutating `pharmacies.quadrant_derived` on every
  // BQ sync used to shift the A/B/C/D tier of a prospect mid-week and break
  // any plan that referenced the live column. We keep the helper for ad-hoc
  // admin invocation but no longer call it from the sync.
  return { name: JOB_NAME, ...stats, quadrant_derived_updated: 0, duration_ms: Date.now() - startedAt };
}

/**
 * Compose a street address from whatever the source ships.
 *   - PROSPECT rows already have a single `address`/`direccion` string →
 *     use as-is.
 *   - CLIENT rows ship address parts separately (`calle`, `num_ext`,
 *     `colonia`) and have NULL `address` → join the parts.
 * Returns null if nothing usable is available.
 */
function composeAddress(raw, keyMap) {
  const direct = asString(pickFirst(raw, COL_CANDIDATES.address, keyMap));
  if (direct) return direct;
  const street = asString(pickFirst(raw, COL_CANDIDATES.street, keyMap));
  const number = asString(pickFirst(raw, COL_CANDIDATES.street_number, keyMap));
  const colonia = asString(pickFirst(raw, COL_CANDIDATES.neighborhood, keyMap));
  const parts = [];
  if (street) parts.push(number ? `${street} ${number}` : street);
  if (colonia) parts.push(`Col. ${colonia}`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Loop driver that batches a queue of {sourceTable, data} entries through
 * `bulkUpsertWithRetry`, falls back to row-by-row on hard failures, and
 * accumulates per-source insert/update/skipped counts into `stats`.
 *
 * `conflictKey` selects which partial unique index Postgres uses to detect
 * conflicts — `dataplor_id` for PROSPECT rows, `clave_mostrador` for CLIENT
 * rows.  Both indexes are partial (`WHERE col IS NOT NULL`), so the SQL
 * needs to mirror that predicate in the ON CONFLICT clause.
 */
async function runBulkUpsertLoop(queue, conflictKey, stats) {
  if (queue.length === 0) return;
  const label = conflictKey === 'dataplor_id' ? 'prospects' : 'clients';
  for (let i = 0; i < queue.length; i += UPSERT_BATCH_SIZE) {
    const slice = queue.slice(i, i + UPSERT_BATCH_SIZE);
    const data = slice.map((q) => q.data);
    let outcomes;
    try {
      outcomes = await bulkUpsertWithRetry(data, conflictKey, JOB_NAME);
    } catch (err) {
      console.warn(`[bq-sync:${JOB_NAME}] ${label} batch ${i / UPSERT_BATCH_SIZE} failed (${err.message}); retrying row-by-row`);
      outcomes = await fallbackPerRowUpsert(data, conflictKey, JOB_NAME);
    }
    for (let j = 0; j < outcomes.length; j += 1) {
      const sourceTable = slice[j].sourceTable;
      const outcome = outcomes[j]; // 'inserted' | 'updated' | 'skipped'
      stats[outcome] += 1;
      stats.by_source[sourceTable][outcome] += 1;
    }
    const done = Math.min(i + UPSERT_BATCH_SIZE, queue.length);
    process.stdout.write(`\r[bq-sync:${JOB_NAME}] upserted ${label} ${done}/${queue.length}…   `);
  }
  process.stdout.write('\n');
}

/**
 * Bulk INSERT … ON CONFLICT (<conflictKey>) DO UPDATE for an array of
 * already-normalised rows.  Returns one outcome per row, in input order:
 *   'inserted' — row was new
 *   'updated'  — row matched an existing <conflictKey>
 *
 * The `xmax = 0` predicate is the standard Postgres trick for telling apart
 * inserts from updates inside an upsert (xmax is the "deleting transaction
 * id" — for a fresh tuple it's always 0; for a row produced by the UPDATE
 * branch of ON CONFLICT it carries the txid that superseded the prior
 * version).
 *
 * Coordinates are inlined as ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
 * so the whole upsert lives in one statement (no extra UPDATE round-trip).
 * COALESCE on update means we keep the existing coordinates if a sync ever
 * comes through with NULL lat/lng — never blow away a known location.
 *
 * `conflictKey` ∈ {'dataplor_id', 'clave_mostrador'} — must be a column with
 * a partial UNIQUE index `WHERE col IS NOT NULL`.  Anything else will fail
 * Postgres's arbiter-index inference.
 */
async function bulkUpsert(rows, conflictKey = 'dataplor_id') {
  if (rows.length === 0) return [];
  if (conflictKey !== 'dataplor_id' && conflictKey !== 'clave_mostrador') {
    throw new Error(`Unsupported conflictKey: ${conflictKey}`);
  }

  const COLS = [
    'dataplor_id', 'name', 'address', 'municipality', 'state', 'category',
    'business_type', 'source', 'pareto', 'quadrant', 'final_score',
    'geocoded_relevance', 'clave_mostrador',
  ];
  // knex.raw uses positional `?` placeholders (NOT Postgres-style `$N`).
  // Both the bind array and the order of `?` in the SQL string must line up.
  const params = [];
  const valuesSql = [];

  for (const r of rows) {
    const placeholders = [];
    for (const col of COLS) {
      params.push(r[col] === undefined ? null : r[col]);
      placeholders.push('?');
    }
    if (r.lat !== null && r.lng !== null) {
      placeholders.push('ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography');
      params.push(r.lng);
      params.push(r.lat);
    } else {
      placeholders.push('NULL');
    }
    placeholders.push('NOW()'); // updated_at
    valuesSql.push(`(${placeholders.join(', ')})`);
  }

  const sql = `
    INSERT INTO pharmacies
      (${COLS.join(', ')}, coordinates, updated_at)
    VALUES
      ${valuesSql.join(', ')}
    ON CONFLICT (${conflictKey}) WHERE ${conflictKey} IS NOT NULL DO UPDATE SET
      name               = EXCLUDED.name,
      address            = EXCLUDED.address,
      municipality       = EXCLUDED.municipality,
      state              = EXCLUDED.state,
      category           = EXCLUDED.category,
      business_type      = EXCLUDED.business_type,
      source             = EXCLUDED.source,
      pareto             = EXCLUDED.pareto,
      quadrant           = EXCLUDED.quadrant,
      final_score        = EXCLUDED.final_score,
      geocoded_relevance = EXCLUDED.geocoded_relevance,
      -- Don't blow away an existing dataplor_id with NULL when a CLIENT
      -- row updates a pharmacy that BlackPrint later matched in Dataplor.
      dataplor_id        = COALESCE(EXCLUDED.dataplor_id, pharmacies.dataplor_id),
      clave_mostrador    = COALESCE(EXCLUDED.clave_mostrador, pharmacies.clave_mostrador),
      coordinates        = COALESCE(EXCLUDED.coordinates, pharmacies.coordinates),
      updated_at         = NOW()
    RETURNING id, (xmax = 0) AS was_inserted, ${conflictKey} AS conflict_key;
  `;

  const result = await db.raw(sql, params);
  // Map result back to input order using the conflict-key column. RETURNING
  // order is not guaranteed to match input order on an upsert.
  const byKey = new Map();
  for (const r of result.rows) {
    byKey.set(r.conflict_key, r.was_inserted ? 'inserted' : 'updated');
  }
  return rows.map((r) => byKey.get(r[conflictKey]) || 'skipped');
}

/**
 * One-shot retry around `bulkUpsert` for transient connection errors
 * (ETIMEDOUT, ECONNRESET, "Connection terminated unexpectedly", ...).
 * If a real data error fires (CHECK violation, type mismatch, ...) the
 * caller's catch will fall through to `fallbackPerRowUpsert` which will
 * isolate the bad row.
 */
async function bulkUpsertWithRetry(rows, conflictKey, jobName) {
  try {
    return await bulkUpsert(rows, conflictKey);
  } catch (err) {
    const transient = /ETIMEDOUT|ECONNRESET|Connection terminated|timeout|Connection ended/i.test(err.message || '');
    if (!transient) throw err;
    console.warn(`[bq-sync:${jobName}] transient error on batch (${err.message}); retrying once`);
    // Brief breather + a SELECT 1 so the pool reopens a connection rather
    // than handing us back the dead one.
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    try { await db.raw('SELECT 1'); } catch (_) { /* warmup best-effort */ }
    return bulkUpsert(rows, conflictKey);
  }
}

/**
 * Fallback used when a bulk upsert blows up (typically a CHECK-constraint
 * violation on a single bad row).  Inserts rows one-at-a-time so the bad
 * one gets isolated and we don't lose the other 199.
 */
async function fallbackPerRowUpsert(rows, conflictKey, jobName) {
  const outcomes = [];
  for (const r of rows) {
    try {
      const single = await bulkUpsert([r], conflictKey);
      outcomes.push(single[0] || 'skipped');
    } catch (err) {
      const id = r.dataplor_id || r.clave_mostrador || '?';
      console.warn(`[bq-sync:${jobName}] row ${id}: ${err.message}`);
      outcomes.push('skipped');
    }
  }
  return outcomes;
}

/**
 * Recalcula `pharmacies.quadrant_derived` mediante NTILE(4) sobre
 * `final_score DESC`, sólo para filas con score no-nulo y que sean parte
 * del universo de prospectos/clientes (`source IN ('blackprint','marzam')`).
 */
async function recomputeQuadrantDerived() {
  const result = await db.raw(`
    WITH ranked AS (
      SELECT
        id,
        NTILE(4) OVER (ORDER BY final_score DESC) AS bucket
      FROM pharmacies
      WHERE source IN ('blackprint', 'marzam')
        AND final_score IS NOT NULL
    )
    UPDATE pharmacies p
       SET quadrant_derived = 'Q' || r.bucket,
           updated_at = NOW()
      FROM ranked r
     WHERE p.id = r.id
       AND (p.quadrant_derived IS DISTINCT FROM 'Q' || r.bucket);
  `);
  const updated = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
  return { quadrant_derived_updated: updated };
}

module.exports = {
  run,
  JOB_NAME,
  __getCandidatesForInspector,
  normalizeQuadrant,
  normalizePareto,
  deriveBusinessType,
  isClientRow,
  recomputeQuadrantDerived,
};
