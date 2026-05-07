/**
 * Sanitize sensitive query parameters from req.url BEFORE morgan logs it.
 *
 * EventSource (SSE) cannot set Authorization headers, so the auth token has
 * to ride on `?token=`. Several cron entry points also accept `?secret=` /
 * `?cron_secret=` for ad-hoc invocation. With the default morgan format,
 * those values land verbatim in Vercel access logs.
 *
 * This middleware runs BEFORE morgan and rewrites `req.url` and
 * `req.originalUrl` to mask sensitive params with `***`. It deliberately
 * does NOT mutate `req.query` — auth and route handlers continue reading
 * the real values, only the logger sees the masked URL.
 *
 * Wire order in app.js:
 *   app.use(sanitizeLogUrl);   // ← here
 *   app.use(morgan('short'));
 *
 * Lock order with tests/security/urlSanitizer.test.js.
 */

const SENSITIVE_PARAMS = new Set([
  'token',
  'cron_secret',
  'secret',
  'access_token',
  'api_key',
  'password',
]);

function maskUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;
  const head = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const masked = query
    .split('&')
    .map((part) => {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) return part;
      const key = part.slice(0, eqIdx);
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) return `${key}=***`;
      return part;
    })
    .join('&');
  return `${head}?${masked}`;
}

function sanitizeLogUrl(req, _res, next) {
  if (req.url) req.url = maskUrl(req.url);
  if (req.originalUrl) req.originalUrl = maskUrl(req.originalUrl);
  next();
}

module.exports = sanitizeLogUrl;
module.exports.maskUrl = maskUrl;
module.exports.SENSITIVE_PARAMS = SENSITIVE_PARAMS;
