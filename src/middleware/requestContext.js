const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const asyncLocalStorage = new AsyncLocalStorage();

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_MAX_LEN = 64;

function sanitizeRequestId(value) {
  if (typeof value !== 'string') return null;
  // Accept alphanumerics, dashes, and underscores. Reject anything else
  // (including spaces and quotes) to keep log lines unambiguous.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value.length > REQUEST_ID_MAX_LEN ? value.slice(0, REQUEST_ID_MAX_LEN) : value;
}

/**
 * Wraps the request lifecycle in an AsyncLocalStorage frame. Stores:
 *   - requestId  generated UUID (or sanitized inbound x-request-id) so logs,
 *                error_log rows, and downstream calls can correlate.
 *   - dataScope  user's data scope ('demo' | null) — set by auth middleware.
 *   - userScope  full scope object — set by auth middleware.
 *
 * The requestId is also attached to req.requestId and echoed back as
 * X-Request-Id so callers can include it in bug reports.
 */
function requestContextMiddleware(req, res, next) {
  const inbound = req.headers ? sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) : null;
  const requestId = inbound || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  asyncLocalStorage.run(
    { requestId, dataScope: null, userScope: null },
    next,
  );
}

function setDataScope(scope) {
  const store = asyncLocalStorage.getStore();
  if (store) store.dataScope = scope || null;
}

function getDataScope() {
  const store = asyncLocalStorage.getStore();
  return store?.dataScope || null;
}

function setUserScope(scope) {
  const store = asyncLocalStorage.getStore();
  if (store) store.userScope = scope || null;
}

function getUserScope() {
  const store = asyncLocalStorage.getStore();
  return store?.userScope || null;
}

function getRequestId() {
  const store = asyncLocalStorage.getStore();
  return store?.requestId || null;
}

module.exports = {
  requestContextMiddleware,
  setDataScope,
  getDataScope,
  setUserScope,
  getUserScope,
  getRequestId,
  REQUEST_ID_HEADER,
};
