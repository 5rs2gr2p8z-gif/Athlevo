/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Service Worker  (offline app shell + install support)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Makes Athlevo installable and resilient offline WITHOUT ever caching
 *  private or dynamic data. Strategy:
 *    · App shell (HTML/CSS/JS/icons/fonts)  → cache-first, updated in the
 *      background (stale-while-revalidate).
 *    · Everything dynamic or private (Supabase, /api, Strava, auth, any
 *      non-GET) → NETWORK ONLY, never touched by the cache.
 *    · Navigations offline → fall back to the cached app shell so the PWA
 *      opens even with no connection (the app then shows its own state).
 *
 *  Bump CACHE_VERSION to ship a new shell. Old caches are purged on
 *  activate. No coaching logic, auth, or API behaviour is affected.
 */

const CACHE_VERSION = "athlevo-shell-v35";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/assets/athlevo-icon.png",
  "/assets/athlevo-logo.png",
  "/assets/pwa/icon-192.png",
  "/assets/pwa/icon-512.png",
  "/assets/pwa/apple-touch-180.png"
];

// Hosts/paths that must NEVER be served from cache (dynamic or private).
const NEVER_CACHE = [
  "/api/",
  "supabase.co",
  "strava.com",
  "tryterra.co",
  "intervals.icu",
  "/auth/",
  "openai.com"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      // Best-effort: a single failed asset must not abort the install.
      Promise.allSettled(SHELL.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isNeverCache(url) {
  return NEVER_CACHE.some(part => url.includes(part));
}

self.addEventListener("fetch", event => {
  const request = event.request;

  // Only handle GET; never interfere with POST/PUT (auth, sync, coach, …).
  if (request.method !== "GET") return;

  const url = request.url;

  // Dynamic / private → straight to the network, no cache involvement.
  if (isNeverCache(url)) return;

  /*
   * Navigations: network-first, cached shell only as an offline fallback.
   *
   * This is what stops an outdated shell dictating routing. The shell decides
   * landing-vs-app, so serving a stale one could resurrect the old boot
   * markup (which painted the marketing page before auth resolved). A fresh
   * shell is always preferred; the cache is refreshed on every successful
   * navigation so the offline copy can't drift far behind.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put("/index.html", copy));
        }
        return response;
      }).catch(() =>
        caches.match("/index.html").then(r => r || caches.match("/"))
      )
    );
    return;
  }

  // Static assets (same-origin + fonts): stale-while-revalidate.
  const sameOrigin = url.startsWith(self.location.origin);
  const isFont = url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com");
  if (!sameOrigin && !isFont) return;

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.status === 200 && (response.type === "basic" || response.type === "cors")) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
