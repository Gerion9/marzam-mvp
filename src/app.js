const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { requestContextMiddleware } = require('./middleware/requestContext');
const softAuth = require('./middleware/softAuth');
const demoReadonly = require('./middleware/demoReadonly');
const sanitizeLogUrl = require('./middleware/sanitizeLogUrl');

const authRoutes = require('./modules/auth/auth.routes');
const pharmacyRoutes = require('./modules/pharmacies/pharmacies.routes');
const assignmentRoutes = require('./modules/assignments/assignments.routes');
const visitRoutes = require('./modules/visits/visits.routes');
const trackingRoutes = require('./modules/tracking/tracking.routes');
const reviewRoutes = require('./modules/review/review.routes');
const reportingRoutes = require('./modules/reporting/reporting.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const leadsRoutes = require('./modules/leads/leads.routes');
const verificationRoutes = require('./modules/verifications/verifications.routes');
const coloniasRoutes = require('./modules/colonias/colonias.routes');
const territoriesRoutes = require('./modules/territories/territories.routes');
const alertsRoutes = require('./modules/alerts/alerts.routes');
const usersRoutes = require('./modules/users/users.routes');
const importsRoutes = require('./modules/imports/imports.routes');
const bqSyncRoutes = require('./modules/bq-sync/bqSync.routes');
const marzamReadOnlyRoutes = require('./modules/marzam-readonly/marzam.routes');
const teamRoutes = require('./modules/team/team.routes');
const visitTargetsRoutes = require('./modules/visit-targets/visitTargets.routes');
const visitPlansRoutes = require('./modules/visit-plans/visitPlans.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const visitSessionsRoutes = require('./modules/visit-sessions/visitSessions.routes');
const pharmacyOnboardingRoutes = require('./modules/pharmacy-onboarding/onboarding.routes');
const poblacionesRoutes = require('./modules/poblaciones/poblaciones.routes');
const quotasRoutes = require('./modules/quotas/quotas.routes');
const invitationsRoutes = require('./modules/invitations/invitations.routes');
const liveRoutes = require('./modules/live/live.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const adminCockpitRoutes = require('./modules/admin/cockpit.routes');

// Boot-time safety check: production must not run with scope filtering off.
// Catches a class of "demo accidentally became prod" deploy mistakes.
if (
  process.env.SCOPE_FILTERING_ENABLED === 'false'
  && process.env.NODE_ENV === 'production'
) {
  console.error('[boot] SCOPE_FILTERING_ENABLED=false in production — refusing to start.');
  process.exit(1);
}

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const corsOriginsRaw = process.env.CORS_ORIGINS;
const corsOrigins = corsOriginsRaw
  ? corsOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
app.use(cors({
  origin: corsOrigins && corsOrigins.length ? corsOrigins : true,
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));
// Mask sensitive query params (token, cron_secret, ...) on req.url BEFORE
// morgan logs them. req.query is left intact so downstream auth/route
// handlers still see the real values. See src/middleware/sanitizeLogUrl.js.
app.use(sanitizeLogUrl);
app.use(morgan('short'));
app.use(requestContextMiddleware);
app.use(softAuth);

const RATE_LIMIT_DISABLED = process.env.DISABLE_RATE_LIMIT === 'true';

function userIdKey(req, res) {
  return req.authUserId ? `u:${req.authUserId}` : `ip:${ipKeyGenerator(req, res)}`;
}

const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => RATE_LIMIT_DISABLED,
  keyGenerator: userIdKey,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => RATE_LIMIT_DISABLED,
  message: { error: 'Too many login attempts, please try again later.' },
});

const trackingLimiter = rateLimit({
  windowMs: Number(process.env.TRACKING_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.TRACKING_RATE_LIMIT_MAX) || 240,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => RATE_LIMIT_DISABLED,
  keyGenerator: userIdKey,
  message: { error: 'Tracking rate limit exceeded for this user.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/tracking/ping', trackingLimiter);
app.use('/api/tracking/ping-batch', trackingLimiter);
app.use('/api/', apiLimiter);

// Demo write-blocker: aplica DESPUÉS de softAuth (que popula req.user en
// modo external/JWT) y ANTES de los routers, para que cualquier write
// (POST/PUT/PATCH/DELETE) hecho por un usuario demo se corte y devuelva
// un payload sintético en lugar de tocar la BD. Lecturas pasan intactas.
app.use('/api/', demoReadonly);

app.use('/api/auth', authRoutes);
app.use('/api/pharmacies', pharmacyRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/reporting', reportingRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/commercial-leads', leadsRoutes);
app.use('/api/verifications', verificationRoutes);
app.use('/api/colonias', coloniasRoutes);
app.use('/api/territories', territoriesRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin/imports', importsRoutes);
app.use('/api/admin/bq-sync', bqSyncRoutes);
app.use('/api/marzam', marzamReadOnlyRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/visit-targets', visitTargetsRoutes);
app.use('/api/visit-plans', visitPlansRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/visit-sessions', visitSessionsRoutes);
app.use('/api/pharmacy-onboarding', pharmacyOnboardingRoutes);
app.use('/api/poblaciones', poblacionesRoutes);
app.use('/api/quotas', quotasRoutes);
app.use('/api/admin/invitations', invitationsRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/admin/cockpit', adminCockpitRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', async (_req, res) => {
  const result = {
    status: 'ok',
    env: config.env,
    data_backend: config.dataBackend,
    external_data_provider: config.externalData.provider,
    gps_ping_interval_seconds: config.gps.pingIntervalSeconds,
    photo_storage_provider: config.photos.provider,
    rate_limit: {
      disabled: RATE_LIMIT_DISABLED,
      api_max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
      auth_max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
      tracking_max: Number(process.env.TRACKING_RATE_LIMIT_MAX) || 240,
    },
    checks: {},
  };

  if (config.dataBackend === 'local' || (config.dataBackend === 'external' && config.externalData.provider !== 'sql')) {
    try {
      const db = require('./config/database');
      const start = Date.now();
      await db.raw('SELECT 1');
      result.checks.primary_db = 'ok';
      result.checks.primary_db_latency_ms = Date.now() - start;
      const pool = db.client?.pool;
      if (pool) {
        result.checks.primary_db_pool = {
          used: pool.numUsed?.() ?? null,
          free: pool.numFree?.() ?? null,
          pending_acquires: pool.numPendingAcquires?.() ?? null,
          pending_creates: pool.numPendingCreates?.() ?? null,
        };
      }
    } catch (err) {
      result.checks.primary_db = `error: ${err.message}`;
      result.status = 'degraded';
    }
  }

  if (config.dataBackend === 'external' && config.externalData.provider === 'sql') {
    try {
      const extDb = require('./config/externalDatabase')();
      const start = Date.now();
      await extDb.raw('SELECT 1');
      result.checks.external_db = 'ok';
      result.checks.external_db_latency_ms = Date.now() - start;
    } catch (err) {
      result.checks.external_db = `error: ${err.message}`;
      result.status = 'degraded';
    }
  }

  if (config.photos.provider === 'gcs' && config.gcs.bucketName) {
    result.checks.gcs_bucket = config.gcs.bucketName;
    result.checks.gcs_credentials = config.bigquery?.serviceAccount ? 'service_account' : 'default';
  }

  res.json(result);
});

app.get('/manager', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'manager.html')));
app.get('/manager-live', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'manager-live.html')));
app.get('/rep', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rep.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/activate.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('/reset-password.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

// Static fallback for local dev (Vercel serves these via @vercel/static in prod).
app.use(express.static(path.join(__dirname, 'public')));

app.use(errorHandler);

module.exports = app;
