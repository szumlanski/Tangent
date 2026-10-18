// Cache the whole app on install so it opens instantly and works offline.
// Page files are served from cache first and refreshed in the background.
const CACHE = "tangent-v12";
const ASSETS = [
  "./",
  "manifest.webmanifest",
  "favicon.svg",
  "app-icon-180.png",
  "app-icon-192.png",
  "app-icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const u = new URL(req.url);
  // Live data (quotes, scores) always goes to the network.
  if (req.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  // Cloudflare redirects /index.html to /, and a browser refuses a redirected response
  // for a page load, so every page load uses the "./" entry.
  const key = req.mode === "navigate" ? "./" : req;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(key, { ignoreSearch: true });
      const fresh = fetch(req).then(res => {
        if (res.ok && !res.redirected) cache.put(key, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
