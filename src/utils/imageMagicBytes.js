/**
 * Audit S9 — image content-type verification by magic bytes.
 *
 * The visit photo upload route (src/modules/visits/visits.routes.js) used to
 * trust the multipart `Content-Type` header alone — easily spoofed by an
 * attacker who changes the form field. Without an actual content check, an
 * uploaded JS or executable file could land in our GCS bucket masquerading
 * as an image. This module reads the first bytes of the buffer and asserts
 * the claimed MIME matches the detected format.
 *
 * Supported formats: JPEG, PNG, WebP — the same allow-list multer uses in
 * visits.routes.js.
 */

const SIGNATURES = [
  {
    mime: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  },
  {
    mime: 'image/png',
    test: (b) => b.length >= 8
      && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
      && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
  },
  {
    // RIFF....WEBP — bytes 0-3 = 'RIFF', bytes 8-11 = 'WEBP'.
    mime: 'image/webp',
    test: (b) => b.length >= 12
      && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function detectImageType(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return sig.mime;
  }
  return null;
}

/**
 * Returns { ok, detected?, error? }.
 * - ok=true  → the buffer's magic bytes match a supported image format AND
 *              (if claimedMime is given) the claimed MIME matches.
 * - ok=false → unrecognized format OR MIME mismatch (spoofed header).
 */
function verifyImageBuffer(buffer, claimedMime) {
  const detected = detectImageType(buffer);
  if (!detected) {
    return {
      ok: false,
      error: 'unrecognized image format — only JPEG/PNG/WebP are accepted',
    };
  }
  if (claimedMime && claimedMime !== detected) {
    return {
      ok: false,
      detected,
      error: 'MIME mismatch: header claimed ' + claimedMime + ' but bytes detected ' + detected,
    };
  }
  return { ok: true, detected };
}

/**
 * Throws an HTTP-style error (status 400) if the buffer is not a recognized
 * image. Convenience helper for upload handlers that just want a fail-fast.
 */
function assertImageBuffer(buffer, claimedMime) {
  const result = verifyImageBuffer(buffer, claimedMime);
  if (!result.ok) {
    const err = new Error('Photo upload rejected: ' + result.error);
    err.status = 400;
    err.code = 'invalid_image_content';
    throw err;
  }
  return result;
}

module.exports = {
  detectImageType,
  verifyImageBuffer,
  assertImageBuffer,
};
