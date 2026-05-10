const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { requestContextMiddleware } = require('./middleware/requestContext');
const softAuth = require('./middleware/softAuth');
const demoReadonly = require('./middleware/demoReadonly');
const sanitizeLogUrl = require('./middleware/sanitizeLogUrl');
const dbRateLimit = require('./middleware/rateLimitDb');

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
const planConflictAlertsRoutes = require('./modules/plan-conflict-alerts/planConflictAlerts.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const visitSessionsRoutes = require('./modules/visit-sessions/visitSessions.routes');
const pharmacyOnboardingRoutes = require('./modules/pharmacy-onboarding/onboarding.routes');
const poblacionesRoutes = require('./modules/poblaciones/poblaciones.routes');
const quotasRoutes = require('./modules/quotas/quotas.routes');
const invitationsRoutes = require('./modules/invitations/invitations.routes');
const liveRoutes = require('./modules/live/live.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const adminCockpitRoutes = require('./modules/admin/cockpit.routes');

// Boot-time safety check: refuse to start under unsafe configs.
// The literal expression for SCOPE_FILTERING_ENABLED stays inline so log greps
// and tests/auth/scopeBootGuard.test.js can anchor on it.  All other checks
// live in src/config/validate.js — keep the validator call here so the exit
// path is single (one process.exit, see scopeBootGuard.test.js invariant).
{
  const bootErrors = [];
  if (
    process.env.SCOPE_FILTERING_ENABLED === 'false'
    && process.env.NODE_ENV === 'production'
  ) {
    bootErrors.push('SCOPE_FILTERING_ENABLED=false in production — refusing to start.');
  }
  // eslint-disable-next-line global-require
  const { validateBootEnvironment } = require('./config/validate');
  for (const message of validateBootEnvironment()) {
    if (!bootErrors.includes(message)) bootErrors.push(message);
  }
  if (bootErrors.length > 0) {
    console.error('[boot] refusing to start. Reasons:');
    for (const reason of bootErrors) {
      console.error('[boot]   - ' + reason);
    }
    process.exit(1);
  }
}

// Boot-time non-blocking warning: in production, datamaster notifications go
// silent if neither SendGrid nor SMTP is configured. We don't refuse the
// boot — alta de farmacia still works, the email is best-effort — but we
// log loudly so it shows up in Vercel logs and can be caught early.
if (
  process.env.NODE_ENV === 'production'
  && !process.env.SENDGRID_API_KEY
  && !process.env.SMTP_HOST
) {
  console.warn(
    '[boot] WARNING: neither SENDGRID_API_KEY nor SMTP_HOST is set — '
    + 'datamaster notifications (Nueva Farmacia emails) will NOT be sent. '
    + 'Configure at least one provider in Vercel env to enable delivery.',
  );
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
// [O2] Request context (requestId + ALS) goes BEFORE softAuth + morgan so the
// id is available for both Morgan token output and structured log emission.
app.use(requestContextMiddleware);
app.use(softAuth);

// [O3] Custom Morgan tokens: req.authUserId (set by softAuth) and req.requestId
// (set by requestContextMiddleware). Morgan runs AFTER softAuth so the user id
// is populated; the access log line correlates 1:1 with each error_log row by
// request_id.
morgan.token('user-id', (req) => (req.authUserId ? req.authUserId : '-'));
morgan.token('request-id', (req) => (req.requestId || '-'));
app.use(morgan(
  ':remote-addr :method :url :status :res[content-length] :response-time ms - rid=:request-id - uid=:user-id',
));

const RATE_LIMIT_DISABLED = process.env.DISABLE_RATE_LIMIT === 'true';

function userIdKey(req) {
  // Prefer the authenticated user id (set by softAuth) so users behind shared
  // NAT can still hit their fair share of the limit; fall back to req.ip for
  // unauthenticated paths.
  return req.authUserId ? 'u:' + req.authUserId : 'ip:' + req.ip;
}

// Login limiter combines email + IP so a single attacker can't burn the
// shared bucket for an entire CDN egress, AND a single email can't be
// brute-forced from N IPs. Using both keys raises the cost of distributed
// brute force significantly (see audit S4).
function loginKey(req) {
  const emailRaw = req.body && typeof req.body.email === 'string' ? req.body.email : '';
  const email = emailRaw.trim().toLowerCase().slice(0, 200) || 'noemail';
  return 'login:' + email + ':' + req.ip;
}

// All three limiters now go through Postgres so a multi-instance Vercel
// deploy enforces a single global counter (see src/middleware/rateLimitDb.js).
const apiLimiter = dbRateLimit({
  name: 'api',
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  keyGenerator: userIdKey,
  message: { error: 'Too many requests, please try again later.' },
  skip: () => RATE_LIMIT_DISABLED,
});

const authLimiter = dbRateLimit({
  name: 'auth',
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  keyGenerator: loginKey,
  message: { error: 'Too many login attempts, please try again later.' },
  skip: () => RATE_LIMIT_DISABLED,
});

const trackingLimiter = dbRateLimit({
  name: 'tracking',
  windowMs: Number(process.env.TRACKING_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.TRACKING_RATE_LIMIT_MAX) || 240,
  keyGenerator: userIdKey,
  message: { error: 'Tracking rate limit exceeded for this user.' },
  skip: () => RATE_LIMIT_DISABLED,
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
app.use('/api/plan-conflict-alerts', planConflictAlertsRoutes);
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
    // [O6] Probe GCS bucket reachability — best-effort, short timeout. If the
    // bucket is unreachable we still respond to /api/health so callers can
    // see the degraded flag. We don't actually fetch — just resolve metadata
    // which a typical IAM-authorized SA can do quickly.
    try {
      // eslint-disable-next-line global-require
      const { Storage } = require('@google-cloud/storage');
      const storage = config.bigquery?.serviceAccount
        ? new Storage({ projectId: config.gcs.projectId, credentials: config.bigquery.serviceAccount })
        : (config.gcs.projectId ? new Storage({ projectId: config.gcs.projectId }) : new Storage());
      const start = Date.now();
      const probe = storage.bucket(config.gcs.bucketName).getMetadata();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('gcs probe timeout')), 2500));
      await Promise.race([probe, timeout]);
      result.checks.gcs_probe = 'ok';
      result.checks.gcs_latency_ms = Date.now() - start;
    } catch (err) {
      result.checks.gcs_probe = `error: ${err.message}`;
      // GCS probe failure doesn't take the API down — uploads will fail loudly
      // when actually attempted — but mark health degraded for ops visibility.
      result.status = 'degraded';
    }
  }

  // [O6] Cron freshness — surface the staleness of every recorded cron_runs row.
  // A row whose last_run_at is more than 2x its expected interval old is flagged
  // `stale` so dashboards can highlight it. We don't know the schedule per job
  // here, so we report raw ages and let the caller decide.
  if (config.dataBackend === 'local') {
    try {
      // eslint-disable-next-line global-require
      const db = require('./config/database');
      const cronExists = await db.raw("SELECT to_regclass('cron_runs') AS t");
      if (cronExists.rows?.[0]?.t) {
        const cronRows = await db('cron_runs')
          .select('job_key', 'last_run_at', 'last_status')
          .orderBy('job_key');
        result.checks.cron_runs = cronRows.map((row) => ({
          job_key: row.job_key,
          last_run_at: row.last_run_at,
          last_status: row.last_status,
          age_seconds: row.last_run_at
            ? Math.round((Date.now() - new Date(row.last_run_at).getTime()) / 1000)
            : null,
        }));
      }
      // Migration count vs schema lag detection.
      const migExists = await db.raw("SELECT to_regclass('marzam_app.knex_migrations') AS t");
      if (migExists.rows?.[0]?.t) {
        const mig = await db('marzam_app.knex_migrations').count('* as n').first();
        result.checks.migration_count = Number(mig?.n || 0);
      }
    } catch (err) {
      result.checks.observability = `error: ${err.message}`;
      // Don't flip status — observability errors shouldn't trigger pagerduty.
    }
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
