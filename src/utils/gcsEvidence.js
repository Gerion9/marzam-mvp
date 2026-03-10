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

function sanitizeSegment(value, fallback = 'unknown') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || fallback;
}

function resolveExtension(originalName, mimeType) {
  const fromName = path.extname(originalName || '').replace(/^\./, '').toLowerCase();
  if (fromName) return fromName;

  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return mimeMap[mimeType] || 'jpg';
}

function buildObjectPath({ state, municipality, verificationId, pharmacyId, originalName, mimeType }) {
  const stateFolder = sanitizeSegment(state, 'unknown-state');
  const municipalityFolder = sanitizeSegment(municipality, 'unknown-municipality');
  const verificationFolder = sanitizeSegment(verificationId, 'verification');
  const pharmacySegment = sanitizeSegment(pharmacyId, 'pharmacy');
  const ext = resolveExtension(originalName, mimeType);
  const fileName = `${pharmacySegment}_${Date.now()}.${ext}`;
  return `${config.gcs.photoFolder}/${stateFolder}/${municipalityFolder}/${verificationFolder}/${fileName}`;
}

function buildPublicUrl(bucketName, objectPath) {
  if (config.gcs.publicBaseUrl) {
    return `${config.gcs.publicBaseUrl.replace(/\/$/, '')}/${bucketName}/${objectPath}`;
  }
  return `https://storage.googleapis.com/${bucketName}/${objectPath}`;
}

function parseStorageUrl(photoUrl) {
  if (!photoUrl) return null;
  const normalizedBase = (config.gcs.publicBaseUrl || 'https://storage.googleapis.com').replace(/\/$/, '');
  if (photoUrl.startsWith(`${normalizedBase}/`)) {
    const remainder = photoUrl.slice(`${normalizedBase}/`.length);
    const [bucketName, ...pathParts] = remainder.split('/');
    return {
      bucketName,
      objectPath: pathParts.join('/'),
    };
  }
  if (photoUrl.startsWith('gs://')) {
    const remainder = photoUrl.slice(5);
    const [bucketName, ...pathParts] = remainder.split('/');
    return {
      bucketName,
      objectPath: pathParts.join('/'),
    };
  }
  return null;
}

async function resolveEvidenceAccessUrl(photoUrl) {
  if (!photoUrl || config.photos.provider !== 'gcs' || config.gcs.makeObjectsPublic) {
    return photoUrl;
  }

  const parsed = parseStorageUrl(photoUrl);
  if (!parsed?.bucketName || !parsed.objectPath) return photoUrl;

  const storage = getStorageClient();
  const file = storage.bucket(parsed.bucketName).file(parsed.objectPath);
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + config.gcs.signedUrlTtlMinutes * 60 * 1000,
  });
  return signedUrl;
}

async function uploadVerificationPhoto({ state, municipality, verificationId, pharmacyId, originalName, buffer, contentType }) {
  if (!config.gcs.bucketName) {
    const err = new Error('MARZAM_EVIDENCE_GCS_BUCKET is not configured');
    err.status = 500;
    throw err;
  }

  const bucketName = config.gcs.bucketName;
  const objectPath = buildObjectPath({
    state,
    municipality,
    verificationId,
    pharmacyId,
    originalName,
    mimeType: contentType,
  });

  const storage = getStorageClient();
  const file = storage.bucket(bucketName).file(objectPath);

  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: {
      cacheControl: 'public, max-age=31536000',
    },
  });

  if (config.gcs.makeObjectsPublic) {
    await file.makePublic();
  }

  return {
    bucket: bucketName,
    objectPath,
    photoUrl: buildPublicUrl(bucketName, objectPath),
  };
}

module.exports = {
  uploadVerificationPhoto,
  buildPublicUrl,
  resolveEvidenceAccessUrl,
};
