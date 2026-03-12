const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { requestContextMiddleware } = require('./middleware/requestContext');

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

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('short'));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(requestContextMiddleware);
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);

app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/health', async (_req, res) => {
  const result = {
    status: 'ok',
    env: config.env,
    data_backend: config.dataBackend,
    external_data_provider: config.externalData.provider,
    gps_ping_interval_seconds: config.gps.pingIntervalSeconds,
    photo_storage_provider: config.photos.provider,
    checks: {},
  };

  if (config.dataBackend === 'external' && config.externalData.provider === 'sql') {
    try {
      const extDb = require('./config/externalDatabase')();
      await extDb.raw('SELECT 1');
      result.checks.external_db = 'ok';
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
app.get('/rep', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rep.html')));

app.use(errorHandler);

module.exports = app;
