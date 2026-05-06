/**
 * Lightweight structured logger. JSON-line output to stdout/stderr.
 *
 * Drop-in replacement for `console.warn(...)` calls in routesMatrix.js and
 * planGenerator.js. Each call produces ONE line of `{ts,level,event,...ctx}`
 * so log aggregators (Datadog, BetterStack, fluentd) can index by `event`.
 *
 * Usage:
 *   const log = require('../utils/logger');
 *   log.warn({ event: 'plan.matrix.failed', plan_id, user_id, ms, err: e.message });
 *
 * No external dependency — keeps the bundle small and avoids the pino vs
 * console-as-string-formatter migration in one shot. Drop-in replacement when
 * we adopt pino.
 */

const ENABLED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function emit(level, payload) {
  if (!ENABLED_LEVELS.has(level)) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  // eslint-disable-next-line no-control-regex
  const out = JSON.stringify(line, (_, v) => (v instanceof Error ? v.message : v));
  stream.write(`${out}\n`);
}

const logger = {
  debug(payload) { emit('debug', payload); },
  info(payload)  { emit('info', payload); },
  warn(payload)  { emit('warn', payload); },
  error(payload) { emit('error', payload); },
};

module.exports = logger;
