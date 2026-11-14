#!/usr/bin/env node
/**
 * Writes the static pages for method.athlevo.org (the Athlevo Method lessons).
 *
 * The lessons are plain HTML with no JavaScript, so search engines and AI crawlers read exactly
 * what a visitor reads. All the words live in content/method.mjs; this script only lays them out.
 *
 * Outputs (all generated, do not edit by hand):
 *   method-pages/lessons.html            /lessons, the hub
 *   method-pages/lessons/<slug>.html     /lessons/<slug>, one per lesson
 *   sitemap-method.xml                   the hub and every lesson, on method.athlevo.org
 *
 * Run after changing content/method.mjs or method.css:
 *   node scripts/build-method-pages.mjs          write the files
 *   node scripts/build-method-pages.mjs --check  fail if any file is out of date
 *
 * Hand-written and not generated: method.css.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITE, HUB, LESSON_CTA, SAFETY_NOTE, LESSONS } from "../content/method.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FONTS = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&family=Inter:wght@400..700&display=swap";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const jsonLd = (obj) => '<script type="application/ld+json">' + JSON.stringify(obj).replace(/</g, "\\u003c") + "</script>";
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Reading order: the order the hub lists the lessons. */
export function readingOrder() {
  const bySlug = new Map(LESSONS.map((l) => [l.slug, l]));
  const order = HUB.groups.flatMap((g) => g.slugs.map((slug) => {
    const lesson = bySlug.get(slug);
    if (!lesson) throw new Error("The hub lists a lesson that does not exist: " + slug);
    return lesson;
  }));
  if (new Set(order.map((l) => l.slug)).size !== order.length) throw new Error("The hub lists a lesson twice");
  if (order.length !== LESSONS.length) throw new Error("Every lesson must be in one hub group (" + order.length + " listed, " + LESSONS.length + " written)");
  return order;
}

const shortTitle = (lesson) => lesson.seoTitle.split(" | ")[0];
const lessonPath = (slug) => "/lessons/" + slug;
const lessonUrl = (slug) => SITE.origin + lessonPath(slug);
const HUB_URL = SITE.origin + HUB.path;

/** Inline text: **bold**, [label](lesson:slug), [label](https://...). Everything else is escaped. */
function inline(raw) {
  const known = new Set(LESSONS.map((l) => l.slug));
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let out = "", at = 0, m;
  while ((m = re.exec(raw))) {
    out += esc(raw.slice(at, m.index));
    if (m[3] !== undefined) {
      out += "<strong>" + esc(m[3]) + "</strong>";
    } else if (m[2].startsWith("lesson:")) {
      const slug = m[2].slice(7);
      if (!known.has(slug)) throw new Error("Link to a lesson that does not exist: " + m[2]);
      out += '<a href="' + lessonPath(slug) + '">' + esc(m[1]) + "</a>";
    } else if (/^https:\/\//.test(m[2])) {
      out += '<a href="' + escAttr(m[2]) + '" rel="noopener">' + esc(m[1]) + "</a>";
    } else {
      throw new Error("Link that is neither a lesson nor https: " + m[2]);
    }
    at = re.lastIndex;
  }
  return out + esc(raw.slice(at));
}

const plain = (raw) => String(raw).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "");

function tableHtml(t) {
  const head = t.head.map((h) => '<th scope="col">' + esc(h) + "</th>").join("");
  const rows = t.rows.map((r) => {
    if (r.length !== t.head.length) throw new Error("Table row has " + r.length + " cells, expected " + t.head.length + ": " + r[0]);
    return "<tr>" + r.map((c, i) => (i === 0 ? '<th scope="row">' + esc(c) + "</th>" : "<td>" + inline(c) + "</td>")).join("") + "</tr>";
  }).join("\n");
  return '<div class="table-wrap" role="region" tabindex="0" aria-label="' + escAttr(t.caption) + '">\n<table>\n<caption>' + esc(t.caption) +
    "</caption>\n<thead><tr>" + head + "</tr></thead>\n<tbody>\n" + rows + "\n</tbody>\n</table>\n</div>";
}

/** The body blocks as HTML, plus the h2 list for the table of contents. */
function bodyHtml(blocks) {
  const toc = [], used = new Set(), out = [];
  for (const b of blocks) {
    if (b.h2) {
      let id = slugify(b.h2), n = 2;
      while (used.has(id)) id = slugify(b.h2) + "-" + n++;
      used.add(id);
      toc.push({ id, text: b.h2 });
      out.push('<h2 id="' + id + '">' + esc(b.h2) + "</h2>");
    } else if (b.h3) out.push("<h3>" + esc(b.h3) + "</h3>");
    else if (b.p) out.push("<p>" + inline(b.p) + "</p>");
    else if (b.ul) out.push("<ul>\n" + b.ul.map((x) => "<li>" + inline(x) + "</li>").join("\n") + "\n</ul>");
    else if (b.ol) out.push("<ol>\n" + b.ol.map((x) => "<li>" + inline(x) + "</li>").join("\n") + "\n</ol>");
    else if (b.table) out.push(tableHtml(b.table));
    else if (b.note) out.push('<p class="note">' + inline(b.note) + "</p>");
    else throw new Error("Unknown block: " + JSON.stringify(b).slice(0, 80));
  }
  return { html: out.join("\n"), toc };
}

function textOfLesson(l) {
  const parts = [l.lead, ...l.short];
  for (const b of l.body) {
    if (b.h2 || b.h3 || b.p || b.note) parts.push(plain(b.h2 || b.h3 || b.p || b.note));
    else if (b.ul || b.ol) parts.push(...(b.ul || b.ol).map(plain));
    else if (b.table) b.table.rows.forEach((r) => parts.push(...r.map(plain)));
  }
  return parts.join(" ");
}
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
const readMinutes = (words) => Math.max(1, Math.round(words / 200));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error("Not an ISO date: " + iso);
  return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1];
}

function cssVersion(root) {
  return createHash("sha1").update(readFileSync(join(root, "method.css"))).digest("hex").slice(0, 8);
}

function headBlock({ title, description, url, type, css, extra = "", ld }) {
  const lines = [
    "<title>" + esc(title) + "</title>",
    '<meta name="description" content="' + escAttr(description) + '">',
    '<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">',
    '<link rel="canonical" href="' + escAttr(url) + '">',
    '<meta property="og:site_name" content="Athlevo">',
    '<meta property="og:locale" content="en_PH">',
    '<meta property="og:type" content="' + type + '">',
    '<meta property="og:title" content="' + escAttr(title) + '">',
    '<meta property="og:description" content="' + escAttr(description) + '">',
    '<meta property="og:url" content="' + escAttr(url) + '">',
    '<meta name="twitter:card" content="summary">',
    '<meta name="twitter:title" content="' + escAttr(title) + '">',
    '<meta name="twitter:description" content="' + escAttr(description) + '">',
    '<meta name="theme-color" content="#0a0a0b">'
  ];
  if (extra) lines.push(extra);
  return [
    "<!DOCTYPE html>", '<html lang="en">', "<head>", '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    ...lines.map((l) => "  " + l),
    '  <link rel="icon" type="image/png" href="/assets/athlevo-ae-icon.png">',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '  <link href="' + FONTS + '" rel="stylesheet">',
    '  <link rel="stylesheet" href="/method.css?v=' + css + '">',
    "  " + jsonLd(ld), "</head>"
  ].join("\n");
}

function siteHeader(current) {
  return [
    '<a class="skip" href="#main">Skip to main content</a>',
    '<header class="site-header">',
    '  <nav class="nav" aria-label="Main">',
    '    <a class="wordmark" href="' + HUB.path + '">Athlevo<i aria-hidden="true">.</i><span class="wordmark-tag">Method</span></a>',
    '    <ul class="nav-links">',
    '      <li><a href="' + HUB.path + '"' + (current === "hub" ? ' aria-current="page"' : "") + ">Lessons</a></li>",
    '      <li><a href="' + SITE.programsUrl + '">Programs</a></li>',
    "    </ul>",
    "  </nav>",
    "</header>"
  ].join("\n");
}

function siteFooter(order) {
  return [
    '<footer class="site-footer">',
    '  <div class="wrap">',
    '    <div class="footer-cols">',
    "      <div>", '        <h2 class="footer-h">Lessons</h2>', "        <ul>",
    ...order.map((l) => '          <li><a href="' + lessonPath(l.slug) + '">' + esc(shortTitle(l)) + "</a></li>"),
    "        </ul>", "      </div>",
    "      <div>", '        <h2 class="footer-h">Athlevo</h2>', "        <ul>",
    '          <li><a href="' + SITE.programsUrl + '">Athlevo programs</a></li>',
    '          <li><a href="' + SITE.appOrigin + '/">Athlevo home</a></li>',
    '          <li><a href="' + SITE.appOrigin + '/support">Support</a></li>',
    "        </ul>", "      </div>",
    "      <div>", '        <h2 class="footer-h">Legal</h2>', "        <ul>",
    '          <li><a href="' + SITE.appOrigin + '/privacy">Privacy</a></li>',
    '          <li><a href="' + SITE.appOrigin + '/terms">Terms</a></li>',
    "        </ul>", "      </div>",
    "    </div>",
    '    <p class="copyright">© 2026 Athlevo. All rights reserved.</p>',
    "  </div>",
    "</footer>"
  ].join("\n");
}

const orgNode = () => ({ "@type": "Organization", "@id": SITE.orgId, name: SITE.brand, url: SITE.appOrigin + "/" });
const authorNode = () => ({
  "@type": "Person", "@id": SITE.authorId, name: SITE.author.name, jobTitle: SITE.author.title, worksFor: { "@id": SITE.orgId }
});

function lessonCard(lesson, number) {
  return '<li><a class="lesson-card" href="' + lessonPath(lesson.slug) + '"><span class="lesson-num">' + String(number).padStart(2, "0") +
    '</span><span class="lesson-title">' + esc(shortTitle(lesson)) + '</span><span class="lesson-sum">' + esc(lesson.summary) + "</span></a></li>";
}

function ctaBlock(cta, id) {
  return '<section class="cta-box" aria-labelledby="' + id + '">\n<h2 id="' + id + '">' + esc(cta.heading) + "</h2>\n<p>" + esc(cta.text) +
    '</p>\n<a class="btn" href="' + escAttr(cta.href) + '">' + esc(cta.label) + "</a>\n</section>";
}

function buildHub(order, css) {
  const number = new Map(order.map((l, i) => [l.slug, i + 1]));
  const bySlug = new Map(LESSONS.map((l) => [l.slug, l]));
  const groups = HUB.groups.map((g, i) =>
    '<section class="section" aria-labelledby="g' + i + '">\n<div class="wrap">\n<h2 id="g' + i + '">' + esc(g.heading) + '</h2>\n<ol class="lesson-list">\n' +
    g.slugs.map((s) => lessonCard(bySlug.get(s), number.get(s))).join("\n") + "\n</ol>\n</div>\n</section>").join("\n");
  const ideas = HUB.ideas;
  const ideasHtml = '<section class="section alt" aria-labelledby="ideas">\n<div class="wrap">\n<h2 id="ideas">' + esc(ideas.heading) + "</h2>\n<p class=\"section-lead\">" + esc(ideas.intro) +
    '</p>\n<ul class="idea-grid">\n' + ideas.items.map((i) => '<li><h3>' + esc(i.name) + "</h3><p>" + esc(i.does) + '</p><a href="' + lessonPath(i.slug) + '">Read the lesson</a></li>').join("\n") +
    "\n</ul>\n</div>\n</section>";
  const note = '<section class="section" aria-labelledby="design">\n<div class="wrap"><div class="prose">\n<h2 id="design">' + esc(HUB.designNote.heading) + "</h2>\n<p>" + inline(HUB.designNote.text) + "</p>\n</div></div>\n</section>";
  const faq = '<section class="section alt" aria-labelledby="faq">\n<div class="wrap"><div class="prose">\n<h2 id="faq">Questions</h2>\n' +
    HUB.faq.map((f) => "<h3>" + esc(f.q) + "</h3>\n<p>" + inline(f.a) + "</p>").join("\n") + "\n</div></div>\n</section>";
  const main = [
    '<main id="main">',
    '<section class="hero">\n<div class="wrap">\n<p class="eyebrow">' + esc(SITE.brand) + " Method, version " + esc(SITE.version) + "</p>\n<h1>" + esc(HUB.h1Before) + " <em>" + esc(HUB.h1Key) +
      "</em></h1>\n<p class=\"hero-sub\">" + esc(HUB.tagline) + "</p>\n</div>\n</section>",
    '<section class="section">\n<div class="wrap"><div class="prose">\n' + HUB.intro.map((p) => "<p>" + inline(p) + "</p>").join("\n") + "\n</div></div>\n</section>",
    groups, ideasHtml, note, faq,
    '<section class="section">\n<div class="wrap">\n' + ctaBlock(HUB.cta, "cta") + "\n</div>\n</section>",
    "</main>"
  ].join("\n");

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      orgNode(), authorNode(),
      { "@type": "WebSite", "@id": SITE.origin + "/#website", url: SITE.origin + "/", name: SITE.name, inLanguage: "en", publisher: { "@id": SITE.orgId } },
      {
        "@type": "CollectionPage", "@id": HUB_URL + "#collection", url: HUB_URL, name: HUB.seoTitle, description: HUB.description, inLanguage: "en",
        isPartOf: { "@id": SITE.origin + "/#website" }, author: { "@id": SITE.authorId }, publisher: { "@id": SITE.orgId },
        datePublished: SITE.published, dateModified: SITE.updated,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: order.map((l, i) => ({ "@type": "ListItem", position: i + 1, url: lessonUrl(l.slug), name: shortTitle(l) }))
        }
      }
    ]
  };
  const html = [headBlock({ title: HUB.seoTitle, description: HUB.description, url: HUB_URL, type: "website", css, ld }),
    "<body>", siteHeader("hub"), main, siteFooter(order), "</body>", "</html>", ""].join("\n");
  return { path: "method-pages/lessons.html", content: html };
}

function buildLesson(lesson, order, css) {
  const at = order.findIndex((l) => l.slug === lesson.slug);
  const prev = order[at - 1], next = order[at + 1];
  const body = bodyHtml(lesson.body);
  const text = textOfLesson(lesson);
  const words = wordCount(text);
  const url = lessonUrl(lesson.slug);
  const bySlug = new Map(LESSONS.map((l) => [l.slug, l]));

  const toc = body.toc.length >= 3
    ? '<nav class="toc" aria-labelledby="toc-h">\n<h2 id="toc-h">On this page</h2>\n<ol>\n' + body.toc.map((t) => '<li><a href="#' + t.id + '">' + esc(t.text) + "</a></li>").join("\n") + "\n</ol>\n</nav>"
    : "";
  const sources = lesson.sources.length
    ? '<section class="sources" aria-labelledby="src-h">\n<h2 id="src-h">Sources</h2>\n<ol>\n' +
      lesson.sources.map((s) => '<li><a href="' + escAttr(s.url) + '" rel="noopener">' + esc(s.label) + "</a></li>").join("\n") + "\n</ol>\n</section>"
    : "";
  const related = lesson.related.map((s) => {
    const l = bySlug.get(s);
    if (!l) throw new Error(lesson.slug + " relates to a lesson that does not exist: " + s);
    return lessonCard(l, order.indexOf(l) + 1);
  }).join("\n");
  const pager = '<nav class="pager" aria-label="Lesson navigation">\n' +
    (prev ? '<a class="pager-prev" href="' + lessonPath(prev.slug) + '"><span>Previous lesson</span>' + esc(shortTitle(prev)) + "</a>" : "<span></span>") + "\n" +
    (next ? '<a class="pager-next" href="' + lessonPath(next.slug) + '"><span>Next lesson</span>' + esc(shortTitle(next)) + "</a>" : "<span></span>") + "\n</nav>";

  const main = [
    '<main id="main">',
    '<div class="wrap article-wrap">',
    '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="' + HUB.path + '">' + esc(SITE.name) + "</a></li><li aria-current=\"page\">" + esc(shortTitle(lesson)) + "</li></ol></nav>",
    '<article class="lesson">',
    '<header class="lesson-head">',
    '<p class="eyebrow">Lesson ' + (at + 1) + " of " + order.length + "</p>",
    "<h1>" + esc(lesson.h1) + "</h1>",
    '<p class="byline">By ' + esc(SITE.author.name) + ", " + esc(SITE.author.title) + " at " + esc(SITE.brand) + '. Updated <time datetime="' + SITE.updated + '">' + longDate(SITE.updated) + "</time>. " + readMinutes(words) + " minute read.</p>",
    '<p class="lead">' + inline(lesson.lead) + "</p>",
    "</header>",
    '<aside class="short" aria-labelledby="short-h">\n<h2 id="short-h">In short</h2>\n<ul>\n' + lesson.short.map((s) => "<li>" + inline(s) + "</li>").join("\n") + "\n</ul>\n</aside>",
    toc,
    '<div class="prose">',
    body.html,
    "</div>",
    sources,
    '<p class="design-note">' + esc(lesson.designNote) + "</p>",
    '<p class="design-note">' + esc(SAFETY_NOTE) + "</p>",
    "</article>",
    pager,
    '<section class="related" aria-labelledby="related-h">\n<h2 id="related-h">Keep reading</h2>\n<ol class="lesson-list">\n' + related + "\n</ol>\n</section>",
    ctaBlock(LESSON_CTA, "cta"),
    "</div>",
    "</main>"
  ].filter(Boolean).join("\n");

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      orgNode(), authorNode(),
      {
        "@type": "Article", "@id": url + "#article", headline: lesson.h1, description: lesson.description, url, inLanguage: "en",
        mainEntityOfPage: { "@type": "WebPage", "@id": url }, datePublished: SITE.published, dateModified: SITE.updated, wordCount: words,
        author: { "@id": SITE.authorId }, publisher: { "@id": SITE.orgId }, isPartOf: { "@id": HUB_URL + "#collection" },
        ...(lesson.sources.length ? { citation: lesson.sources.map((s) => ({ "@type": "CreativeWork", name: s.label, url: s.url })) } : {})
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE.name, item: HUB_URL },
          { "@type": "ListItem", position: 2, name: shortTitle(lesson), item: url }
        ]
      }
    ]
  };
  const extra = [
    '<meta name="author" content="' + escAttr(SITE.author.name) + '">',
    '<meta property="article:published_time" content="' + SITE.published + '">',
    '<meta property="article:modified_time" content="' + SITE.updated + '">'
  ].join("\n  ");
  const html = [headBlock({ title: lesson.seoTitle, description: lesson.description, url, type: "article", css, extra, ld }),
    "<body>", siteHeader("lesson"), main, siteFooter(order), "</body>", "</html>", ""].join("\n");
  return { path: "method-pages/lessons/" + lesson.slug + ".html", content: html };
}

/** Returns [{ path, content }] for every generated file, relative to the repo root. */
export function buildMethodPages(root = ROOT) {
  const order = readingOrder();
  const css = cssVersion(root);
  const files = [buildHub(order, css), ...order.map((l) => buildLesson(l, order, css))];
  const urls = [HUB_URL, ...order.map((l) => lessonUrl(l.slug))];
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => "  <url><loc>" + esc(u) + "</loc><lastmod>" + SITE.updated + "</lastmod></url>").join("\n") + "\n</urlset>\n";
  files.push({ path: "sitemap-method.xml", content: sitemap });
  return files;
}

/** Paths whose content on disk differs from what buildMethodPages would write. */
export function staleFiles(root = ROOT) {
  return buildMethodPages(root).filter(({ path, content }) => {
    try { return readFileSync(join(root, path), "utf8") !== content; } catch { return true; }
  }).map((f) => f.path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const stale = staleFiles();
    if (stale.length) {
      console.error("Out of date, run: node scripts/build-method-pages.mjs\n  " + stale.join("\n  "));
      process.exit(1);
    }
    console.log("Method pages are up to date.");
  } else {
    const files = buildMethodPages();
    mkdirSync(join(ROOT, "method-pages/lessons"), { recursive: true });
    for (const { path, content } of files) writeFileSync(join(ROOT, path), content);
    console.log("Wrote " + files.length + " files:\n  " + files.map((f) => f.path).join("\n  "));
  }
}
