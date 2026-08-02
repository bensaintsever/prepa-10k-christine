/* Service worker du tracker 10 km.
 *
 * Sans lui, la PWA installée sur l'écran d'accueil n'est qu'un raccourci : sans
 * réseau, Christine obtient la page d'erreur du navigateur. Le stockage local
 * de `sync.js` ne sert à rien si la page elle-même ne se charge pas.
 *
 * Les fichiers du site passent par le réseau d'abord : une modification est
 * donc prise en compte dès qu'il y a de la connexion, sans intervention.
 * Bumper CACHE ne sert qu'à évincer d'anciennes entrées — un fichier retiré
 * de CORE, ou un cache qu'on veut reconstruire de zéro.
 */
const CACHE = 'tracker10k-v2';

const CORE = [
  './',
  './index.html',
  './Christine_10K_Tracker.html',
  './Christine_10K_Carnet.html',
  './style.v2.css',
  './sync.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Le client Supabase vient d'un CDN : en mode no-cors la réponse est opaque,
// mais elle reste rejouable hors ligne, ce qui évite que le tracker se charge
// sans sa couche de synchronisation.
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll échoue en bloc si une seule ressource manque : on tolère les
    // absences pour qu'une icône renommée ne casse pas toute l'installation.
    await Promise.all(CORE.map(url =>
      cache.add(url).catch(err => console.warn('[sw] non mis en cache :', url, err))
    ));
    await cache.add(new Request(CDN, { mode: 'no-cors' }))
      .catch(err => console.warn('[sw] CDN non mis en cache', err));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Jamais de cache sur l'API Supabase : ce sont des données vivantes, et une
  // réponse rejouée ferait croire à une synchronisation qui n'a pas eu lieu.
  if (url.hostname.endsWith('.supabase.co')) return;

  /* Tout ce qui vient du site — pages, CSS, scripts — passe par le réseau
   * d'abord, le cache ne servant que de filet hors ligne.
   *
   * Un « cache d'abord » servirait une logique périmée avec un chargement de
   * retard et obligerait à bumper CACHE à chaque correction : un correctif de
   * synchronisation doit s'appliquer dès qu'il y a du réseau, pas au prochain
   * lancement. Le surcoût est négligeable, ces fichiers pèsent quelques Ko. */
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, net.clone());
        }
        return net;
      } catch (e) {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Une navigation sans correspondance retombe sur l'accueil plutôt que
        // sur la page d'erreur du navigateur.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }
    })());
    return;
  }

  // Ressources tierces figées (le client Supabase du CDN) : cache d'abord,
  // rafraîchi en arrière-plan.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    const reseau = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        caches.open(CACHE).then(c => c.put(req, res.clone()));
      }
      return res;
    }).catch(() => null);
    return hit || (await reseau) || Response.error();
  })());
});
