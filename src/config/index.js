require('dotenv').config({ override: true });
const os = require('os');
const path = require('path');

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const config = {
  port: Number(process.env.PORT) || 4000,
  env: process.env.NODE_ENV || 'development',
  dataBackend: process.env.DATA_BACKEND || 'local',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'marzam_mvp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-replace-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  photos: {
    provider: process.env.PHOTO_STORAGE_PROVIDER || 'gcs',
    storageDir: process.env.PHOTO_STORAGE_DIR || './uploads/photos',
  },

  gps: {
    pingIntervalSeconds: Number(process.env.GPS_PING_INTERVAL_SECONDS) || 30,
    retentionDays: Number(process.env.GPS_RETENTION_DAYS) || 30,
  },

  google: {
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  gcs: {
    projectId: process.env.GCP_PROJECT_ID || '',
    bucketName: process.env.MARZAM_EVIDENCE_GCS_BUCKET || '',
    photoFolder: process.env.MARZAM_EVIDENCE_GCS_FOLDER || 'marzam/verificaciones/photos',
    publicBaseUrl: process.env.GCS_PUBLIC_BASE_URL || 'https://storage.googleapis.com',
    makeObjectsPublic: process.env.GCS_MAKE_OBJECTS_PUBLIC !== 'false',
    signedUrlTtlMinutes: Number(process.env.GCS_SIGNED_URL_TTL_MINUTES) || 20,
  },

  bigquery: {
    enabled: !!process.env.BQ_SERVICE_ACCOUNT_JSON,
    projectId: process.env.BQ_PROJECT_ID || '',
    serviceAccount: parseJsonEnv(process.env.BQ_SERVICE_ACCOUNT_JSON, null),
  },

  externalData: {
    provider: process.env.EXTERNAL_DATA_PROVIDER || 'sql',
    poiTable: process.env.EXTERNAL_POI_TABLE || 'ingestion.ing_poi_farmacias_ecatepec',
    fieldSurveyTable: process.env.EXTERNAL_FIELD_SURVEY_TABLE || 'ingestion.field_survey_pharmacy',
    deviceLocationsTable: process.env.EXTERNAL_DEVICE_LOCATIONS_TABLE || 'ingestion.device_locations',
    fieldSurveyTableDemo: process.env.EXTERNAL_FIELD_SURVEY_TABLE_DEMO || 'ingestion.field_survey_pharmacy_demo',
    deviceLocationsTableDemo: process.env.EXTERNAL_DEVICE_LOCATIONS_TABLE_DEMO || 'ingestion.device_locations_demo',
    poiSchemaMap: parseJsonEnv(process.env.EXTERNAL_POI_SCHEMA_MAP, {}),
    fieldSurveySchemaMap: parseJsonEnv(process.env.EXTERNAL_FIELD_SURVEY_SCHEMA_MAP, {}),
    deviceLocationsSchemaMap: parseJsonEnv(process.env.EXTERNAL_DEVICE_LOCATIONS_SCHEMA_MAP, {}),
    poiCatalogPath: process.env.POI_CATALOG_PATH || path.resolve(process.cwd(), 'src', 'public', 'data', 'ecatepec-demo.json'),
    deviceLocationsFallbackPath: process.env.DEVICE_LOCATIONS_FALLBACK_PATH || path.join(os.tmpdir(), 'marzam-device-locations-runtime.json'),
  },

  externalDb: {
    host: process.env.EXTERNAL_DB_HOST || '',
    port: Number(process.env.EXTERNAL_DB_PORT) || 5432,
    database: process.env.EXTERNAL_DB_NAME || '',
    user: process.env.EXTERNAL_DB_USER || '',
    password: process.env.EXTERNAL_DB_PASSWORD || '',
    ssl: process.env.EXTERNAL_DB_SSL === 'true',
  },

  limits: {
    poiListMax: Number(process.env.LIMIT_POI_LIST) || 5000,
    fieldSurveyMax: Number(process.env.LIMIT_FIELD_SURVEY) || 50000,
    deviceLocationsMax: Number(process.env.LIMIT_DEVICE_LOCATIONS) || 50000,
    evidenceMax: Number(process.env.LIMIT_EVIDENCE) || 1000,
    breadcrumbsMax: Number(process.env.LIMIT_BREADCRUMBS) || 50000,
  },

  impersonation: {
    enabled: process.env.IMPERSONATION_ENABLED !== 'false',
  },

  authDirectory: {
    provider: process.env.AUTH_DIRECTORY_PROVIDER || 'virtual',
    managerId: process.env.MANAGER_ID || 'mgr001',
    managerEmail: process.env.MANAGER_EMAIL || 'manager@marzam.mx',
    managerPassword: process.env.MANAGER_PASSWORD || 'Marzam2026!',
    managerName: process.env.MANAGER_NAME || 'Manager Ecatepec',
    repCount: Number(process.env.FIELD_REP_COUNT) || 50,
    repIdPrefix: process.env.FIELD_REP_ID_PREFIX || 'rep',
    repEmailPrefix: process.env.FIELD_REP_EMAIL_PREFIX || 'rep',
    repEmailDomain: process.env.FIELD_REP_EMAIL_DOMAIN || 'marzam.mx',
    repNamePrefix: process.env.FIELD_REP_NAME_PREFIX || 'Pilot Rep ',
    repDefaultPassword: process.env.FIELD_REP_DEFAULT_PASSWORD || 'Rep2026!',
    customUsers: parseJsonEnv(process.env.AUTH_DIRECTORY_JSON, null),
  },
};

module.exports = config;
