/**
 * Demo read-only middleware.
 *
 * Cualquier usuario con `data_scope === 'demo'` o email `@demo.marzam.mx`
 * tiene su sesión "blindada": las llamadas POST/PUT/PATCH/DELETE NO tocan
 * la base de datos. En su lugar respondemos con un payload sintético que
 * imita la forma del recurso solicitado, para que el frontend siga su
 * flujo normal (mostrar toasts de éxito, refrescar listas, etc.) sin
 * persistir cambios.
 *
 * Esto complementa la interceptación que ya existe en el frontend
 * (demo.js / demoHierarchy.js) — sirve como red de seguridad: si alguien
 * llama al backend directamente con un token demo (curl, otro front), no
 * se modifica la BD productiva.
 *
 * Excepciones:
 *   - GET / HEAD / OPTIONS pasan siempre (lecturas).
 *   - /api/auth/login, /api/auth/me, /api/auth/impersonate* pasan siempre
 *     (necesarias para el flujo de sesión).
 *   - /api/health pasa siempre (no requiere auth).
 *
 * El middleware se monta DESPUÉS de `authenticate` en cada router de
 * escritura. La opción más limpia sería montarlo en `src/app.js`
 * post-routing, pero express valora orden de registro: lo aplicamos
 * antes de los routers de escritura para corto-circuitar.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALWAYS_ALLOW_PATHS = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/impersonate',
  '/api/auth/impersonate/stop',
  '/api/health',
  // Pure computation — no DB writes. Safe for demo users; enables routing sandbox.
  '/api/visit-plans/preview-routing',
];

function isDemoUser(user) {
  if (!user) return false;
  if (user.data_scope === 'demo') return true;
  if (typeof user.email === 'string' && user.email.endsWith('@demo.marzam.mx')) return true;
  return false;
}

/**
 * Como este middleware corre ANTES de `authenticate` (a nivel
 * /api/), `req.user` aún no existe. Decodificamos el JWT acá mismo
 * — silenciosamente — solo para detectar si la sesión es demo. Si
 * el token es inválido no hacemos nada: deja que el `authenticate`
 * de cada router lo rechace con 401.
 */
function readDemoFromToken(req) {
  if (req.user) return isDemoUser(req.user);
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return (
      payload.data_scope === 'demo' ||
      (typeof payload.email === 'string' && payload.email.endsWith('@demo.marzam.mx'))
    );
  } catch {
    return false;
  }
}

function alwaysAllow(path) {
  if (!path) return false;
  return ALWAYS_ALLOW_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Construye una respuesta sintética para writes en demo. La forma se
 * elige por método: POST suele crear → echo body con id sintético;
 * PATCH/PUT → echo body; DELETE → ack. Si el cliente espera un shape
 * más específico, mejor manejarlo en el frontend (ya lo hace).
 */
function buildMockResponse(req) {
  const method = (req.method || '').toUpperCase();
  const body = req.body || {};
  const now = new Date().toISOString();
  const fakeId = `demo_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

  if (method === 'DELETE') {
    return { ok: true, demo: true, deleted: true, demo_note: 'Cambio simulado · no persistido en BD' };
  }
  if (method === 'POST') {
    return {
      id: body.id || fakeId,
      ...body,
      _demo: true,
      _demo_note: 'Cambio simulado · no persistido en BD',
      created_at: now,
    };
  }
  // PATCH / PUT
  return {
    id: body.id || (req.params && req.params.id) || fakeId,
    ...body,
    _demo: true,
    _demo_note: 'Cambio simulado · no persistido en BD',
    updated_at: now,
  };
}

function demoReadonly(req, res, next) {
  const method = (req.method || '').toUpperCase();
  if (READ_METHODS.has(method)) return next();
  if (alwaysAllow(req.originalUrl || req.url || req.path)) return next();
  if (!readDemoFromToken(req)) return next();

  // Demo user trying to write — short-circuit with a synthetic response.
  const mock = buildMockResponse(req);
  res.set('X-Demo-Mode', 'readonly');
  return res.status(200).json(mock);
}

module.exports = demoReadonly;
module.exports.isDemoUser = isDemoUser;
