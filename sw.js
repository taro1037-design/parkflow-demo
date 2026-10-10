/*
 * ParkFlow service worker — hand written, no build plugin.
 *
 * Strategy:
 *   • app shell (navigations)  → network-first, falling back to the cached shell
 *   • same-origin static files → stale-while-revalidate (hashed, safe to cache)
 *   • OpenStreetMap tiles      → cache-first with a small LRU-ish cap
 *
 * All parking data lives in localStorage + the JS bundle, so once the shell is
 * cached the whole demo dataset works with no network at all.
 */
/* `2026-10-10T17-33-59-583Z` is replaced at build time (see vite.config.ts) so that every
 * deploy ships a byte-different worker and retires the previous caches. */
const VERSION = 'parkflow-v1-2026-10-10T17-33-59-583Z';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const TILE_CACHE = `${VERSION}-tiles`;
const MAX_TILES = 220;

const SHELL_URLS = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg'];

/**
 * Only these same-origin path prefixes may be cached. An allowlist (rather than
 * caching whatever is fetched) means a future endpoint that returns
 * user-specific or sensitive data cannot be written into a shared cache that
 * outlives the session.
 */
const CACHEABLE_PREFIXES = ['/assets/', '/icons/', '/fonts/'];
const CACHEABLE_FILES = ['/manifest.webmanifest', '/sw.js'];

function isCacheable(pathname) {
  if (CACHEABLE_FILES.some((file) => pathname.endsWith(file))) return true;
  // startsWith, not includes: the constant is called CACHEABLE_PREFIXES and it
  // must actually test a prefix. `includes` matched any path CONTAINING the
  // segment, so a future endpoint like /api/x/assets/y would have been written
  // into a shared, persistent cache. Not reachable through today's route table
  // — a trap laid for the next endpoint rather than a live bug.
  return CACHEABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Map tiles: cache-first, capped so storage cannot grow without bound.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          // Only cache real successes. Opaque responses have an unreadable
          // status, so caching them can pin an error or a hostile intercept.
          if (response.ok) {
            await cache.put(request, response.clone());
            void trimCache(TILE_CACHE, MAX_TILES);
          }
          return response;
        } catch {
          return Response.error();
        }
      }),
    );
    return;
  }

  // Navigations: network-first so a new deploy is picked up, shell as fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache a real, same-origin success. This check was missing here
          // while both other cache paths had it, so ANY navigation response
          // overwrote the app shell: a 500 from the origin, a 502 from an
          // intermediary, or a captive-portal interception page. Once written it
          // is what every subsequent offline load serves — one transient failure
          // became a permanently broken install.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error();
        }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Anything outside the allowlist is passed straight through to the network
  // and never enters a cache.
  if (!isCacheable(url.pathname)) return;

  // Same-origin static assets: serve from cache immediately, refresh in the
  // background. Every entry here is content-hashed or explicitly no-cache.
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
