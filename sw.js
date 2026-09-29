// Service Worker: hält die App-Dateien offline verfügbar. API- und Wiki-Anfragen gehen immer ins Netz.
const CACHE = 'gw2-achievements-v6';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/db.js', 'js/api.js', 'js/progress.js', 'js/wiki.js', 'js/geo.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netzwerk zuerst (damit Updates sofort ankommen), bei Offline der Cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
