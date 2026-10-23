#!/usr/bin/env node
/**
 * Local static preview with the same public rewrites Vercel uses for
 * /programs and /programs/:slug (each offer has its own prerendered page; see
 * scripts/build-store-pages.mjs). The old /store paths and pre-rename offer URLs are
 * redirected permanently by Vercel in production; here /store... is redirected too.
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
  "half-marathon": "hybrid-programming",
  "marathon": "elite-coaching"
};

// Short links to send to a client: /athlevo-plan -> /programs/athlevo-plan (temporary, like vercel.json).
const SHORT_LINKS = new Set(["athlevo-plan", "athlevo-coaching", "hybrid-programming", "elite-coaching"]);

function shortLinkFor(pathname) {
  const m = pathname.match(/^\/([a-z0-9-]+)\/?$/);
  return m && SHORT_LINKS.has(m[1]) ? "/programs/" + m[1] : null;
}

function redirectFor(pathname) {
  const legacy = pathname.match(/^\/store(?:\/([^/]+))?\/?$/);
  if (!legacy) return null;
  if (!legacy[1]) return "/programs";
  return "/programs/" + (LEGACY_OFFERS[legacy[1]] || legacy[1]);
}

function rewrite(pathname) {
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
  const shortLink = shortLinkFor(url.pathname);
  if (shortLink) {
    res.writeHead(307, { location: shortLink + url.search });
    res.end();
    return;
  }
  const moved = redirectFor(url.pathname);
  if (moved) {
    res.writeHead(308, { location: moved + url.search });
    res.end();
    return;
  }
  let pathname = rewrite(url.pathname);
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
