const service = require('./marzam.service');
const { ROLES, normalizeRole } = require('../../constants/roles');

// Source DB es opcional en deployments que ya hidrataron `marzam_app` a partir
// del sync (181 users, 32 marzam_clients). Si la conexión falla por env vars
// missing o red caída, este módulo prefiere responder 200 con payload vacío
// + header de warning para no romper al FE (que ya consume con `.catch(() => [])`).
// Sin este wrapper la ruta cae con 500 y deja la pantalla principal en blanco.
function isSourceDbUnavailable(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (/Marzam source DB is not configured/i.test(msg)) return true;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') return true;
  if (/password authentication failed|no pg_hba\.conf|connect ETIMEDOUT/i.test(msg)) return true;
  return false;
}

function respondSourceUnavailable(res, payload) {
  res.setHeader('X-Marzam-Source', 'unavailable');
  return res.json({ ...payload, source: 'unavailable', warning: 'Marzam source DB no configurada en este deployment' });
}

/**
 * Construye el scope de visibilidad del usuario que llama. La lógica de
 * filtrado por rol vive en marzam.service.getClients() y otras funciones
 * de este módulo: aquí solo extraemos los códigos crudos del JWT/empleado.
 *
 * Reglas:
 *   - director_sucursal: NO se filtra. Ve todo. (scope.role = director, sin códigos)
 *   - gerente_ventas: filtra por gerencia_code (UE, ME, ...). El JWT trae
 *     `branch_code` = gerencia. Si no, intentamos derivar de employee_code.
 *   - supervisor: filtra por LEFT(agente, 3) = supervisor_code. El JWT trae
 *     `employee_code` con clave_cuadro_basico (ej. UEA00). LEFT(_, 3) = UEA.
 *   - representante: filtra por agente = employee_code (clave del rep).
 *
 * Si el JWT está incompleto (token viejo), intentamos derivar del email
 * `<code>@marzam.mx` o devolvemos role=null para que el llamante decida
 * (típicamente listRepresentatives devuelve todo en ese caso).
 */
function buildScope(req) {
  if (!req.user) return null;
  const role = normalizeRole(req.user.role);

  // Director: scope global, sin filtro de gerencia/supervisor/agente.
  if (role === ROLES.DIRECTOR_SUCURSAL || req.user.is_global) {
    return { role: ROLES.DIRECTOR_SUCURSAL, employeeCode: null, gerenciaCode: null, supervisorCode: null };
  }

  const fromToken = req.user.employee_code
    || req.user.employeeCode
    || (req.user.email && req.user.email.endsWith('@marzam.mx')
      ? req.user.email.split('@')[0].toUpperCase()
      : null);

  // Gerencia code:
  //   - gerente: branch_code (en JWT) o LEFT(employee_code, 2) si tiene formato.
  //   - supervisor/rep: LEFT(employee_code, 2) — UEA00 → UE, UEA01 → UE.
  let gerenciaCode = req.user.branch_code || null;
  if (!gerenciaCode && fromToken && fromToken.length >= 2 && fromToken !== 'GERENTE') {
    gerenciaCode = fromToken.slice(0, 2);
  }

  // Supervisor code (3 letras):
  //   - supervisor (clave UEA00): LEFT(_, 3) = UEA
  //   - rep (clave UEA01): LEFT(_, 3) = UEA (su supervisor)
  let supervisorCode = null;
  if (fromToken && fromToken.length >= 3 && fromToken !== 'GERENTE') {
    supervisorCode = fromToken.slice(0, 3);
  }

  return { role, employeeCode: fromToken, gerenciaCode, supervisorCode };
}

async function listRepresentatives(req, res, next) {
  try {
    let all;
    try {
      all = await service.getRepresentatives();
    } catch (err) {
      if (isSourceDbUnavailable(err)) return respondSourceUnavailable(res, { total: 0, reps: [] });
      throw err;
    }
    const scope = buildScope(req);

    let filtered = all;
    if (!scope) {
      // No auth — devuelve todo (caso de demo/external)
      filtered = all;
    } else if (scope.role === ROLES.DIRECTOR_SUCURSAL) {
      // Director: ve todos los empleados de la sucursal (toda la jerarquía).
      filtered = all;
    } else if (scope.role === ROLES.GERENTE_VENTAS && scope.gerenciaCode) {
      // Gerente: ve a sí mismo + supervisores + reps de su gerencia.
      filtered = all.filter((r) => r.gerencia_code === scope.gerenciaCode);
    } else if (scope.role === ROLES.SUPERVISOR && scope.supervisorCode) {
      // Supervisor: ve a sí mismo + reps bajo su supervisión.
      filtered = all.filter((r) =>
        r.employee_code === scope.employeeCode ||
        r.supervisor_code === scope.supervisorCode ||
        r.manager_code === scope.supervisorCode);
    } else if (scope.role === ROLES.REPRESENTANTE && scope.employeeCode) {
      // Rep: solo su propio registro.
      filtered = all.filter((r) => r.employee_code === scope.employeeCode);
    }

    res.json({
      total: filtered.length,
      reps: filtered.map((r) => ({ ...r, profile: undefined })),
    });
  } catch (e) {
    next(e);
  }
}

async function getMyProfile(req, res, next) {
  try {
    let all;
    try {
      all = await service.getRepresentatives();
    } catch (err) {
      if (isSourceDbUnavailable(err)) {
        // Director sin source DB todavía puede recibir su perfil sintético del JWT.
        if (req.user && (normalizeRole(req.user.role) === ROLES.DIRECTOR_SUCURSAL || req.user.is_global)) {
          return res.json({
            employee_code: req.user.branch_code || 'EC',
            full_name: req.user.full_name || 'Director',
            email: req.user.email,
            role: ROLES.DIRECTOR_SUCURSAL,
            gerencia_code: null,
            branch_code: req.user.branch_code || 'EC',
            branch_name: 'Sucursal Ecatepec',
            source: 'jwt-fallback',
          });
        }
        return respondSourceUnavailable(res, {});
      }
      throw err;
    }
    const scope = buildScope(req);
    if (!scope || !scope.employeeCode) {
      // Director no tiene clave en cuadro_basico — devolver perfil mínimo
      // tomado del JWT en lugar de 404, para que el frontend no rompa.
      if (scope && scope.role === ROLES.DIRECTOR_SUCURSAL && req.user) {
        return res.json({
          employee_code: req.user.branch_code || 'EC',
          full_name: req.user.full_name || 'Director',
          email: req.user.email,
          role: ROLES.DIRECTOR_SUCURSAL,
          gerencia_code: null,
          branch_code: req.user.branch_code || 'EC',
          branch_name: 'Sucursal Ecatepec',
        });
      }
      return res.status(404).json({ error: 'No employee_code resolvable from token' });
    }
    const me = all.find((r) => r.employee_code === scope.employeeCode);
    if (!me) return res.status(404).json({ error: 'Employee not found in cuadro_basico' });
    return res.json(me);
  } catch (e) {
    return next(e);
  }
}

async function listBranches(_req, res, next) {
  try {
    const branches = await service.getBranches();
    res.json({ total: branches.length, branches });
  } catch (e) {
    if (isSourceDbUnavailable(e)) return respondSourceUnavailable(res, { total: 0, branches: [] });
    next(e);
  }
}

async function listClients(req, res, next) {
  try {
    const scope = buildScope(req);
    const limit = req.query.limit ? Math.max(0, Math.min(5000, Number(req.query.limit))) : null;
    const data = await service.getClients(scope, { limit });
    res.json({ total: data.length, clients: data });
  } catch (e) {
    if (isSourceDbUnavailable(e)) return respondSourceUnavailable(res, { total: 0, clients: [] });
    next(e);
  }
}

/**
 * GET /api/marzam/universe
 *
 * Devuelve el universo completo de farmacias (Marzam + prospectos) DESDE
 * LA BD LOCAL `pharmacies` (no BQ).  Ya están geocodificadas vía el sync
 * de `int_marzam_prospect_scored`, así que el FE puede pintarlas
 * directamente sin pasar por geocoding.
 *
 * Query params:
 *   ?bbox=west,south,east,north   filtra por bounding box (degrees)
 *   ?limit=N                      tope (default 5000, max 50000)
 *
 * Shape:
 *   {
 *     total: 1500,
 *     marzam:    [{ id, name, lat, lng, pareto, dataplor_id, ... }],
 *     prospects: [{ id, name, lat, lng, pareto, tier_clean, ... }]
 *   }
 *
 * Auth: requiere JWT (mismo que listClients).  El scope NO se aplica
 * porque el universo geográfico es público para cualquier rep — la
 * herramienta de territorio se filtra cliente-side por viewport.
 */
async function listUniverse(req, res, next) {
  try {
    const limit = req.query.limit
      ? Math.max(0, Math.min(50000, Number(req.query.limit)))
      : 5000;
    const bbox = parseBbox(req.query.bbox);
    const userScope = req.query.scope === 'mine' && req.user
      ? {
        userId: req.user.id,
        role: req.user.role,
        isGlobal: !!req.user.is_global,
      }
      : null;
    const data = await service.getUniverse({ limit, bbox, userScope });
    res.json(data);
  } catch (e) {
    if (isSourceDbUnavailable(e)) return respondSourceUnavailable(res, { total: 0, marzam: [], prospects: [] });
    next(e);
  }
}

function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

async function getDiagnostics(_req, res, next) {
  try {
    const out = await service.getDiagnostics();
    res.json({ ok: true, ...out });
  } catch (e) {
    if (isSourceDbUnavailable(e)) {
      return res.status(200).json({
        ok: false,
        source: 'unavailable',
        warning: 'Marzam source DB no configurada — endpoints marzam-readonly devuelven payload vacío',
        source_db_host: process.env.MARZAM_SOURCE_DB_HOST || process.env.DB_HOST || null,
      });
    }
    next(e);
  }
}

async function clearCache(_req, res, next) {
  try {
    service.clearCache();
    res.json({ ok: true, cleared: true });
  } catch (e) {
    next(e);
  }
}

// Marzam Execution Doc §9 — daily/rolling sales summary keyed by Marzam
// internal customer ID. Reads from `mv_pharmacy_sales_rollups`; degrades
// gracefully if the MV doesn't exist yet (returns empty list + warning).
async function salesSummary(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const out = await service.getSalesSummary({ limit });
    res.json(out);
  } catch (e) { next(e); }
}

module.exports = {
  listRepresentatives,
  listBranches,
  listClients,
  listUniverse,
  getMyProfile,
  getDiagnostics,
  clearCache,
  salesSummary,
};
