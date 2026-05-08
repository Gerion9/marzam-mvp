// Marzam Service Worker — neutered.
//
// The previous implementation cached /js/api.js?v=ecatepec-3 with
// `ignoreSearch: true`, which ended up serving stale JS to clients running
// the new /app shell (cache-buster mismatch). The new shell unregisters
// any existing SW on load (see src/public/app.html). This stub stays in
// place only so old browsers that fetch /sw.js don't 404; it does
// nothing — no cache, no fetch hijack.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if ('caches' in self) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      try { client.postMessage({ type: 'SW_NEUTERED' }); } catch { /* no-op */ }
    }
    // Once the cache is wiped, unregister this worker so the page no
    // longer talks to it on subsequent loads.
    try { await self.registration.unregister(); } catch { /* no-op */ }
  })());
});
self.addEventListener('fetch', () => { /* no-op — let the network handle it */ });
