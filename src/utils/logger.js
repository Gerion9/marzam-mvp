/**
 * Lightweight structured logger. JSON-line output to stdout/stderr.
 *
 * Drop-in replacement for `console.warn(...)` calls in routesMatrix.js and
 * planGenerator.js. Each call produces ONE line of `{ts,level,event,...ctx}`
 * so log aggregators (Datadog, BetterStack, fluentd) can index by `event`.
 *
 * Usage:
 *   const log = require('../utils/logger');
 *   log.warn({ event: 'plan.matrix.failed', plan_id, ms, err: e.message });
 *
 * [O8] AsyncLocalStorage auto-injection: when a request context is active,
 * `request_id` and `user_id` are automatically merged into every log line so
 * callers no longer need to thread them manually. Caller-supplied keys win
 * over auto-injected ones (so logs that already pass user_id keep working).
 *
 * No external dependency — keeps the bundle small and avoids the pino vs
 * console-as-string-formatter migration in one shot. Drop-in replacement when
 * we adopt pino.
 */

const ENABLED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function getRequestContext() {
  // Lazy-require to break a potential cycle at module load (logger is loaded
  // very early; requestContext imports only built-ins, so the cycle would be
  // benign, but the lazy require also lets tests that stub the context work).
  // eslint-disable-next-line global-require
  const ctx = require('../middleware/requestContext');
  return {
    requestId: ctx.getRequestId(),
    userScope: ctx.getUserScope(),
  };
}

function emit(level, payload) {
  if (!ENABLED_LEVELS.has(level)) return;
  let auto = {};
  try {
    const { requestId, userScope } = getRequestContext();
    if (requestId) auto.request_id = requestId;
    if (userScope) {
      // userScope shape per src/middleware/auth.js — only `role` is publicly
      // safe to log. We don't dump territory ids by default to keep lines
      // small. If we later need them for forensic investigation we'll add
      // an opt-in flag.
      if (userScope.role) auto.user_role = userScope.role;
    }
  } catch {
    // Logger MUST never throw — fall through with no auto fields.
    auto = {};
  }
  const line = {
    ts: new Date().toISOString(),
    level,
    ...auto,
    ...payload,
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  // eslint-disable-next-line no-control-regex
  const out = JSON.stringify(line, (_, v) => (v instanceof Error ? v.message : v));
  stream.write(out + '\n');
}

const logger = {
  debug(payload) { emit('debug', payload); },
  info(payload)  { emit('info', payload); },
  warn(payload)  { emit('warn', payload); },
  error(payload) { emit('error', payload); },
};

module.exports = logger;
