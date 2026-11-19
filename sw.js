// Service worker: hace la plataforma instalable y guarda una copia de la interfaz para abrir sin conexión.
// Intenta primero la red (así las actualizaciones llegan solas), pero si la red tarda más de 4 s
// usa la copia guardada y la actualiza en segundo plano (evita quedarse cargando con señal débil).
const CACHE = 'ruso-v2', ESPERA = 4000;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;   // Supabase y fuentes: sin tocar
  const red = fetch(r, { cache: 'no-cache' }).then(resp => {
    if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then(c => c.put(r, copia)); }
    return resp;
  });
  e.waitUntil(red.catch(() => {}));
  e.respondWith(new Promise(resolve => {
    let listo = false;
    const usarCopia = async () => { const c = await caches.match(r, { ignoreSearch: true }); if (c && !listo) { listo = true; resolve(c); } return !!c; };
    const t = setTimeout(usarCopia, ESPERA);
    red.then(resp => { clearTimeout(t); if (!listo) { listo = true; resolve(resp); } })
       .catch(async () => { clearTimeout(t); if (!(await usarCopia()) && !listo) { listo = true; resolve(Response.error()); } });
  }));
});
