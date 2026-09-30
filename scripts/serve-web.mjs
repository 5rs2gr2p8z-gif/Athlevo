#!/usr/bin/env node
/**
 * Local static preview with the same public rewrites Vercel uses for
 * /store and /store/:slug.
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
  ".md": "text/markdown; charset=utf-8"
};

function rewrite(pathname) {
  if (pathname === "/store" || pathname === "/store/") return "/store.html";
  if (/^\/store\/[^/]+\/?$/.test(pathname)) return "/store.html";
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
  console.log("Athlevo preview: http://127.0.0.1:" + port + "/store");
});
