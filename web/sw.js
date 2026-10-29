const C = 'kovi-v3';
const A = ['/', '/index.html', '/core.js', '/driver.js', '/admin.js', '/main.js', '/vendor/qrcode.js', '/style.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(A)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname.startsWith('/legal')) return;
  const nav = e.request.mode === 'navigate';   // /v/<id> QR links and any other page load get the app shell
  e.respondWith(fetch(e.request).then(r => { if (r.ok && !nav) { const c = r.clone(); caches.open(C).then(x => x.put(e.request, c)); } return r; })
    .catch(() => (nav ? caches.match('/index.html') : caches.match(e.request).then(r => r || caches.match('/index.html')))));
});
