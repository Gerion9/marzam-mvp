/**
 * Boot-time environment validation.
 *
 * Single source of truth for the refusal-to-start checks that run before
 * src/app.js mounts any router or middleware. If any error is returned, the
 * caller logs every reason and exits with code 1.
 *
 * Intentionally reads process.env directly (not src/config/index.js) so the
 * validator can run independently of the config module — guaranteeing the boot
 * sequence: validate → log → exit, with no side-effects from config load.
 *
 * Audit anchors:
 *   - S1: JWT_SECRET must be set and not the documented placeholder.
 *   - S2: SCOPE_FILTERING_ENABLED must not be 'false' under any production-like env.
 *   - S3: CORS_ORIGINS must be a non-empty allow-list in production.
 *   - S7: CRON_SECRET and at least one DB connection setting required in prod.
 */

const PROD_LIKE_VERCEL_ENVS = new Set(['production', 'preview']);
const JWT_DEFAULT_PLACEHOLDER = 'dev-secret-replace-me';
const JWT_MIN_SECRET_LENGTH = 32;

function isProductionLike(env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  if (PROD_LIKE_VERCEL_ENVS.has(env.VERCEL_ENV)) return true;
  return false;
}

function validateBootEnvironment(env = process.env) {
  const errors = [];
  const productionLike = isProductionLike(env);

  // [S2] Scope filtering must be ON in production-like environments. The boot
  // guard in src/app.js also keeps the literal NODE_ENV check inline so log
  // greps and tests/auth/scopeBootGuard.test.js stay anchored to it.
  if (env.SCOPE_FILTERING_ENABLED === 'false' && productionLike) {
    errors.push(
      'SCOPE_FILTERING_ENABLED=false in production-like env'
        + ' (NODE_ENV=' + (env.NODE_ENV || 'unset')
        + ', VERCEL_ENV=' + (env.VERCEL_ENV || 'unset') + ').',
    );
  }

  if (!productionLike) return errors;

  // [S1] JWT secret must be set and not the documented placeholder.
  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET is required in production.');
  } else if (env.JWT_SECRET === JWT_DEFAULT_PLACEHOLDER) {
    errors.push(
      'JWT_SECRET is the default placeholder ("' + JWT_DEFAULT_PLACEHOLDER
        + '"). Generate a strong random secret.',
    );
  } else if (env.JWT_SECRET.length < JWT_MIN_SECRET_LENGTH) {
    errors.push(
      'JWT_SECRET is too short (' + env.JWT_SECRET.length
        + ' chars, min ' + JWT_MIN_SECRET_LENGTH + '). Use a strong random secret.',
    );
  }

  // [S7] Cron secret required so cron handlers (Vercel Cron) can authenticate.
  if (!env.CRON_SECRET) {
    errors.push('CRON_SECRET is required in production (Vercel Cron auth).');
  }

  // [S3] CORS allow-list mandatory in production. Without this, src/app.js
  // falls back to `origin: true` + credentials, which lets any origin call
  // authenticated endpoints — the classic "open CORS" misconfiguration.
  if (!env.CORS_ORIGINS || !env.CORS_ORIGINS.trim()) {
    errors.push(
      'CORS_ORIGINS must be a non-empty allow-list (comma-separated origins) in production.',
    );
  }

  // [S7] At least one form of DB connection must be available.
  if (!env.DATABASE_URL && !env.DB_HOST) {
    errors.push('DATABASE_URL or DB_HOST is required in production.');
  }

  return errors;
}

module.exports = {
  validateBootEnvironment,
  isProductionLike,
  JWT_DEFAULT_PLACEHOLDER,
  JWT_MIN_SECRET_LENGTH,
};
