/**
 * Subida de fotos/documentos del wizard de alta a GCS.
 *
 * Reusa el cliente de Storage que ya construye gcsEvidence.js, pero con un
 * folder propio: `${MARZAM_ONBOARDING_GCS_FOLDER || 'marzam/altas'}/{onboardingId}/{docType}_{ts}.{ext}`
 */

const path = require('path');
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');
const config = require('../../config');

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

function resolveExt(originalName, mimeType) {
  const fromName = path.extname(originalName || '').replace(/^\./, '').toLowerCase();
  if (fromName) return fromName;
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  return map[mimeType] || 'jpg';
}

function buildPublicUrl(bucketName, objectPath) {
  const base = (config.gcs.publicBaseUrl || 'https://storage.googleapis.com').replace(/\/$/, '');
  return `${base}/${bucketName}/${objectPath}`;
}

async function uploadOnboardingDoc({ onboardingId, docType, originalName, buffer, contentType }) {
  if (!config.gcs.bucketName) {
    const err = new Error('MARZAM_EVIDENCE_GCS_BUCKET no está configurado');
    err.status = 500;
    throw err;
  }
  const bucketName = config.gcs.bucketName;
  const folder = process.env.MARZAM_ONBOARDING_GCS_FOLDER || 'marzam/altas';
  const ext = resolveExt(originalName, contentType);
  // Audit Fix #2 — defense-in-depth against object-path enumeration.
  //
  // Old path: `${folder}/${onboardingId}/${docType}_${Date.now()}.${ext}`
  //   - onboardingId is a UUID (guessable if leaked from another channel)
  //   - docType is from a small enum (rfc, id, contract, ...)
  //   - timestamp window is brutable (~86M values per day)
  //   → if `gcs.makeObjectsPublic=true` AND bucket grants allUsers:viewer,
  //     guessing a valid UUID lets an attacker iterate timestamps and
  //     download other pharmacies' RFC / IDs / contracts.
  //
  // New path adds a 12-byte random suffix (96 bits of entropy):
  //   `${folder}/${onboardingId}/${docType}_${ts}_${nonce}.${ext}`
  //   The nonce makes brute-forcing infeasible regardless of bucket policy.
  //   This is additive; older docs already in GCS keep their old paths and
  //   their stored DB rows still resolve.
  const nonce = crypto.randomBytes(12).toString('hex');
  const objectPath = `${folder}/${onboardingId}/${docType}_${Date.now()}_${nonce}.${ext}`;

  const storage = getStorageClient();
  const file = storage.bucket(bucketName).file(objectPath);
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  if (config.gcs.makeObjectsPublic) {
    await file.makePublic().catch(() => {});
  }
  return {
    bucket: bucketName,
    objectPath,
    photoUrl: buildPublicUrl(bucketName, objectPath),
  };
}

module.exports = { uploadOnboardingDoc };
