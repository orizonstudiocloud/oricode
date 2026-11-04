/* OriCode PWA service worker — consent-driven updates.
 * Never calls skipWaiting() on its own; only on a SKIP_WAITING message sent
 * after the user accepts the update banner in updates.js.
 */
const CACHE = "oricode-app-v2";
self.addEventListener("install", () => { /* wait for explicit SKIP_WAITING */ });
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("oricode-app-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Never cache authenticated HTML, API endpoints, OAuth flows or token URLs.
  if (e.request.mode === "navigate") return;
  if (url.search) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/account/")) return;
  // Network-first for same-origin static assets only; cache is a fallback.
  if (!url.pathname.startsWith("/assets/")) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}));
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || Response.error()))
  );
});
