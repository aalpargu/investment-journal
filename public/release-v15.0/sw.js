const CACHE_NAME = "yatirim-defterim-v15.0";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./styles-v15.0.css",
  "./theme.css?v=15.0",
  "./portfolio_core.js?v=15.0",
  "./offline-queue.js?v=13.6",
  "./expense-core-v15.0.js",
  "./app-v15.0.js",
  "./technical.js?v=15.0",
  "./palette.js?v=15.0",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Install Event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache.startsWith("yatirim-defterim-") && cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Network First with offline fallback
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API istekleri ve yazma işlemleri hiçbir zaman önbelleğe alınmaz.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});






















