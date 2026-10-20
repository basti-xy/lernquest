// Service Worker: Network-first, damit Updates sofort ankommen – offline wird aus dem Cache geliefert.
// Inhalte und Fortschritt liegen nicht hier, sondern privat bei GitHub (die App speichert sie selbst
// in einem eigenen Cache „lernquest-data-…“ zwischen, den dieser Service Worker nicht anrührt).
const CACHE = 'lernquest-app-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'sync.js',
  'app.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lernquest-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // nur eigene Programmdateien; die API des lokalen Servers nie zwischenspeichern
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' });
  event.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
          .then((hit) => hit || Response.error())
      )
  );
});
