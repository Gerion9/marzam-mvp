/**
 * IndexedDB-backed offline queue for visit/skip submissions.
 * Hardened for: DB open failures, idempotency, retry limits,
 * photo compression, quota awareness, and Background Sync.
 */
const OfflineQueue = (() => {
  const DB_NAME = 'marzam_offline';
  // Bumped to v3 to add the generic `pending_ops` store used by my-route.js
  // (start/deviate). Existing v2 stores are preserved by the upgrade path.
  const DB_VERSION = 3;
  const STORE_VISITS = 'pending_visits';
  const STORE_ASSIGNMENT = 'cached_assignment';
  const STORE_OPS = 'pending_ops';
  const MAX_RETRIES = 10;
  const MAX_PHOTO_DIMENSION = 1280;
  const PHOTO_QUALITY = 0.7;

  let _dbPromise = null;

  function _generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_VISITS)) {
          const store = db.createObjectStore(STORE_VISITS, { keyPath: 'localId', autoIncrement: true });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
        } else {
          const tx = e.target.transaction;
          const store = tx.objectStore(STORE_VISITS);
          if (!store.indexNames.contains('synced')) {
            store.createIndex('synced', 'synced', { unique: false });
          }
          if (!store.indexNames.contains('idempotencyKey')) {
            store.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
          }
        }
        if (!db.objectStoreNames.contains(STORE_ASSIGNMENT)) {
          db.createObjectStore(STORE_ASSIGNMENT, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_OPS)) {
          const opsStore = db.createObjectStore(STORE_OPS, { keyPath: 'id' });
          opsStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null;
        reject(req.error);
      };
    });
    _dbPromise.catch(() => { _dbPromise = null; });
    return _dbPromise;
  }

  async function _compressPhoto(file) {
    if (!file || !file.type.startsWith('image/')) return { blob: null, name: null, type: null };
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > MAX_PHOTO_DIMENSION || height > MAX_PHOTO_DIMENSION) {
          const ratio = Math.min(MAX_PHOTO_DIMENSION / width, MAX_PHOTO_DIMENSION / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve({ blob: null, name: null, type: null }); return; }
            blob.arrayBuffer().then((buf) => {
              resolve({ blob: buf, name: file.name.replace(/\.\w+$/, '.jpg'), type: 'image/jpeg' });
            }).catch(() => resolve({ blob: null, name: null, type: null }));
          },
          'image/jpeg',
          PHOTO_QUALITY,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        fileToArrayBuffer(file).then((buf) => {
          resolve({ blob: buf, name: file.name, type: file.type });
        }).catch(() => resolve({ blob: null, name: null, type: null }));
      };
      img.src = url;
    });
  }

  async function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  async function enqueueVisit(payload, photoFile) {
    const db = await openDB();
    const photo = await _compressPhoto(photoFile);
    const entry = {
      idempotencyKey: _generateId(),
      payload,
      photoBlob: photo.blob,
      photoName: photo.name,
      photoType: photo.type,
      photoSynced: false,
      createdAt: new Date().toISOString(),
      synced: false,
      retryCount: 0,
      lastError: null,
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      const req = store.add(entry);
      req.onsuccess = () => {
        _requestBackgroundSync();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getPendingVisits() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readonly');
      const store = tx.objectStore(STORE_VISITS);
      if (store.indexNames.contains('synced')) {
        const idx = store.index('synced');
        const req = idx.getAll(false);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).filter((r) => !r.synced));
        req.onerror = () => reject(req.error);
      }
    });
  }

  async function markSynced(localId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      const getReq = store.get(localId);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (entry) {
          entry.synced = true;
          entry.syncedAt = new Date().toISOString();
          store.put(entry);
        }
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function markPhotoSynced(localId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      const getReq = store.get(localId);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (entry) {
          entry.photoSynced = true;
          store.put(entry);
        }
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function incrementRetry(localId, errorMsg) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      const getReq = store.get(localId);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (entry) {
          entry.retryCount = (entry.retryCount || 0) + 1;
          entry.lastError = errorMsg || 'Unknown';
          entry.lastRetryAt = new Date().toISOString();
          store.put(entry);
        }
        resolve(entry ? entry.retryCount : 0);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function markPermanentlyFailed(localId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      const getReq = store.get(localId);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (entry) {
          entry.synced = true;
          entry.permanentlyFailed = true;
          entry.syncedAt = new Date().toISOString();
          store.put(entry);
        }
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function clearSynced() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VISITS, 'readwrite');
      const store = tx.objectStore(STORE_VISITS);
      if (store.indexNames.contains('synced')) {
        const idx = store.index('synced');
        const req = idx.openCursor(IDBKeyRange.only(true));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else resolve();
        };
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          for (const entry of req.result || []) {
            if (entry.synced) store.delete(entry.localId);
          }
          resolve();
        };
        req.onerror = () => reject(req.error);
      }
    });
  }

  async function cacheAssignment(assignment) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ASSIGNMENT, 'readwrite');
      const store = tx.objectStore(STORE_ASSIGNMENT);
      store.put(assignment);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getCachedAssignment(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ASSIGNMENT, 'readonly');
      const store = tx.objectStore(STORE_ASSIGNMENT);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getLastCachedAssignment() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ASSIGNMENT, 'readonly');
      const store = tx.objectStore(STORE_ASSIGNMENT);
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.length ? all[all.length - 1] : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function pendingCount() {
    return getPendingVisits().then((r) => r.length).catch(() => 0);
  }

  async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0, percent: est.quota ? Math.round((est.usage / est.quota) * 100) : 0 };
    }
    return { usage: 0, quota: 0, percent: 0 };
  }

  function _requestBackgroundSync() {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then((reg) => reg.sync.register('sync-visits'))
        .catch(() => {});
    }
  }

  // ── Generic operation queue (start / deviate / arbitrary POST) ──────────
  // Used by my-route.js when navigator.onLine is false. Each op is replayed
  // via fetch on `online` event. Idempotency is best-effort: server endpoints
  // that update assignment status are themselves idempotent (start checks
  // actual_start_time IS NOT NULL; deviate sets a status that's safe to
  // re-apply).

  async function enqueueOp(op) {
    if (!op || !op.path || !op.method) throw new Error('enqueueOp requires {method, path, body?}');
    const db = await openDB();
    const id = _generateId();
    const record = {
      id,
      method: op.method.toUpperCase(),
      path: op.path,
      body: op.body || null,
      createdAt: Date.now(),
      retries: 0,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPS, 'readwrite');
      tx.objectStore(STORE_OPS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return record;
  }

  async function listPendingOps() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPS, 'readonly');
      const req = tx.objectStore(STORE_OPS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function _deleteOp(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPS, 'readwrite');
      tx.objectStore(STORE_OPS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function _bumpOpRetry(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_OPS, 'readwrite');
      const store = tx.objectStore(STORE_OPS);
      const req = store.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) { resolve(); return; }
        row.retries = (row.retries || 0) + 1;
        store.put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  // Drain replays all pending ops via the global API helper if present,
  // otherwise via fetch. Resolves with a summary {drained, failed}.
  let _draining = false;
  async function drain() {
    if (_draining) return { drained: 0, failed: 0, skipped: true };
    if (!navigator.onLine) return { drained: 0, failed: 0, skipped: true };
    _draining = true;
    try {
      const ops = await listPendingOps();
      let drained = 0;
      let failed = 0;
      for (const op of ops) {
        try {
          const apiHelper = window.API;
          if (apiHelper && typeof apiHelper[op.method.toLowerCase()] === 'function') {
            await apiHelper[op.method.toLowerCase()](op.path, op.body || undefined);
          } else {
            const res = await fetch(`/api${op.path}`, {
              method: op.method,
              headers: op.body ? { 'Content-Type': 'application/json' } : undefined,
              body: op.body ? JSON.stringify(op.body) : undefined,
              credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          }
          await _deleteOp(op.id);
          drained += 1;
        } catch (err) {
          await _bumpOpRetry(op.id);
          if ((op.retries || 0) + 1 >= MAX_RETRIES) {
            await _deleteOp(op.id); // give up so the queue doesn't grow unbounded
          }
          failed += 1;
        }
      }
      return { drained, failed };
    } finally {
      _draining = false;
    }
  }

  async function pendingOpsCount() {
    const ops = await listPendingOps();
    return ops.length;
  }

  return {
    openDB,
    enqueueVisit,
    getPendingVisits,
    markSynced,
    markPhotoSynced,
    incrementRetry,
    markPermanentlyFailed,
    clearSynced,
    cacheAssignment,
    getCachedAssignment,
    getLastCachedAssignment,
    pendingCount,
    getStorageEstimate,
    MAX_RETRIES,
    // Generic op queue (start / deviate / arbitrary POSTs)
    enqueue: enqueueOp,
    enqueueOp,
    listPendingOps,
    pendingOpsCount,
    drain,
  };
})();

// Expose globally so views (my-route.js, etc.) can use the queue without
// importing. Also auto-drain on page load if we're already online.
if (typeof window !== 'undefined') {
  window.MarzamOfflineQueue = OfflineQueue;
  window.addEventListener('online', () => {
    OfflineQueue.drain().catch(() => { /* logged inside drain */ });
  });
  if (navigator.onLine) {
    setTimeout(() => OfflineQueue.drain().catch(() => {}), 1500);
  }
}
