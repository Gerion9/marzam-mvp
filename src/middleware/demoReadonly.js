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

// In-memory counters for BlackPrint usage-metrics. Per-process; sums across
// Vercel instances are approximate. Surfaced via getDemoMetrics().
const demoMetrics = {
  blocked_writes: 0,        // POST/PUT/PATCH/DELETE answered with synthetic mock
  passthrough_reads: 0,     // GET/HEAD/OPTIONS from a demo user (we let through)
  whitelisted_writes: 0,    // login/logout/etc bypass — counted to confirm whitelist works
  started_at: new Date().toISOString(),
};

function getDemoMetrics() {
  return { ...demoMetrics };
}

// [S11] Cache the DB-side demo flag per user so we don't pay a query on every
// write request. 60s TTL is small enough that flipping a user out of demo in
// the DB is reflected within a minute, and large enough to amortize lookups.
// Map keyed by user id (UUID string). Bounded — pruned when oversized.
const DEMO_CACHE_TTL_MS = 60 * 1000;
const DEMO_CACHE_MAX = 1000;
const demoCache = new Map();

function readDemoFromCache(userId) {
  const hit = demoCache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > DEMO_CACHE_TTL_MS) {
    demoCache.delete(userId);
    return null;
  }
  return hit.isDemo;
}

function writeDemoCache(userId, isDemo) {
  if (demoCache.size >= DEMO_CACHE_MAX) {
    // Drop the oldest entries — Map preserves insertion order.
    const drop = Math.ceil(DEMO_CACHE_MAX / 4);
    let i = 0;
    for (const k of demoCache.keys()) {
      if (i++ >= drop) break;
      demoCache.delete(k);
    }
  }
  demoCache.set(userId, { isDemo, at: Date.now() });
}

async function dbDemoFlag(userId) {
  // Lazy-require to avoid pulling the knex pool into smoke contexts where
  // demoReadonly is required but never invoked against a live DB.
  // eslint-disable-next-line global-require
  const db = require('../config/database');
  try {
    const row = await db('users')
      .where({ id: userId })
      .select('data_scope', 'email')
      .first();
    if (!row) return false;
    if (row.data_scope === 'demo') return true;
    if (typeof row.email === 'string' && row.email.endsWith('@demo.marzam.mx')) return true;
    return false;
  } catch (err) {
    // Fail-open on the *lookup* — the JWT-side check still runs, which is the
    // primary control. Logged so ops sees when DB is degraded.
    console.warn('[demoReadonly] DB lookup failed (' + err.message + '), falling back to JWT-only');
    return null;
  }
}

const ALWAYS_ALLOW_PATHS = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/impersonate',
  '/api/auth/impersonate/stop',
  '/api/health',
  // Pure computation — no DB writes. Safe for demo users; enables routing sandbox.
  '/api/visit-plans/preview-routing',
  // Read-only previews: a pesar de ser POST (porque mandan body con scope/period),
  // NO persisten nada — solo calculan el plan o el costo estimado y retornan.
  // Bloquearlos rompe la UX del demo (Plan Editor muestra "Sin visitas generadas"
  // porque el middleware retorna un mock que no tiene assignments). El frontend
  // (demoHierarchy.js) los intercepta cuando `me` resuelve, pero cuando el
  // usuario demo es un overlay sobre un user con UUID real (o `me` queda null
  // por race con DEMO_H.ready), la request cae al backend — y debe poder
  // ejecutar el preview real para que el editor muestre rutas.
  '/api/visit-plans/preview-full',
  '/api/visit-plans/preview/cost-estimate',
  '/api/visit-plans/preview',
];

function isDemoUser(user) {
  if (!user) return false;
  if (user.data_scope === 'demo') return true;
  if (typeof user.email === 'string' && user.email.endsWith('@demo.marzam.mx')) return true;
  return false;
}

/**
 * Sync demo detection — JWT or req.user only, no DB. Captures the typical
 * case where a demo user is honestly tagged. Tests rely on this returning
 * synchronously, so it must not become async.
 */
function readDemoFromToken(req) {
  if (req.user) return isDemoUser(req.user);
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return (
      payload.data_scope === 'demo'
      || (typeof payload.email === 'string' && payload.email.endsWith('@demo.marzam.mx'))
    );
  } catch {
    return false;
  }
}

/**
 * [S11] Defensive async check — for cases where the JWT claims non-demo, ask
 * the DB whether this user is actually demo. Catches forge attempts where
 * the JWT secret is compromised. Caches per user 60s. Only enabled when
 * DEMO_DB_VERIFY is true (production default) so unit tests can keep
 * calling demoReadonly synchronously.
 *
 * Returns Promise<boolean>.
 */
async function verifyDemoFromDb(req) {
  let userId;
  if (req.user) userId = req.user.id;
  else {
    const header = req.headers && req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return false;
    const token = header.split(' ')[1];
    try {
      const payload = jwt.verify(token, config.jwt.secret);
      userId = payload.id;
    } catch { return false; }
  }
  if (!userId) return false;
  const cached = readDemoFromCache(userId);
  if (cached === true) return true;
  if (cached === false) return false;
  const dbFlag = await dbDemoFlag(userId);
  if (dbFlag !== null) writeDemoCache(userId, dbFlag);
  return !!dbFlag;
}

// Production default: enabled. Test/dev: disabled (avoids hitting a DB the
// node:test harness doesn't configure). Override with DEMO_DB_VERIFY_ENABLED.
const DEMO_DB_VERIFY = (() => {
  if (process.env.DEMO_DB_VERIFY_ENABLED === 'true') return true;
  if (process.env.DEMO_DB_VERIFY_ENABLED === 'false') return false;
  return config.env === 'production';
})();

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

function blockWithMock(req, res) {
  const mock = buildMockResponse(req);
  res.set('X-Demo-Mode', 'readonly');
  demoMetrics.blocked_writes += 1;
  return res.status(200).json(mock);
}

function demoReadonly(req, res, next) {
  const method = (req.method || '').toUpperCase();
  if (READ_METHODS.has(method)) {
    // Only count if request is from a demo user — counting all reads would
    // make the metric meaningless. Use the cheap sync check.
    if (readDemoFromToken(req)) demoMetrics.passthrough_reads += 1;
    return next();
  }
  if (alwaysAllow(req.originalUrl || req.url || req.path)) {
    if (readDemoFromToken(req)) demoMetrics.whitelisted_writes += 1;
    return next();
  }

  // Fast sync path — covers the honest case (demo user with consistent JWT).
  // This must stay synchronous so unit tests that drive the middleware
  // without await keep working.
  if (readDemoFromToken(req)) return blockWithMock(req, res);

  // Production-only async defensive check — catches a forged JWT that claims
  // non-demo for a user whose DB row says demo. Skipped in test/dev so the
  // node:test harness doesn't have to spin up a DB.
  if (!DEMO_DB_VERIFY) return next();

  return Promise.resolve(verifyDemoFromDb(req))
    .then((isDemoFromDb) => {
      if (isDemoFromDb) return blockWithMock(req, res);
      return next();
    })
    .catch((err) => {
      console.warn('[demoReadonly] DB check failed (' + err.message + '), passing through');
      return next();
    });
}

module.exports = demoReadonly;
module.exports.isDemoUser = isDemoUser;
module.exports.getDemoMetrics = getDemoMetrics;
// Exposed for tests / debugging — clears the in-memory demo cache.
module.exports._clearDemoCache = () => demoCache.clear();
