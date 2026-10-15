#!/usr/bin/env node
/**
 * Writes crawler-readable copies of the /store pages.
 *
 * The storefront is drawn in the browser by js/storefront.js. Search engines and
 * AI crawlers that do not run JavaScript would otherwise see an empty page, with
 * one title and one canonical for every route. This script runs the real
 * storefront code against a tiny DOM stand-in, so the static HTML it writes is
 * exactly what the browser would draw. The browser then replaces it with the same
 * markup, so nothing visibly changes.
 *
 * Outputs (all generated, do not edit by hand):
 *   store.html                  /store (also the banner text, from catalog.notice())
 *   store-pages/<slug>.html     /store/<slug>, one per offer
 *   sitemap.xml                 home, /store and every offer
 *
 * Run after changing js/storeCatalog.js, js/storefront.js or the shell in store.html:
 *   node scripts/build-store-pages.mjs          write the files
 *   node scripts/build-store-pages.mjs --check  fail if any file is out of date
 *
 * Copy and metadata live in js/storeCatalog.js (see seo()). Nothing here invents text.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- A minimal DOM: just enough surface for js/storefront.js to render ----

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BOOLEAN_ATTRS = new Set(["open"]);
const REFLECT = {
  className: "class", id: "id", href: "href", src: "src", alt: "alt", type: "type",
  sizes: "sizes", srcset: "srcset", loading: "loading", decoding: "decoding",
  width: "width", height: "height", fetchPriority: "fetchpriority", tabIndex: "tabindex"
};
const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

class TextNode {
  constructor(data) { this.data = String(data); }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toLowerCase();
    this.attrs = new Map();
    this.childNodes = [];
    const declarations = new Map();
    this.style = new Proxy({}, {
      set: (_, prop, value) => {
        declarations.set(kebab(String(prop)), String(value));
        this.attrs.set("style", [...declarations].map(([k, v]) => k + ": " + v + ";").join(" "));
        return true;
      },
      get: (_, prop) => declarations.get(kebab(String(prop))) ?? ""
    });
  }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get textContent() { return this.childNodes.map((n) => (n instanceof TextNode ? n.data : n.textContent)).join(""); }
  set textContent(value) { this.childNodes = String(value) === "" ? [] : [new TextNode(value)]; }
  get open() { return this.attrs.has("open"); }
  set open(value) { if (value) this.attrs.set("open", ""); else this.attrs.delete("open"); }
  appendChild(node) { this.childNodes.push(node); return node; }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener() {}
}
for (const [prop, attr] of Object.entries(REFLECT)) {
  Object.defineProperty(Element.prototype, prop, {
    configurable: true,
    get() { return this.attrs.has(attr) ? this.attrs.get(attr) : ""; },
    set(value) { this.attrs.set(attr, String(value)); }
  });
}

function serialize(node) {
  if (node instanceof TextNode) return escapeText(node.data);
  // Browsers list an inline style last however it was set, so do the same.
  const ordered = [...node.attrs].sort((x, y) => (x[0] === "style") - (y[0] === "style"));
  const attrs = ordered.map(([name, value]) =>
    BOOLEAN_ATTRS.has(name) ? " " + name : " " + name + '="' + escapeAttr(value) + '"').join("");
  if (VOID.has(node.tagName)) return "<" + node.tagName + attrs + ">";
  return "<" + node.tagName + attrs + ">" + node.childNodes.map(serialize).join("") + "</" + node.tagName + ">";
}

// ---- Run the real storefront for one route ----

function renderRoute(catalogSrc, storefrontSrc, path, siteUrl) {
  const main = new Element("div");
  const stub = () => {
    const el = new Element("div");
    el.classList = { remove() {}, contains: () => false, toggle() {} };
    return el;
  };
  const byId = { main, storeNavToggle: stub(), storeNavLinks: stub() };
  const noop = () => {};
  const document = {
    title: "",
    createElement: (tag) => new Element(tag),
    getElementById: (id) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const url = new URL(path, siteUrl);
  const ctx = {
    URL, document,
    location: { href: url.href, pathname: url.pathname, search: "", hash: "", origin: url.origin },
    history: { pushState: noop, replaceState: noop },
    requestAnimationFrame: noop, scrollTo: noop, addEventListener: noop
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(catalogSrc, ctx, { filename: "storeCatalog.js" });
  vm.runInContext(storefrontSrc, ctx, { filename: "storefront.js" });
  return { title: document.title, html: main.childNodes.map(serialize).join("\n") };
}

// ---- Page assembly ----

const NAV_PROGRAMS = '<li><a href="/store#programs">Programs</a></li>';
const NAV_PROGRAMS_CURRENT = '<li><a href="/store#programs" aria-current="page">Programs</a></li>';

function headBlock(meta) {
  const lines = [
    "<title>" + escapeText(meta.title) + "</title>",
    '<meta name="description" content="' + escapeAttr(meta.description) + '">',
    '<link rel="canonical" href="' + escapeAttr(meta.url) + '">',
    '<meta property="og:site_name" content="Athlevo">',
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="' + escapeAttr(meta.title) + '">',
    '<meta property="og:description" content="' + escapeAttr(meta.description) + '">',
    '<meta property="og:url" content="' + escapeAttr(meta.url) + '">'
  ];
  return "<!-- prerender:head -->\n" + lines.map((l) => "  " + l).join("\n") + "\n  <!-- /prerender:head -->";
}

function replaceRegion(html, name, replacement) {
  const re = new RegExp("<!-- prerender:" + name + " -->[\\s\\S]*?<!-- /prerender:" + name + " -->");
  if (!re.test(html)) throw new Error("store.html is missing the prerender:" + name + " markers");
  return html.replace(re, () => replacement);
}

/** Returns [{ path, content }] for every generated file, relative to the repo root. */
export function buildStorePages(root = ROOT) {
  const catalogSrc = readFileSync(join(root, "js/storeCatalog.js"), "utf8");
  const storefrontSrc = readFileSync(join(root, "js/storefront.js"), "utf8");
  let shell = readFileSync(join(root, "store.html"), "utf8");
  shell = shell.replace(NAV_PROGRAMS_CURRENT, NAV_PROGRAMS);
  if (!shell.includes(NAV_PROGRAMS)) throw new Error("store.html nav no longer has the Programs link this script expects");

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(catalogSrc, sandbox);
  const catalog = sandbox.AthlevoStoreCatalog;

  const routes = [{ slug: null }, ...catalog.products.map((p) => ({ slug: p.slug }))];
  const files = [];
  for (const route of routes) {
    const meta = catalog.seo(route.slug);
    const rendered = renderRoute(catalogSrc, storefrontSrc, meta.path, catalog.siteUrl);
    if (rendered.title !== meta.title) {
      throw new Error("storefront.js set the title \"" + rendered.title + "\" for " + meta.path + ", expected \"" + meta.title + "\"");
    }
    if (!rendered.html) throw new Error("storefront.js rendered nothing for " + meta.path);
    let page = shell;
    if (!route.slug) page = page.replace(NAV_PROGRAMS, NAV_PROGRAMS_CURRENT);
    page = replaceRegion(page, "notice", "<!-- prerender:notice -->\n  " +
      '<div class="notice">' + escapeText(catalog.notice()) + "</div>\n  <!-- /prerender:notice -->");
    page = replaceRegion(page, "head", headBlock(meta));
    page = replaceRegion(page, "main", "<!-- prerender:main -->\n" + rendered.html + "\n<!-- /prerender:main -->");
    files.push({ path: route.slug ? "store-pages/" + route.slug + ".html" : "store.html", content: page });
  }

  const urls = [catalog.siteUrl + "/", ...routes.map((r) => catalog.seo(r.slug).url)];
  files.push({
    path: "sitemap.xml",
    content: '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => "  <url><loc>" + escapeText(u) + "</loc></url>").join("\n") +
      "\n</urlset>\n"
  });
  return files;
}

/** Paths whose content on disk differs from what buildStorePages would write. */
export function staleFiles(root = ROOT) {
  return buildStorePages(root).filter(({ path, content }) => {
    try { return readFileSync(join(root, path), "utf8") !== content; } catch { return true; }
  }).map((f) => f.path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const stale = staleFiles();
    if (stale.length) {
      console.error("Out of date, run: node scripts/build-store-pages.mjs\n  " + stale.join("\n  "));
      process.exit(1);
    }
    console.log("Store pages are up to date.");
  } else {
    const files = buildStorePages();
    mkdirSync(join(ROOT, "store-pages"), { recursive: true });
    for (const { path, content } of files) writeFileSync(join(ROOT, path), content);
    console.log("Wrote " + files.length + " files:\n  " + files.map((f) => f.path).join("\n  "));
  }
}
