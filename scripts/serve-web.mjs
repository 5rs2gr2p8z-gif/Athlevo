#!/usr/bin/env node
/**
 * Local static preview with the same public rewrites Vercel uses for
 * /programs and /programs/:slug (each offer has its own prerendered page; see
 * scripts/build-store-pages.mjs). The old /store paths and pre-rename offer URLs are
 * redirected permanently by Vercel in production; here /store... is redirected too.
 *
 * It also mirrors programs.athlevo.org. A request whose Host is that name gets the
 * rules below (an offer is /<slug>, "/" goes to the hub, anything that is not a program
 * page, an API call or a static file goes to athlevo.org), exactly as vercel.json does.
 * And a request whose Host is athlevo.org itself has its program addresses (/programs,
 * /programs/<slug>, the short links) sent to programs.athlevo.org. Every other host, such
 * as 127.0.0.1 or a preview deployment, serves the program pages under /programs.
 * To try it from a browser, map the name to this server, for example in Chrome:
 *   --host-resolver-rules="MAP programs.athlevo.org 127.0.0.1:4173"
 * and open http://programs.athlevo.org/
 *
 *   node scripts/serve-web.mjs
 */
import http from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

// Mirrors the permanent redirects in vercel.json: /store and /store/:slug move to
// /programs, and the pre-rename offer slugs go straight to their current offer.
const LEGACY_OFFERS = {
  "first-5k": "athlevo-plan",
  "faster-5k": "athlevo-coaching",
  "marathon": "athlevo-vip-coaching"
};

// Short links to send to a client: /athlevo-plan -> /programs/athlevo-plan (temporary, like vercel.json).
const SHORT_LINKS = new Set(["athlevo-plan", "athlevo-guided", "athlevo-coaching", "athlevo-vip-coaching"]);

function shortLinkFor(pathname) {
  const m = pathname.match(/^\/([a-z0-9-]+)\/?$/);
  return m && SHORT_LINKS.has(m[1]) ? "/programs/" + m[1] : null;
}

// programs.athlevo.org (see vercel.json). Offers live at /<slug> there.
const PROGRAMS_HOST = "programs.athlevo.org";
const PROGRAMS_ORIGIN = "https://" + PROGRAMS_HOST;
const APP_HOST = "athlevo.org";
const APP_ORIGIN = "https://" + APP_HOST;

// Addresses that no longer have a page, on every host (vercel.json has the same redirects). Elite
// Coaching was renamed Athlevo VIP Coaching; Hybrid Programming was dropped from the lineup.
const RETIRED_PATHS = new Map([
  ["/elite-coaching", [308, PROGRAMS_ORIGIN + "/athlevo-vip-coaching"]],
  ["/programs/elite-coaching", [308, PROGRAMS_ORIGIN + "/athlevo-vip-coaching"]],
  ["/hybrid-programming", [307, PROGRAMS_ORIGIN + "/programs"]],
  ["/programs/hybrid-programming", [307, PROGRAMS_ORIGIN + "/programs"]]
]);
// Paths the programs host serves itself; everything else is the app, which stays on athlevo.org.
const PROGRAMS_HOST_KEEPS = /^\/(?:(?:programs|athlevo-plan|athlevo-guided|athlevo-coaching|athlevo-vip-coaching|webinar)(?:\/|$)|(?:api|assets|athlevo-assets|js)\/|(?:store\.css|webinar\.css|robots\.txt|sitemap\.xml|sitemap-programs\.xml)$)/;

// The programs host's own redirects: [status, location], or null.
function programsHostRedirect(pathname, search) {
  if (pathname === "/") return [307, "/programs" + search];
  const nested = pathname.match(/^\/programs\/([a-z0-9-]+)$/);
  if (nested && SHORT_LINKS.has(nested[1])) return [308, "/" + nested[1] + search];
  if (!PROGRAMS_HOST_KEEPS.test(pathname)) return [307, APP_ORIGIN + pathname + search];
  return null;
}

// The app host's redirects to the program host: the hub, every offer (also by its short link),
// and any other /programs/<x>, which the program host then sorts out. Temporary (307), like the
// short links they replace. Query strings, including ?code=, are kept.
function appHostRedirect(pathname, search) {
  if (pathname === "/programs") return [307, PROGRAMS_ORIGIN + "/programs" + search];
  const nested = pathname.match(/^\/programs\/([a-z0-9-]+)$/);
  if (nested) return [307, PROGRAMS_ORIGIN + (SHORT_LINKS.has(nested[1]) ? "/" : "/programs/") + nested[1] + search];
  const short = pathname.match(/^\/([a-z0-9-]+)$/);
  if (short && SHORT_LINKS.has(short[1])) return [307, PROGRAMS_ORIGIN + "/" + short[1] + search];
  // The free webinar pages (scripts/build-webinar-pages.mjs) live on the programs host too.
  if (/^\/webinar(?:\/thank-you)?\/?$/.test(pathname)) return [307, PROGRAMS_ORIGIN + pathname + search];
  return null;
}

function redirectFor(pathname) {
  const legacy = pathname.match(/^\/store(?:\/([^/]+))?\/?$/);
  if (!legacy) return null;
  if (!legacy[1]) return "/programs";
  if (legacy[1] === "half-marathon") return "/programs"; // Hybrid Programming was dropped
  return "/programs/" + (LEGACY_OFFERS[legacy[1]] || legacy[1]);
}

function rewrite(pathname, host) {
  if (host === PROGRAMS_HOST) {
    const flat = pathname.match(/^\/([a-z0-9-]+)$/);
    if (flat && SHORT_LINKS.has(flat[1])) return "/store-pages/" + flat[1] + ".html";
  }
  if (pathname === "/webinar" || pathname === "/webinar/") return "/webinar.html";
  if (pathname === "/webinar/thank-you" || pathname === "/webinar/thank-you/") return "/webinar-thank-you.html";
  if (pathname === "/programs" || pathname === "/programs/") return "/store.html";
  const offer = pathname.match(/^\/programs\/([a-z0-9-]+)\/?$/);
  if (offer && existsSync(join(root, "store-pages", offer[1] + ".html"))) return "/store-pages/" + offer[1] + ".html";
  if (/^\/programs\/[^/]+\/?$/.test(pathname)) return "/store.html";
  if (pathname === "/landing-preview") return "/landing-preview.html";
  if (
    pathname === "/ai" || pathname === "/landing" || pathname === "/signup" ||
    pathname === "/ai-signup" || pathname === "/pricing" ||
    pathname === "/privacy" || pathname === "/support" || pathname === "/terms" ||
    pathname === "/delete-account" || pathname === "/reset-password"
  ) {
    return "/index.html";
  }
  return pathname;
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const cleaned = posix.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const absolute = resolve(join(root, cleaned));
  if (!absolute.startsWith(root)) return null;
  return absolute;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const retired = RETIRED_PATHS.get(url.pathname.replace(/\/+$/, ""));
  if (retired) {
    res.writeHead(retired[0], { location: retired[1] + url.search });
    res.end();
    return;
  }
  if (host === PROGRAMS_HOST) {
    const hop = programsHostRedirect(url.pathname, url.search);
    if (hop) {
      res.writeHead(hop[0], { location: hop[1] });
      res.end();
      return;
    }
  }
  if (host === APP_HOST) {
    const hop = appHostRedirect(url.pathname, url.search);
    if (hop) {
      res.writeHead(hop[0], { location: hop[1] });
      res.end();
      return;
    }
  }
  const shortLink = host === PROGRAMS_HOST ? null : shortLinkFor(url.pathname);
  if (shortLink) {
    res.writeHead(307, { location: shortLink + url.search });
    res.end();
    return;
  }
  const moved = host === PROGRAMS_HOST ? null : redirectFor(url.pathname);
  if (moved) {
    res.writeHead(308, { location: moved + url.search });
    res.end();
    return;
  }
  let pathname = rewrite(url.pathname, host);
  if (pathname === "/") pathname = "/index.html";
  const file = safePath(pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = types[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(readFileSync(file));
});

server.listen(port, "127.0.0.1", () => {
  console.log("Athlevo preview: http://127.0.0.1:" + port + "/programs");
});
