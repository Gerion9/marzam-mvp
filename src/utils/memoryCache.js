// Per-instance in-memory TTL cache. Lives only inside one Lambda — invalidation across
// instances is by TTL expiration. For cross-instance invalidation, swap to Redis.

function createCache({ ttlSeconds = 60, maxEntries = 500 } = {}) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, ttlOverrideSeconds) {
    if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) store.delete(oldestKey);
    }
    store.set(key, {
      value,
      expiresAt: Date.now() + (ttlOverrideSeconds ?? ttlSeconds) * 1000,
    });
  }

  function del(key) {
    store.delete(key);
  }

  function clear() {
    store.clear();
  }

  async function wrap(key, loader, ttlOverrideSeconds) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    set(key, value, ttlOverrideSeconds);
    return value;
  }

  return { get, set, delete: del, clear, wrap };
}

module.exports = { createCache };
