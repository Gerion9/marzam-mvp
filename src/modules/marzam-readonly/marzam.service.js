/**
 * Marzam read-only service.
 *
 * Why this exists:
 *   The full Marzam data model (`users`, `branches`, `marzam_clients`,
 *   `pharmacies`, `employee_profiles`) cannot be created in the current
 *   Postgres cluster because no user has CREATE privilege on any schema
 *   (verified 2026-04-29 — see docs/ROADMAP-PRODUCTION.md).
 *
 *   Until the migrations can run, this module exposes the four source
 *   tables (`josue_user` → integration/staging) directly, projected into
 *   the shapes the front-end expects, computed on the fly. Think of it
 *   as a "read-through cache" layer where the cache is in-memory and
 *   short-lived (TTL = 5 min by default).
 *
 *   Once migrations run (ROADMAP-PRODUCTION.md Phase 1), this layer should
 *   be deprecated in favor of the persisted model. The interfaces here
 *   intentionally mirror the persisted schema so the swap is mechanical.
 */

const { getMarzamSourceDb } = require('../../integrations/marzamSource/client');
const localDb = require('../../config/database');
const {
  BQ_TABLES,
  splitTable,
  buildKeyMap,
  pickFirst,
  asString,
  asInt,
  asNumeric,
  asBool,
} = require('../bq-sync/bqHelpers');
const { ROLES } = require('../../constants/roles');
const {
  rangoToRole,
  synthGerenteCode,
  tokenize,
  synthesizeEmail,
} = require('../bq-sync/jobs/syncCuadroBasico');

// In-memory cache for the heavy queries. Keep it small and explicit.
const TTL_MS = Number(process.env.MARZAM_READONLY_TTL_MS) || 5 * 60 * 1000;
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.v;
}

function setCached(key, v) {
  cache.set(key, { t: Date.now(), v });
  return v;
}

function clearCache() {
  cache.clear();
}

async function fetchFromSource(tableRef, columns = null) {
  const [schema, table] = splitTable(tableRef);
  const builder = getMarzamSourceDb().withSchema(schema).from(table);
  if (columns) builder.select(columns);
  else builder.select('*');
  return builder;
}

/**
 * Build the canonical user list from `int_marzam_cuadro_basico` augmented
 * with the (gerencia, supervisor) attribution derived from
 * `stg_marzam_detalle_mostrador`.
 *
 * Real Marzam clave convention (verified with stakeholder 2026-04-29):
 *
 *   - Director: NO aparece en cuadro_basico. Identificado por sucursal.
 *   - Gerente:  clave = 'GERENTE' literal (todos los gerentes comparten).
 *               Distinguidos por gerencia (UE, ME, ...) en detalle_mostrador.
 *   - Supervisor: clave = 3 letras + '00' (ej. 'UEA00'). LEFT(clave, 3)
 *               = supervisor_code; LEFT(clave, 2) = gerencia_code.
 *   - Representante: clave = supervisor_code + 2 dígitos (ej. 'UEA01').
 *
 * Returns an array of objects:
 * {
 *   employee_code:        'UEA06',     // canonical unique key
 *   clave_cuadro_basico:  'UEA06',     // literal clave from source
 *                                       // ('GERENTE' for managers, null
 *                                       //  for directors)
 *   agente_code:          'UEA06',     // for reps; null otherwise
 *   supervisor_code:      'UEA',       // 3-letter prefix
 *   gerencia_code:        'UE',        // 2-letter prefix
 *   manager_code:         'UEA',       // who I report to (= LEFT(my code, 3)
 *                                       //  for reps; LEFT(clave, 2) for sups;
 *                                       //  director's code for gerentes)
 *   manager_name:         'MONTES GOMEZ JOEL',
 *   branch_code:          'UE',
 *   branch_name:          'MERCADO LOPEZ ADRIANA',  (== gerente of branch)
 *   ...
 * }
 */
async function getRepresentatives() {
  const cached = getCached('reps');
  if (cached) return cached;

  // 1. cuadro_basico → all employees with their literal `clave`.
  const rawCuadro = await fetchFromSource(BQ_TABLES.CUADRO_BASICO);
  const km = rawCuadro.length ? buildKeyMap(rawCuadro[0]) : null;

  // 2. detalle_mostrador → distinct hierarchy attribution rows.
  const [schema, table] = splitTable(BQ_TABLES.DETALLE_MOSTRADOR);
  const triplets = await getMarzamSourceDb()
    .withSchema(schema)
    .from(table)
    .distinct('gerencia', 'gerente', 'supervisor', 'supervisor_nombre', 'agente', 'representante')
    .whereNotNull('gerencia');

  // Build several lookup maps from detalle_mostrador.
  const repAttr = new Map();        // agente_code → attribution
  const supervisorAttr = new Map(); // supervisor_code (3-letter) → { gerencia_code, supervisor_name }
  const gerenciaToGerente = new Map(); // gerencia_code → gerente_name (last non-null wins)
  for (const t of triplets) {
    const gerenciaCode = asString(t.gerencia);
    const gerenteName = asString(t.gerente);
    if (gerenciaCode && gerenteName && gerenteName !== 'VACANTE') {
      gerenciaToGerente.set(gerenciaCode, gerenteName);
    }
    if (t.supervisor) {
      const sCode = asString(t.supervisor);
      if (sCode && !supervisorAttr.has(sCode)) {
        supervisorAttr.set(sCode, {
          gerencia_code: gerenciaCode,
          supervisor_name: asString(t.supervisor_nombre) === 'VACANTE'
            ? null : asString(t.supervisor_nombre),
        });
      }
    }
    if (t.agente) {
      const aCode = asString(t.agente);
      if (aCode && !repAttr.has(aCode)) {
        repAttr.set(aCode, {
          gerencia_code: gerenciaCode,
          gerente_name: gerenteName === 'VACANTE' ? null : gerenteName,
          supervisor_code: asString(t.supervisor),
          supervisor_name: asString(t.supervisor_nombre) === 'VACANTE'
            ? null : asString(t.supervisor_nombre),
        });
      }
    }
  }

  // Reverse lookup: gerente full_name → gerencia code (so we can resolve
  // 'GERENTE' rows in cuadro_basico to a unique gerencia identifier).
  const gerenteNameToGerencia = new Map();
  for (const [g, name] of gerenciaToGerente.entries()) {
    if (name) gerenteNameToGerencia.set(name.trim().toUpperCase(), g);
  }

  // 3. Project each cuadro_basico row into the canonical user shape.
  const out = [];
  const seenGerentes = new Set();
  for (const raw of rawCuadro) {
    const claveLiteral = asString(pickFirst(raw, ['clave', 'employee_code'], km));
    if (!claveLiteral) continue;
    const fullName = asString(pickFirst(raw, ['nombre_del_empleado', 'nombre'], km)) || claveLiteral;
    const rangoRaw = asString(pickFirst(raw, ['rango'], km));
    const role = rangoToRole(rangoRaw) || ROLES.REPRESENTANTE;

    let employeeCode = claveLiteral;
    let agenteCode = null;
    let supervisorCode = null;
    let gerenciaCode = null;
    let managerCode = null;
    let managerName = null;
    let branchCode = null;
    let branchName = null;

    if (role === ROLES.GERENTE_VENTAS || claveLiteral === 'GERENTE') {
      // Multiple rows share clave='GERENTE'; identify via name → gerencia map.
      const upper = String(fullName || '').trim().toUpperCase();
      gerenciaCode = gerenteNameToGerencia.get(upper) || null;
      if (gerenciaCode) {
        employeeCode = gerenciaCode; // unique per gerencia
      } else {
        // Last-resort fallback: synthesize from name.
        employeeCode = synthGerenteCode(fullName);
      }
      if (seenGerentes.has(employeeCode)) continue;
      seenGerentes.add(employeeCode);
      branchCode = gerenciaCode;
      branchName = fullName;
      managerCode = null; // director resolved separately (not in cuadro_basico)
      managerName = null;
    } else if (role === ROLES.SUPERVISOR
        || (claveLiteral.length === 5 && claveLiteral.endsWith('00'))) {
      // Supervisor: clave = 3 letters + '00'. LEFT(clave, 3) is the
      // supervisor code that reps reference in their agente field.
      supervisorCode = claveLiteral.slice(0, 3);
      gerenciaCode = claveLiteral.slice(0, 2);
      employeeCode = claveLiteral;
      managerCode = gerenciaCode;
      managerName = gerenciaToGerente.get(gerenciaCode) || null;
      branchCode = gerenciaCode;
      branchName = managerName;
    } else {
      // Representante: clave = agente_code (e.g., 'UEA01').
      agenteCode = claveLiteral;
      const attribution = repAttr.get(claveLiteral) || {};
      supervisorCode = attribution.supervisor_code || claveLiteral.slice(0, 3);
      gerenciaCode = attribution.gerencia_code || claveLiteral.slice(0, 2);
      employeeCode = claveLiteral;
      managerCode = supervisorCode;
      managerName = attribution.supervisor_name || null;
      branchCode = gerenciaCode;
      branchName = attribution.gerente_name || gerenciaToGerente.get(gerenciaCode) || null;
    }

    out.push({
      employee_code: employeeCode,
      clave_cuadro_basico: claveLiteral,
      agente_code: agenteCode,
      supervisor_code: supervisorCode,
      gerencia_code: gerenciaCode,
      employee_number: asString(pickFirst(raw, ['no_empleado'], km)),
      email: synthesizeEmail(employeeCode),
      full_name: fullName,
      role,
      manager_code: managerCode,
      manager_name: managerName,
      branch_code: branchCode,
      branch_name: branchName,
      poblacion: asString(pickFirst(raw, ['zona_poblaciones', 'poblacion'], km)),
      zona: asString(pickFirst(raw, ['zonas', 'zona'], km)),
      estatus: asString(pickFirst(raw, ['estatus', 'status'], km)),
      profile: {
        celular: asString(pickFirst(raw, ['celular'], km)),
        telefono: asString(pickFirst(raw, ['telefono_particular', 'telefono'], km)),
        domicilio: asString(pickFirst(raw, ['domicilio_particular', 'domicilio'], km)),
        imei: asString(pickFirst(raw, ['imei'], km)),
        marca: asString(pickFirst(raw, ['marca'], km)),
        modelo: asString(pickFirst(raw, ['modelo'], km)),
      },
    });
  }

  return setCached('reps', out);
}

/**
 * Returns one row per gerencia (branch) with the manager name and
 * the count of supervisors and reps under it.
 */
async function getBranches() {
  const cached = getCached('branches');
  if (cached) return cached;

  const reps = await getRepresentatives();

  // Aggregate by branch_code
  const byBranch = new Map();
  for (const r of reps) {
    const bc = r.branch_code;
    if (!bc) continue;
    if (!byBranch.has(bc)) {
      byBranch.set(bc, {
        code: bc, name: r.branch_name || bc,
        manager_employee_codes: new Set(),
        supervisors: new Set(),
        reps_count: 0,
      });
    }
    const bucket = byBranch.get(bc);
    if (r.role === ROLES.GERENTE_VENTAS) bucket.manager_employee_codes.add(r.employee_code);
    if (r.manager_code) bucket.supervisors.add(r.manager_code);
    if (r.role === ROLES.REPRESENTANTE) bucket.reps_count += 1;
  }

  const out = [...byBranch.values()].map((b) => ({
    code: b.code,
    name: b.name,
    manager_employee_codes: [...b.manager_employee_codes],
    supervisor_codes: [...b.supervisors],
    supervisor_count: b.supervisors.size,
    reps_count: b.reps_count,
  })).sort((a, b) => a.code.localeCompare(b.code));

  return setCached('branches', out);
}

/**
 * Marzam clients projected from `stg_marzam_detalle_mostrador`, optionally
 * filtered by the requesting user's scope (rep sees only its agente=clave;
 * supervisor sees its three-letter prefix; gerente sees all in the gerencia).
 *
 * @param {object} scope { role, employeeCode } or null for all clients.
 */
async function getClients(scope = null, { limit = null } = {}) {
  const cacheKey = `clients:${scope?.role || 'all'}:${scope?.employeeCode || 'all'}:${limit || 'none'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [schema, table] = splitTable(BQ_TABLES.DETALLE_MOSTRADOR);
  const builder = getMarzamSourceDb().withSchema(schema).from(table).select(
    'cpadre', 'farmacia', 'direccion', 'delegacion_municipio', 'poblacion',
    'pareto', 'perfil', 'unefarm', 'independiente', 'contact_center',
    'mostradores', 'cliente_visita', 'ruta', 'liberacion_de_ruta',
    'representante', 'agente',
    'gerencia', 'gerente', 'supervisor', 'supervisor_nombre',
    'acumulado', 'avance', 'objetivo_o_presupuesto', 'devoluciones',
  );

  if (scope && scope.role) {
    if (scope.role === ROLES.REPRESENTANTE && scope.employeeCode) {
      builder.where({ agente: scope.employeeCode });
    } else if (scope.role === ROLES.SUPERVISOR && (scope.supervisorCode || scope.employeeCode)) {
      // El supervisor tiene clave UEA00 (5 chars). Sus reps son UEA01/02/...
      // Filtramos por LEFT(agente, 3) = supervisorCode (UEA), o si no
      // viene en scope, derivamos de employeeCode.
      const supCode = scope.supervisorCode || scope.employeeCode.slice(0, 3);
      builder.whereRaw('LEFT(agente, 3) = ?', [supCode]);
    } else if (scope.role === ROLES.GERENTE_VENTAS) {
      // El gerente ve todo lo de su gerencia (UE, ME, ...). gerenciaCode
      // viene del JWT/branch_code. Si no, derivamos de employee_code.
      const gerCode = scope.gerenciaCode
        || (scope.employeeCode && scope.employeeCode.length >= 2
          ? scope.employeeCode.slice(0, 2)
          : null);
      if (gerCode) builder.where({ gerencia: gerCode });
    }
    // director_sucursal: NO filter — ve todas las farmacias del padrón.
  }

  if (limit) builder.limit(Math.trunc(Number(limit)));

  const raw = await builder;
  const out = raw.map((r) => ({
    cpadre: asString(r.cpadre),
    farmacia_nombre: asString(r.farmacia),
    direccion: asString(r.direccion),
    delegacion_municipio: asString(r.delegacion_municipio),
    poblacion: asString(r.poblacion),
    pareto: asString(r.pareto),
    perfil: asString(r.perfil),
    unefarm: asBool(r.unefarm),
    is_independent: asBool(r.independiente),
    contact_center: asBool(r.contact_center),
    mostradores: asInt(r.mostradores),
    cliente_visita: asString(r.cliente_visita),
    ruta: asString(r.ruta),
    rep_code: asString(r.agente),
    rep_name: asString(r.representante),
    supervisor_code: asString(r.supervisor),
    supervisor_name: asString(r.supervisor_nombre) === 'VACANTE' ? null : asString(r.supervisor_nombre),
    gerencia_code: asString(r.gerencia),
    gerente_name: asString(r.gerente) === 'VACANTE' ? null : asString(r.gerente),
    sales: {
      acumulado: asNumeric(r.acumulado),
      objetivo: asNumeric(r.objetivo_o_presupuesto),
      avance: asNumeric(r.avance),
      devoluciones: asNumeric(r.devoluciones),
    },
  }));

  return setCached(cacheKey, out);
}

/**
 * GET /api/marzam/universe — devuelve TODO el universo de farmacias
 * (Marzam + prospectos) desde la tabla LOCAL `pharmacies`, ya con
 * coordenadas geocodificadas por el sync de `int_marzam_prospect_scored`.
 *
 * Diferencia clave con `getClients()`:
 *   - getClients() lee del BQ source (`stg_marzam_detalle_mostrador`),
 *     no tiene lat/lng → no se puede pintar en mapa.
 *   - getUniverse() lee de la BD local persistida → SÍ tiene lat/lng,
 *     pareto, quadrant, final_score, etc.  Listo para el FE.
 *
 * Filtra automáticamente las filas sin coordenadas (no se pueden
 * renderizar en mapa).
 *
 * @param {object} opts
 * @param {number} [opts.limit=5000]
 * @param {{west,south,east,north}} [opts.bbox]
 */
async function getUniverse({ limit = 5000, bbox = null } = {}) {
  const cacheKey = `universe:${limit}:${bbox ? JSON.stringify(bbox) : 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Usamos ST_X / ST_Y para extraer lat/lng del campo geography.  Con
  // bbox usamos el operador `&&` que aprovecha el GIST index — sin él
  // sería una secuencia completa por toda la tabla.
  const params = [];
  let bboxClause = '';
  if (bbox) {
    bboxClause = `
      AND coordinates && ST_MakeEnvelope(?, ?, ?, ?, 4326)::geography
    `;
    params.push(bbox.west, bbox.south, bbox.east, bbox.north);
  }
  params.push(limit);

  const { rows } = await localDb.raw(`
    SELECT
      id,
      name,
      address,
      municipality,
      state,
      source,
      pareto,
      quadrant,
      final_score,
      dataplor_id,
      clave_mostrador,
      category,
      business_type,
      geocoded_relevance,
      ST_Y(coordinates::geometry)::float8 AS lat,
      ST_X(coordinates::geometry)::float8 AS lng
    FROM pharmacies
    WHERE coordinates IS NOT NULL
      AND source IN ('marzam', 'blackprint')
      ${bboxClause}
    ORDER BY source DESC, pareto NULLS LAST
    LIMIT ?
  `, params);

  const marzam = [];
  const prospects = [];
  for (const r of rows) {
    const item = {
      id: r.id,
      name: r.name,
      address: r.address,
      municipality: r.municipality,
      state: r.state,
      source: r.source,
      pareto: r.pareto,
      quadrant: r.quadrant,
      final_score: r.final_score != null ? Number(r.final_score) : null,
      dataplor_id: r.dataplor_id,
      clave_mostrador: r.clave_mostrador,
      category: r.category,
      // Derive business_type if the column hasn't been backfilled yet by
      // the sync — keeps `/api/marzam/universe` working on stale data.
      business_type: r.business_type
        || (r.category && /pharm|drug|botica/i.test(r.category) ? 'pharmacy'
          : r.category && /doctor|medic|consult|clinic/i.test(r.category) ? 'consultorio'
            : null),
      // 0..1 confidence from BlackPrint's geocoder.  NULL ⇒ field-collected
      // coordinates (Dataplor) — the FE renders the dot without a warning.
      geocoded_relevance: r.geocoded_relevance != null ? Number(r.geocoded_relevance) : null,
      lat: r.lat,
      lng: r.lng,
    };
    if (r.source === 'marzam') marzam.push(item);
    else prospects.push(item);
  }

  const out = {
    total: rows.length,
    marzam,
    prospects,
    bbox_applied: !!bbox,
    truncated: rows.length === limit,
  };
  return setCached(cacheKey, out);
}

/**
 * Health/audit summary used by /api/marzam/diagnostics.
 */
async function getDiagnostics() {
  const reps = await getRepresentatives();
  const branches = await getBranches();
  const counts = {
    director_sucursal: 0, gerente_ventas: 0, supervisor: 0, representante: 0, other: 0,
  };
  for (const r of reps) {
    counts[r.role] = (counts[r.role] || 0) + 1;
  }
  return {
    source_db_host: process.env.MARZAM_SOURCE_DB_HOST || process.env.DB_HOST,
    cache_ttl_ms: TTL_MS,
    counts: {
      total_employees: reps.length,
      by_role: counts,
      total_branches: branches.length,
      total_supervisors_distinct: new Set(reps.map((r) => r.manager_code).filter(Boolean)).size,
    },
  };
}

module.exports = {
  getRepresentatives,
  getBranches,
  getClients,
  getUniverse,
  getDiagnostics,
  clearCache,
};
