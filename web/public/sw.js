const CACHE_NAME = 'squadchat-shell-v2';
const PHOTO_CACHE = 'squadchat-public-photos-v1';
const APP_ROOT = new URL('./', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try { await cache.add(APP_ROOT); } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Keep previous shell caches until the new version has populated its
    // own files. This prevents an offline launch from losing its app code.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isPublicSquadPhoto = url.pathname.includes('/storage/v1/object/public/squadchat-images/');
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(APP_ROOT, response.clone());
        }
        return response;
      } catch {
        const cacheNames = (await caches.keys()).filter(key => key.startsWith('squadchat-shell-')).reverse();
        for (const cacheName of cacheNames) {
          const cachedShell = await caches.open(cacheName);
          const cachedPage = (await cachedShell.match(request)) || (await cachedShell.match(APP_ROOT));
          if (cachedPage) return cachedPage;
        }
        return new Response('SquadChat is not available offline yet. Open it once while connected, then try again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  if (isPublicSquadPhoto) {
    event.respondWith((async () => {
      const cache = await caches.open(PHOTO_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          if (keys.length > 160) await cache.delete(keys[0]);
        }
        return response;
      } catch {
        return new Response('', { status: 504, statusText: 'Photo unavailable offline' });
      }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const isStaticAsset =
        ['script', 'style', 'image', 'font'].includes(request.destination) ||
        /\\.(?:js|mjs|css|ts|woff2?|ttf|png|jpe?g|webp|svg)(?:$|\\?)/i.test(url.pathname + url.search);
      try {
        // Fetch the newest app files whenever connected, then retain them
        // for the next offline launch.
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok && isStaticAsset) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        if (isStaticAsset) {
          const cached = await cache.match(request);
          if (cached) return cached;
          // Also check earlier shell versions instead of discarding their
          // cached JavaScript and styles during an update.
          const oldShells = (await caches.keys()).filter(key => key.startsWith('squadchat-shell-') && key !== CACHE_NAME).reverse();
          for (const oldName of oldShells) {
            const oldCache = await caches.open(oldName);
            const oldFile = await oldCache.match(request);
            if (oldFile) return oldFile;
          }
        }
        return new Response('', { status: 504, statusText: 'Offline resource unavailable' });
      }
    })());
  }
});
