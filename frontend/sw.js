// ─────────────────────────────────────────────────────────────────────────────
// Service Worker: Delhi AQI Sentinel (PWA)
// Enables offline viewing, instant app shell loading, and cached data fallbacks
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = "delhi-aqi-shell-v1";
const API_CACHE_NAME = "delhi-aqi-api-v1";

const APP_SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/chart.js"
];

// 1. Install Event: Pre-cache App Shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use catch on individual URLs so external CDN blips don't abort entire install
      return Promise.allSettled(
        APP_SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn("[SW] Pre-cache skipped:", url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up legacy caches and claim clients immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== API_CACHE_NAME) {
            console.log("[SW] Deleting legacy cache:", key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== "GET") return;

  // A. Local API requests (/api/stations, /api/forecast, etc.)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // If valid response, clone into API cache
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback: try reading from API cache
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              const headers = new Headers(cachedResponse.headers);
              headers.set("X-Offline-Fallback", "true");
              return new Response(cachedResponse.body, {
                status: cachedResponse.status,
                statusText: "Offline Cached Data",
                headers: headers
              });
            }
            return new Response(
              JSON.stringify({ status: "offline", error: "Device is offline and no cached data exists." }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          });
        })
    );
    return;
  }

  // B. HTML Navigation requests (Page reloads)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
          return networkResponse;
        })
        .catch(() => caches.match("/index.html") || caches.match("/"))
    );
    return;
  }

  // C. Static App Shell Assets (CSS, JS, Fonts, Icons)
  // Cache-First with Network Background Revalidation (Stale-While-Revalidate)
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(() => cached); // If network fails, stick to cached

      return cached || fetchPromise;
    })
  );
});
