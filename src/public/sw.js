const CACHE_NAME = 'marzam-rep-v2';
const SHELL_ASSETS = [
  '/rep.html',
  '/css/app.css',
  '/js/api.js?v=ecatepec-3',
  '/js/offlineQueue.js?v=ecatepec-3',
  '/js/demo.js?v=ecatepec-2',
  '/js/rep.js?v=ecatepec-3',
  '/images/logo_marzam.svg',
];

const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const fetches = SHELL_ASSETS.map((url) =>
        cache.add(url).catch((err) => {
          console.warn('[SW] Failed to cache', url, err);
        }),
      );
      return Promise.all(fetches);
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  const isShellAsset = SHELL_ASSETS.some((a) => {
    const assetPath = a.split('?')[0];
    const reqPath = url.pathname;
    return reqPath === a || reqPath === assetPath;
  });
  const isCdnAsset = CDN_ASSETS.some((a) => event.request.url.startsWith(a));

  if (isShellAsset || isCdnAsset) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-visits') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        if (clients.length > 0) {
          clients[0].postMessage({ type: 'SYNC_VISITS' });
        }
      }),
    );
  }
});
