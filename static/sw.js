/* Service worker Kopi Sawah: membuat aplikasi kasir tetap bisa DIBUKA saat internet putus.
 * Hanya menyimpan berkas tampilan (HTML/CSS/JS/gambar). Data (API) TIDAK pernah disimpan di sini. */
const VER = 'ks-shell-v1';
const SHELL = ['/', '/static/app.css', '/static/app.js', '/static/vendor/qrcode.js', '/static/images/logo-badge.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/m/')) return;      // data & halaman pelanggan: selalu lewat jaringan
  const isShell = url.pathname === '/' || url.pathname === '/index.html';
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(url.pathname);
  if (isImage) {            // gambar: cache dulu (jarang berubah)
    e.respondWith(caches.open(VER).then(async c => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }));
  } else if (isShell || url.pathname.startsWith('/static/')) {     // kode: jaringan dulu supaya selalu versi terbaru, cache sebagai cadangan
    e.respondWith(fetch(req).then(res => { if (res.ok) caches.open(VER).then(c => c.put(isShell ? '/' : req, res.clone())); return res; })
      .catch(() => caches.match(isShell ? '/' : req)));
  }
});
