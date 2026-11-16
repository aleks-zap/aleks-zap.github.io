// Service worker mínimo: hace la plataforma instalable y guarda una copia de la interfaz
// para abrir sin conexión. Siempre intenta primero la red, así las actualizaciones llegan solas.
const CACHE = 'ruso-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;   // Supabase y fuentes: sin tocar
  e.respondWith(
    fetch(r, { cache: 'no-cache' }).then(resp => {
      if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then(c => c.put(r, copia)); }
      return resp;
    }).catch(() => caches.match(r, { ignoreSearch: true }))
  );
});
