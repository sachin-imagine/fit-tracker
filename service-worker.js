/**
 * service-worker.js
 *
 * Caches the static app shell (HTML/CSS/JS/icons) so the app opens
 * instantly and works offline for viewing, while every data call
 * always goes to the network (never cached) so you're never looking
 * at stale calories/weight/workouts.
 *
 * Network-first for the app shell (falling back to the cached copy
 * only if the network fetch fails): this app has been actively
 * changing week to week, and cache-first meant a stale index.html/
 * app.js/style.css could keep being served even after bumping
 * CACHE_NAME, until the browser happened to fully re-check the
 * service worker — which showed up as a real bug (an old index.html
 * missing an element a new app.js expected). Once this app is
 * stable/rarely-changing, cache-first is the better trade-off again —
 * for now, correctness beats the small speed win.
 */

const CACHE_NAME = 'fit-tracker-shell-v7';
const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/api.js',
  './js/rep-analysis.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
// Deliberately NOT caching MediaPipe's CDN files here (cdn.jsdelivr.net /
// storage.googleapis.com) — they're cross-origin and loaded on demand
// only when Form Check is actually used. Offline support for the rest
// of the app shell is unaffected either way.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache calls to the Apps Script backend — always go live.
  if (url.hostname.indexOf('script.google.com') !== -1 ||
      url.hostname.indexOf('script.googleusercontent.com') !== -1) {
    return;
  }

  // App shell: network-first, falling back to the cached copy only
  // when the network request itself fails (e.g. actually offline).
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
