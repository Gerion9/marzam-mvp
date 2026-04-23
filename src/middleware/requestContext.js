const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

function requestContextMiddleware(_req, _res, next) {
  asyncLocalStorage.run({ dataScope: null, userScope: null }, next);
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

module.exports = {
  requestContextMiddleware,
  setDataScope,
  getDataScope,
  setUserScope,
  getUserScope,
};
