const CACHE_NAME = "archive-shell-v16";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=13",
  "./app.js?v=13",
  "./config.js?v=13",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle same-origin GET requests for the shell. Everything
  // else (Google Drive API, Google Identity, Drive thumbnails/previews)
  // must always hit the network live — never cache or intercept those.
  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (request.method !== "GET" || !isSameOrigin) return;

  // Network-first: always try to get the latest app code. Only fall back
  // to the cached copy if there's no connection. This means code changes
  // show up on next reload with no manual cache-busting needed, while
  // still giving instant offline fallback when the network is down.
  event.respondWith(
    fetch(request, { cache: "no-store" })
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
