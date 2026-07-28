/* global self, caches, fetch */

const CACHE_PREFIX = "xinjiang-roadtrip-shell";
const CACHE_VERSION = "2026-07-28-v1";
const SHELL_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const scopeUrl = new URL("./", self.registration.scope);
const shellUrl = scopeUrl.href;

const isExcludedRequest = (url) => (
  url.pathname.includes("/_AMapService")
  || url.pathname.endsWith("/trip-weather")
);

const shellAssetUrls = (html) => Array.from(html.matchAll(/(?:src|href)=["']([^"']+)["']/g))
  .map((match) => {
    try {
      return new URL(match[1], scopeUrl);
    } catch {
      return null;
    }
  })
  .filter((url) => url && url.origin === scopeUrl.origin && url.pathname.includes("/_next/static/"))
  .map((url) => url.href);

async function installShell() {
  const cache = await caches.open(SHELL_CACHE);
  const shellResponse = await fetch(new Request(shellUrl, { cache: "reload" }));
  if (!shellResponse.ok) throw new Error(`shell returned ${shellResponse.status}`);
  await cache.put(shellUrl, shellResponse.clone());

  const html = await shellResponse.text();
  const coreUrls = [
    new URL("manifest.webmanifest", scopeUrl).href,
    new URL("favicon.svg", scopeUrl).href,
    ...shellAssetUrls(html),
  ];
  await Promise.allSettled(Array.from(new Set(coreUrls)).map(async (url) => {
    const response = await fetch(new Request(url, { cache: "reload" }));
    if (response.ok) await cache.put(url, response);
  }));
}

self.addEventListener("install", (event) => {
  // Do not call skipWaiting here: the current page keeps its matching assets
  // until the user accepts an update, avoiding a mid-trip version mismatch.
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(shellUrl, response.clone());
    return response;
  } catch {
    return (await cache.match(shellUrl)) ?? Response.error();
  }
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Never persist third-party AMap traffic/tiles or weather responses here.
  // Their independent clients own freshness, authorization and fallback.
  if (url.origin !== scopeUrl.origin || isExcludedRequest(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.includes("/_next/static/") || ["style", "script", "font", "image"].includes(request.destination)) {
    event.respondWith(cacheFirstStatic(request));
  }
});
