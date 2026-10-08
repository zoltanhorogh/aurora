// Offline support: app shell cache-first, forecast data network-first (falls back to the last copy).
const CACHE = 'aurora-v99';
const SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'assets/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const isData = sameOrigin && url.pathname.includes('/data/');
  const isShell = sameOrigin && !isData;

  if (isData || url.hostname.endsWith('swpc.noaa.gov')) {
    // network-first; cache key ignores the cache-busting query
    const key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok && !url.pathname.includes('/rtsw/')) { // skip the multi-MB raw solar wind files
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(key)));
    return;
  }
  if (isShell || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request)));
  }
});
