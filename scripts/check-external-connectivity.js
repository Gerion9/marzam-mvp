const fs = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const getBigQueryClient = require('../src/integrations/bigquery/client');
const getExternalDatabase = require('../src/config/externalDatabase');
const { parseBigQueryTableRef } = require('../src/repositories/external/tableRef');
const { Storage } = require('@google-cloud/storage');

const LOCAL_TRACKING_PATH = config.externalData.deviceLocationsFallbackPath || path.resolve(process.cwd(), 'data', 'device-locations-runtime.json');

async function checkBigQueryTable(client, tableRefString) {
  const tableRef = parseBigQueryTableRef(
    tableRefString,
    config.bigquery.projectId || config.bigquery.serviceAccount?.project_id,
  );
  const [rows] = await client.query({
    query: `SELECT * FROM ${tableRef.sqlRef} LIMIT 1`,
  });
  return {
    table: tableRefString,
    ok: true,
    sample_row_present: rows.length > 0,
  };
}

async function checkSqlTable(db, tableRef) {
  const result = await db.raw(`SELECT * FROM ${tableRef} LIMIT 1`);
  return {
    table: tableRef,
    ok: true,
    sample_row_present: (result.rows || []).length > 0,
  };
}

async function checkLocalPoiCatalog() {
  const raw = await fs.readFile(config.externalData.poiCatalogPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    source: 'local_poi_catalog',
    path: config.externalData.poiCatalogPath,
    ok: Array.isArray(parsed?.pharmacies) && parsed.pharmacies.length > 0,
    sample_row_present: Array.isArray(parsed?.pharmacies) && parsed.pharmacies.length > 0,
  };
}

async function checkLocalTrackingFallback() {
  await fs.mkdir(path.dirname(LOCAL_TRACKING_PATH), { recursive: true });
  return {
    source: 'local_tracking_fallback',
    path: LOCAL_TRACKING_PATH,
    ok: true,
  };
}

async function checkStorage() {
  const usesInlineServiceAccount = !!config.bigquery?.serviceAccount;
  const serviceAccountEmail = config.bigquery?.serviceAccount?.client_email || null;

  if (config.photos.provider !== 'gcs') {
    return {
      bucket: null,
      ok: true,
      provider: config.photos.provider,
      skipped: true,
      reason: 'PHOTO_STORAGE_PROVIDER is not gcs',
    };
  }

  if (!config.gcs.bucketName) {
    return {
      bucket: null,
      ok: false,
      reason: 'MARZAM_EVIDENCE_GCS_BUCKET is not configured',
      credentials_loaded: usesInlineServiceAccount,
      credentials_source: usesInlineServiceAccount ? 'BQ_SERVICE_ACCOUNT_JSON' : 'default-google-auth',
      service_account_email: serviceAccountEmail,
    };
  }

  const storage = usesInlineServiceAccount
    ? new Storage({
      projectId: config.gcs.projectId || config.bigquery.serviceAccount.project_id,
      credentials: config.bigquery.serviceAccount,
    })
    : new Storage({ projectId: config.gcs.projectId || undefined });

  const result = {
    bucket: config.gcs.bucketName,
    ok: true,
    provider: 'gcs',
    public_objects: config.gcs.makeObjectsPublic,
    credentials_loaded: usesInlineServiceAccount,
    credentials_source: usesInlineServiceAccount ? 'BQ_SERVICE_ACCOUNT_JSON' : 'default-google-auth',
    service_account_email: serviceAccountEmail,
    metadata_access: 'unverified',
    bucket_exists: 'unverified',
  };

  const bucket = storage.bucket(config.gcs.bucketName);

  try {
    const [exists] = await bucket.exists();
    return {
      ...result,
      ok: exists,
      metadata_access: true,
      bucket_exists: exists,
      ...(exists ? {} : { reason: 'Bucket does not exist or is not visible to the configured principal' }),
    };
  } catch (error) {
    const message = error?.message || 'Unknown Google Cloud Storage error';
    const lacksBucketMetadataPermission = message.includes('storage.buckets.get');

    if (lacksBucketMetadataPermission) {
      return {
        ...result,
        ok: true,
        metadata_access: false,
        warning: 'Bucket metadata could not be verified because storage.buckets.get is missing. Upload/signing may still work if object permissions are granted.',
        metadata_check_error: message,
      };
    }

    return {
      ...result,
      ok: false,
      metadata_access: false,
      reason: message,
    };
  }
}

async function run() {
  if (config.dataBackend === 'local') {
    console.log(JSON.stringify({
      ok: false,
      message: 'DATA_BACKEND is local. Set DATA_BACKEND=external before using this check.',
    }, null, 2));
    return;
  }

  const checks = [];
  if (config.externalData.provider === 'bigquery') {
    const client = getBigQueryClient();
    checks.push(await checkBigQueryTable(client, config.externalData.fieldSurveyTable));
    if (config.externalData.poiTable) {
      try {
        checks.push(await checkBigQueryTable(client, config.externalData.poiTable));
      } catch {
        checks.push(await checkLocalPoiCatalog());
      }
    } else {
      checks.push(await checkLocalPoiCatalog());
    }
    if (config.externalData.deviceLocationsTable) {
      try {
        checks.push(await checkBigQueryTable(client, config.externalData.deviceLocationsTable));
      } catch {
        checks.push(await checkLocalTrackingFallback());
      }
    } else {
      checks.push(await checkLocalTrackingFallback());
    }
  } else {
    const db = getExternalDatabase();
    checks.push(await checkSqlTable(db, config.externalData.fieldSurveyTable));
    if (config.externalData.poiTable) {
      try {
        checks.push(await checkSqlTable(db, config.externalData.poiTable));
      } catch {
        checks.push(await checkLocalPoiCatalog());
      }
    } else {
      checks.push(await checkLocalPoiCatalog());
    }
    if (config.externalData.deviceLocationsTable) {
      try {
        checks.push(await checkSqlTable(db, config.externalData.deviceLocationsTable));
      } catch {
        checks.push(await checkLocalTrackingFallback());
      }
    } else {
      checks.push(await checkLocalTrackingFallback());
    }
  }

  const storage = await checkStorage();
  const warnings = [
    ...checks.filter((check) => check.warning).map((check) => `${check.table || check.source}: ${check.warning}`),
    ...(storage.warning ? [`storage: ${storage.warning}`] : []),
  ];

  console.log(JSON.stringify({
    ok: checks.every((check) => check.ok) && storage.ok,
    data_backend: config.dataBackend,
    external_provider: config.externalData.provider,
    checks,
    storage,
    warnings,
  }, null, 2));
}

run()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }, null, 2));
    process.exitCode = 1;
  });
