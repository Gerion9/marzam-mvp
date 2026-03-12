const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

function requestContextMiddleware(_req, _res, next) {
  asyncLocalStorage.run({ dataScope: null }, next);
}

function setDataScope(scope) {
  const store = asyncLocalStorage.getStore();
  if (store) store.dataScope = scope || null;
}

function getDataScope() {
  const store = asyncLocalStorage.getStore();
  return store?.dataScope || null;
}

module.exports = { requestContextMiddleware, setDataScope, getDataScope };
