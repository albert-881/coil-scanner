// Service worker: keeps a copy of the app on the phone so it opens without signal.
// Change the version number when you want to force every phone to drop its old copy.
const CACHE = "coil-scanner-v1";

const APP_FILES = [
  "./",
  "index.html",
  "discharge.html",
  "loadout.html",
  "login.html",
  "config.js",
  "auth.js",
  "queue.js",
  "offline-data.js",
];

const LIBRARY_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const NETWORK_TIMEOUT_MS = 4000; // weak signal: give up and use the saved copy after this

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.concat([
        "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js",
      ])))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

// App pages and files: try the internet first (so updates show up), fall back to the saved copy.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetchWithTimeout(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    if (request.mode === "navigate") return cache.match("index.html");
    throw e;
  }
}

// Libraries and fonts: use the saved copy if there is one (they never change).
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // saves go straight to the network (the queue handles offline)
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (LIBRARY_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else (Lambda, Cognito) is not touched.
});