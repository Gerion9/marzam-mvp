/**
 * GCS helpers for the import pipeline.
 *
 * Layout: imports/{kind}/{year}/{month}/{job_id}_{originalFilename}
 *
 * Two flows:
 *  - Signed PUT URL — issued to the client so the upload bypasses Vercel's
 *    4.5MB request body limit.
 *  - Direct download — used by the worker to read the uploaded file.
 */

const path = require('path');
const { Storage } = require('@google-cloud/storage');
const config = require('../config');

let storageClient = null;

function getStorageClient() {
  if (!storageClient) {
    if (config.bigquery?.serviceAccount) {
      storageClient = new Storage({
        projectId: config.gcs.projectId || config.bigquery.serviceAccount.project_id,
        credentials: config.bigquery.serviceAccount,
      });
    } else {
      storageClient = config.gcs.projectId
        ? new Storage({ projectId: config.gcs.projectId })
        : new Storage();
    }
  }
  return storageClient;
}

function getImportsBucketName() {
  const name = process.env.MARZAM_IMPORTS_GCS_BUCKET || config.gcs.bucketName;
  if (!name) {
    const err = new Error('MARZAM_IMPORTS_GCS_BUCKET (or fallback MARZAM_EVIDENCE_GCS_BUCKET) is not configured');
    err.status = 500;
    throw err;
  }
  return name;
}

function sanitizeFilename(name) {
  return String(name || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 200);
}

function buildImportObjectPath({ kind, jobId, originalFilename }) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const ext = path.extname(originalFilename || '').toLowerCase() || '.xlsx';
  const base = sanitizeFilename(path.basename(originalFilename || 'upload', ext));
  const folderPrefix = process.env.MARZAM_IMPORTS_GCS_FOLDER || 'imports';
  return `${folderPrefix}/${kind}/${year}/${month}/${jobId}_${base}${ext}`;
}

async function generateSignedUploadUrl({ kind, jobId, originalFilename, contentType }) {
  const bucketName = getImportsBucketName();
  const objectPath = buildImportObjectPath({ kind, jobId, originalFilename });
  const storage = getStorageClient();
  const file = storage.bucket(bucketName).file(objectPath);

  const ttlMinutes = Number(process.env.MARZAM_IMPORTS_SIGNED_URL_TTL_MINUTES) || 15;
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + ttlMinutes * 60 * 1000,
    contentType: contentType || 'application/octet-stream',
  });

  return {
    upload_url: uploadUrl,
    gcs_bucket: bucketName,
    gcs_path: objectPath,
    expires_in_minutes: ttlMinutes,
    content_type: contentType || 'application/octet-stream',
  };
}

async function objectExists(gcsPath, bucketName) {
  const storage = getStorageClient();
  const bucket = storage.bucket(bucketName || getImportsBucketName());
  const [exists] = await bucket.file(gcsPath).exists();
  return exists;
}

async function downloadObjectBuffer(gcsPath, bucketName) {
  const storage = getStorageClient();
  const bucket = storage.bucket(bucketName || getImportsBucketName());
  const [contents] = await bucket.file(gcsPath).download();
  return contents;
}

module.exports = {
  getImportsBucketName,
  buildImportObjectPath,
  generateSignedUploadUrl,
  objectExists,
  downloadObjectBuffer,
};
