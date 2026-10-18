// Cache the whole app on install so it opens instantly and works offline.
// Page files are served from cache first and refreshed in the background.
const CACHE = "tangent-v26";
const ASSETS = [
  "./",
  "help",
  "site.css",
  "manifest.webmanifest",
  "favicon.svg",
  "mark.svg",
  "app-icon-v2-180.png",
  "app-icon-v2-192.png",
  "app-icon-v2-512.png",
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
  // Live data (quotes, scores) and shared-story pages always go to the network.
  if (req.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/") || u.pathname === "/admin") return;
  // Cloudflare redirects /index.html to /, and a browser refuses a redirected response
  // for a page load, so loads of the app use the "./" entry. Other pages (welcome, help) keep their own.
  const key = req.mode === "navigate" && (u.pathname === "/" || u.pathname === "/index.html") ? "./" : req;
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

// Alerts: the fetcher sends {title, body, url, tag}; tapping opens that story in Tangent.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Tangent", {
    body: d.body || "", tag: d.tag, data: { url: d.url || "/" },
    icon: "app-icon-v2-192.png",
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ open: url }); return open.focus(); }
    return clients.openWindow(url);
  }));
});
