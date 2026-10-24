// Service worker: lets the installed app open without internet by keeping the last copy.
// Always tries the network first, so you see fresh data whenever you're online.
const CACHE = "garmin-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/apple-touch-icon.png", "icons/favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          // Store data.enc under one key, ignoring the cache-busting query string.
          caches.open(CACHE).then((c) => c.put(url.pathname.endsWith("data.enc") ? "data.enc" : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname.endsWith("data.enc") ? "data.enc" : e.request))
  );
});
