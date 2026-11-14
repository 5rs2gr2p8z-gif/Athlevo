/**
 * method.athlevo.org: the Athlevo Method lessons (see docs/method-site.md).
 *
 * Run: node tests/method-site.test.mjs
 *
 * The pages are generated from content/method.mjs by scripts/build-method-pages.mjs and
 * committed. This file checks that they are current, that each one carries the SEO structure
 * it was built for, that vercel.json routes the host the way the docs say, that the preview
 * server agrees with vercel.json, and that the copy keeps to the Athlevo writing rules.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { buildMethodPages, staleFiles, readingOrder } from "../scripts/build-method-pages.mjs";
import { SITE, HUB, LESSONS } from "../content/method.mjs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const robots = readFileSync("./robots.txt", "utf8");
const sw = readFileSync("./service-worker.js", "utf8");
const css = readFileSync("./method.css", "utf8");
const sitemap = readFileSync("./sitemap-method.xml", "utf8");
const order = readingOrder();
const hubHtml = readFileSync("./method-pages/lessons.html", "utf8");
const lessonHtml = Object.fromEntries(order.map((l) => [l.slug, readFileSync("./method-pages/lessons/" + l.slug + ".html", "utf8")]));
const pages = [{ name: "hub", url: SITE.origin + HUB.path, html: hubHtml, hub: true },
  ...order.map((l) => ({ name: l.slug, url: SITE.origin + "/lessons/" + l.slug, html: lessonHtml[l.slug], lesson: l }))];

const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const tag = (html, re) => { const m = html.match(re); return m ? m[1] : null; };
const titleOf = (html) => tag(html, /<title>([^<]*)<\/title>/);
const descOf = (html) => tag(html, /<meta name="description" content="([^"]*)">/);
const canonOf = (html) => tag(html, /<link rel="canonical" href="([^"]*)">/);
const h1sOf = (html) => [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/g)].map((m) => text(m[0]).trim());
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

section("1. Generated files are current");
{
  t("the lesson count is 11 and every lesson is in exactly one hub group", LESSONS.length === 11 && order.length === 11);
  t("every generated file on disk matches what the generator writes (run: node scripts/build-method-pages.mjs)",
    staleFiles().length === 0, staleFiles().join(", "));
  t("the generator writes the hub, one page per lesson and the sitemap (13 files)", buildMethodPages().length === 13);
  t("package.json has build:method and test:method",
    /"build:method": "node scripts\/build-method-pages\.mjs"/.test(readFileSync("./package.json", "utf8")) &&
    /"test:method": "node tests\/method-site\.test\.mjs"/.test(readFileSync("./package.json", "utf8")));
  t("no serverless function was added for the lesson site (the Vercel Hobby plan allows 12)",
    !existsSync("./api/method") && !readdirSync("./api").some((f) => /method|lesson/i.test(f)));
}

section("2. SEO basics on every page");
{
  const titles = pages.map((p) => titleOf(p.html));
  const descs = pages.map((p) => descOf(p.html));
  t("every page has a title of 65 characters or fewer, and all titles are different",
    titles.every((x) => x && x.length <= 65) && new Set(titles).size === pages.length, titles.map((x) => x && x.length).join(","));
  t("every page has a meta description of 70 to 160 characters, and all are different",
    descs.every((d) => d && d.length >= 70 && d.length <= 160) && new Set(descs).size === pages.length, descs.map((d) => d && d.length).join(","));
  t("every page has exactly one h1, all different, and the h1 is not the title",
    pages.every((p) => h1sOf(p.html).length === 1) && new Set(pages.map((p) => h1sOf(p.html)[0])).size === pages.length);
  t("every page names its own address (no trailing slash) as canonical, on the method host",
    pages.every((p) => canonOf(p.html) === p.url && p.url.startsWith("https://method.athlevo.org/lessons")));
  t("every page can be indexed and has a page-level robots meta that allows rich snippets",
    pages.every((p) => /<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large/.test(p.html) && !/noindex/i.test(p.html)));
  t("every page has Open Graph and Twitter tags that match its title and description",
    pages.every((p) => tag(p.html, /<meta property="og:title" content="([^"]*)">/) === titleOf(p.html) &&
      tag(p.html, /<meta property="og:description" content="([^"]*)">/) === descOf(p.html) &&
      tag(p.html, /<meta property="og:url" content="([^"]*)">/) === p.url &&
      /<meta name="twitter:card" content="summary">/.test(p.html) &&
      tag(p.html, /<meta name="twitter:title" content="([^"]*)">/) === titleOf(p.html)));
  t("every page declares English and a mobile viewport",
    pages.every((p) => /<html lang="en">/.test(p.html) && /<meta name="viewport" content="width=device-width, initial-scale=1">/.test(p.html)));
  t("no page loads a script other than its JSON-LD (static, no JavaScript on the method host)",
    pages.every((p) => [...p.html.matchAll(/<script\b[^>]*>/g)].every((m) => /type="application\/ld\+json"/.test(m[0]))) &&
    pages.every((p) => !/\son[a-z]+=/i.test(p.html) && !/<form\b|<iframe\b|<input\b/i.test(p.html)));
  t("every page loads the shared stylesheet with a version query and no other local stylesheet",
    pages.every((p) => /<link rel="stylesheet" href="\/method\.css\?v=[0-9a-f]{8}">/.test(p.html) &&
      [...p.html.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].every((m) => m[1].startsWith("/method.css?v="))));
  t("the Brand DNA fonts are the only fonts loaded (Barlow Condensed bold and Inter)",
    pages.every((p) => /family=Barlow\+Condensed:wght@700&family=Inter:wght@400\.\.700/.test(p.html)) &&
    /--display:\s*"Barlow Condensed"/.test(css) && /--sans:\s*"Inter"/.test(css) && /--red:\s*#cc0010/i.test(css));
  t("the page has a skip link, one main landmark and a footer with the lesson list",
    pages.every((p) => /<a class="skip" href="#main">/.test(p.html) && (p.html.match(/<main\b/g) || []).length === 1 && /<footer class="site-footer">/.test(p.html)));
}

section("3. Structured data");
{
  const bad = [];
  for (const p of pages) {
    let ld;
    try { ld = ldOf(p.html); } catch (e) { bad.push(p.name + ": invalid JSON-LD"); continue; }
    const graph = ld.flatMap((b) => b["@graph"] || [b]);
    const types = graph.flatMap((n) => [n["@type"], n.mainEntity && n.mainEntity["@type"]]).filter(Boolean);
    if (ld.length !== 1) bad.push(p.name + ": expected one JSON-LD block");
    if (!types.includes("Organization") || !types.includes("Person")) bad.push(p.name + ": missing Organization or Person");
    const org = graph.find((n) => n["@type"] === "Organization");
    const person = graph.find((n) => n["@type"] === "Person");
    if (!org || org["@id"] !== SITE.orgId) bad.push(p.name + ": Organization @id");
    if (!person || person["@id"] !== SITE.authorId || person.name !== "Dean Castro") bad.push(p.name + ": Person");
    if (p.hub) {
      if (!types.includes("WebSite") || !types.includes("CollectionPage") || !types.includes("ItemList")) bad.push("hub: WebSite, CollectionPage and ItemList");
      const list = (graph.find((n) => n["@type"] === "CollectionPage") || {}).mainEntity;
      if (!list || (list.itemListElement || []).length !== 11) bad.push("hub: ItemList needs 11 items");
      else if (!list.itemListElement.every((el, i) => el.position === i + 1 && el.url === SITE.origin + "/lessons/" + order[i].slug)) bad.push("hub: ItemList order or urls");
    } else {
      const art = graph.find((n) => n["@type"] === "Article");
      const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList");
      if (!art) bad.push(p.name + ": Article");
      else {
        if (art.headline !== h1sOf(p.html)[0]) bad.push(p.name + ": headline is not the h1");
        if (art.datePublished !== SITE.published || art.dateModified !== SITE.updated) bad.push(p.name + ": dates");
        if (!art.author || art.author["@id"] !== SITE.authorId) bad.push(p.name + ": author");
        if (!art.publisher || art.publisher["@id"] !== SITE.orgId) bad.push(p.name + ": publisher");
        if (JSON.stringify(art.mainEntityOfPage || "").indexOf(p.url) < 0) bad.push(p.name + ": mainEntityOfPage");
      }
      if (!crumbs || crumbs.itemListElement.length !== 2 || crumbs.itemListElement[1].name === undefined) bad.push(p.name + ": BreadcrumbList");
    }
  }
  t("every page has valid JSON-LD that matches what is on the page (" + pages.length + " checked)", bad.length === 0, bad.join(" | "));
  t("the structured data makes no review, rating, price or FAQ claim",
    pages.every((p) => !/"(aggregateRating|review|offers|price|FAQPage|Question)"/.test(p.html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)[0])));
}

section("4. Page structure a reader and a crawler both use");
{
  const bad = [];
  for (const { lesson, html, name } of pages.filter((p) => p.lesson)) {
    const h2s = (lesson.body || []).filter((b) => b.h2).length;
    if (!/<nav class="crumbs" aria-label="Breadcrumb">/.test(html)) bad.push(name + ": breadcrumb");
    if (!new RegExp('<p class="eyebrow">Lesson ' + (order.indexOf(lesson) + 1) + " of 11</p>").test(html)) bad.push(name + ": lesson number");
    if (!/<p class="byline">By Dean Castro, Founder and Head Coach at Athlevo\. Updated <time datetime="2026-11-14">/.test(html)) bad.push(name + ": byline and date");
    if (!/<aside class="short"/.test(html)) bad.push(name + ": In short box");
    if (!/<nav class="pager"/.test(html)) bad.push(name + ": prev and next");
    if (!/<section class="related"/.test(html)) bad.push(name + ": related lessons");
    if (!/<section class="cta-box"/.test(html)) bad.push(name + ": call to action");
    if (h2s >= 3 && !/<nav class="toc"/.test(html)) bad.push(name + ": table of contents");
    if (lesson.sources && lesson.sources.length && !/<section class="sources"/.test(html)) bad.push(name + ": sources");
    if (!html.includes("This lesson is general training education. It is not medical advice.")) bad.push(name + ": safety note");
    // Heading levels never skip: no h3 before the first h2, no h4.
    if (/<h4\b/.test(html)) bad.push(name + ": h4");
    // Every table has a caption, a header row and sits in the scroll wrapper.
    for (const tbl of html.matchAll(/<table>[\s\S]*?<\/table>/g)) {
      if (!/<caption>/.test(tbl[0]) || !/<thead>/.test(tbl[0]) || !/scope="col"/.test(tbl[0])) bad.push(name + ": table caption, head or scope");
    }
    if ((html.match(/<table>/g) || []).length !== (html.match(/<div class="table-wrap"/g) || []).length) bad.push(name + ": table-wrap");
  }
  t("every lesson has a breadcrumb, lesson number, byline with date, In short box, contents, previous and next, related lessons, sources, a safety note and a call to action (11 checked)",
    bad.length === 0, bad.join(" | "));
  const chain = order.map((l, i) => {
    const prev = order[i - 1], next = order[i + 1];
    const h = lessonHtml[l.slug];
    return (prev ? h.includes('class="pager-prev" href="/lessons/' + prev.slug + '"') : !h.includes("pager-prev")) &&
      (next ? h.includes('class="pager-next" href="/lessons/' + next.slug + '"') : !h.includes("pager-next"));
  });
  t("previous and next follow the hub's reading order, with no link past either end", chain.every(Boolean));
}

section("5. Internal links and sitemap");
{
  const known = new Set(["/lessons", ...order.map((l) => "/lessons/" + l.slug)]);
  const strays = [];
  const inbound = new Map(order.map((l) => [l.slug, 0]));
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (href.startsWith("#") || /^https?:/.test(href) || href.startsWith("mailto:")) continue;
      const path = href.split("#")[0].split("?")[0];
      if (path === "/method.css" || path.startsWith("/assets/")) { if (!existsSync("." + path)) strays.push(p.name + " -> " + href); continue; }
      if (!known.has(path)) strays.push(p.name + " -> " + href);
      else if (path.startsWith("/lessons/") && p.name !== path.slice(9)) inbound.set(path.slice(9), inbound.get(path.slice(9)) + 1);
    }
  }
  t("every internal link and local file on every page resolves (to a lesson, the hub or a file that exists)", strays.length === 0, strays.join(", "));
  t("every lesson is linked from the hub and from at least three other pages (no orphans)",
    order.every((l) => hubHtml.includes('href="/lessons/' + l.slug + '"')) && [...inbound.values()].every((n) => n >= 3), JSON.stringify([...inbound]));
  t("fragment links point at ids that exist on the same page",
    pages.every((p) => [...p.html.matchAll(/href="#([^"]+)"/g)].every((m) => m[1] === "main" || p.html.includes('id="' + m[1] + '"'))));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  t("sitemap-method.xml lists the hub and the 11 lessons, once each, each with a lastmod",
    locs.length === 12 && new Set(locs).size === 12 && pages.every((p) => locs.includes(p.url)) &&
    (sitemap.match(/<lastmod>2026-11-14<\/lastmod>/g) || []).length === 12);
  t("every sitemap address is the canonical address of its page", locs.every((u) => pages.some((p) => canonOf(p.html) === u)));
  t("robots.txt allows crawling and lists the method sitemap beside the other two",
    /^User-agent: \*\nAllow: \//m.test(robots) && !/Disallow:\s*\/\s*$/m.test(robots) &&
    ["https://athlevo.org/sitemap.xml", "https://programs.athlevo.org/sitemap-programs.xml", "https://method.athlevo.org/sitemap-method.xml"].every((s) => robots.includes("Sitemap: " + s)));
  t("the apex sitemap does not list the method pages (each host lists its own)", !readFileSync("./sitemap.xml", "utf8").includes("/lessons"));
}

section("6. Links out");
{
  const bad = [];
  for (const p of pages) {
    for (const m of p.html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>/g)) {
      const href = m[1];
      if (href.startsWith("http://")) bad.push(p.name + ": insecure " + href);
      const own = /^https:\/\/(?:[a-z]+\.)?athlevo\.org(?:\/|$)/.test(href);
      if (!own && !/rel="[^"]*noopener[^"]*"/.test(m[0])) bad.push(p.name + ": external link without noopener " + href);
    }
  }
  t("every external link is https and opens safely", bad.length === 0, bad.join(" | "));
  t("the lessons send the reader to the programs page and the app, never to a checkout or a payment address",
    pages.every((p) => ![...p.html.matchAll(/href="([^"]+)"/g)].some((m) => /checkout|paymongo|whop|\/api\//i.test(m[1]))));
  t("the call to action goes to the programs page on programs.athlevo.org",
    order.every((l) => /<section class="cta-box"[\s\S]*?href="https:\/\/programs\.athlevo\.org\/programs"/.test(lessonHtml[l.slug])));
  t("every research source in the lessons is a link to a page and is listed under Sources",
    LESSONS.every((l) => (l.sources || []).every((s) => /^https:\/\//.test(s.url) && lessonHtml[l.slug].includes('href="' + s.url.replace(/&/g, "&amp;") + '"'))));
}

section("7. Copy rules");
{
  const bodies = pages.map((p) => ({ name: p.name, txt: text(p.html) }));
  const hit = (re) => bodies.filter((b) => re.test(b.txt)).map((b) => b.name + ": " + (b.txt.match(re) || [""])[0]);
  const raw = pages.map((p) => ({ name: p.name, html: p.html }));
  t("no em dash or en dash anywhere on the pages", raw.every((p) => !/[–—]/.test(p.html)));
  t("distances use a lowercase k and km (never 10K or 5 K or KM)", hit(/\b\d+(?:\.\d+)?\s?K\b(?!g)|\b\d+\s?KM\b/).length === 0, hit(/\b\d+(?:\.\d+)?\s?K\b(?!g)|\b\d+\s?KM\b/).join(" | "));
  t("no hype, urgency or guarantee wording",
    hit(/\b(guarantee[sd]?|guaranteed|miracle|secret|hack|game[- ]chang\w+|revolutionary|limited time|hurry|don'?t miss|last chance|only \d+ (?:spots|slots)|act now|ultimate|best ever|unlock your)\b/i).length === 0,
    hit(/\b(guarantee[sd]?|miracle|secret|hack|game[- ]chang\w+|revolutionary|limited time|hurry|last chance|act now|ultimate|unlock your)\b/i).join(" | "));
  t("no promise of a result or a finishing time",
    hit(/\b(will (?:run|get|become|make) (?:you )?(?:faster|a (?:sub|pb|pr))|you will (?:hit|break|beat|run) |sub-?\d+ (?:is )?guaranteed|results? (?:in|within) \d+ (?:weeks?|days?))\b/i).length === 0);
  t("no statement of how many clients a coach handles or how many athletes Athlevo has",
    hit(/\b(?:\d[\d,]*\+? (?:athletes|runners|clients|coaches|members)|(?:coach(?:es)? (?:handles?|works? with|has|looks after)) \d)/i).length === 0, hit(/\b\d[\d,]*\+? (?:athletes|runners|clients)\b/i).join(" | "));
  t("no emoji, exclamation marks or all-capital shouting in the copy",
    bodies.every((b) => !/\p{Extended_Pictographic}/u.test(b.txt.replace(/\u00a9/g, "")) && !/!/.test(b.txt) && !/\b[A-Z]{12,}\b/.test(b.txt)));
  t("the copy is English only (ASCII, the degree sign, the peso, the copyright sign and the accent in one author's name in a citation)",
    bodies.every((b) => !/[^\u0000-\u007f\u00b0\u20b1\u00d7\u2192\u2264\u2265\u00b1\u2248\u2018\u2019\u201c\u201d\u2026\u00a0\u00b7\u2022\u00a9\u00e9]/.test(b.txt)));
  t("the lessons do not claim to be medical advice, a diagnosis or a cure, and each carries the safety note",
    !hit(/\b(cures?|diagnos(?:e|es|is) (?:you|your)|prevents? (?:injury|injuries)|injury[- ]proof)\b/i).length && pages.filter((p) => p.lesson).every((p) => p.html.includes("not medical advice")));
  t("no lesson shows the 12-week sample block, the ASR reference ranges or an unverified taper percentage (left out until checked, see docs/method-site.md)",
    !hit(/\bweek 1[0-2]\b.*\bweek 1\b/i).length && !hit(/\bASR\b[^.]{0,80}\b(?:<|>|below|above|over|under) ?\d+(?:\.\d+)? ?(?:km\/h|m\/s|%)/i).length &&
    !hit(/\b(?:30|40|41|60)\s?(?:to|-)\s?(?:40|60)%\b/).length);
  t("every H1 is a plain phrase with no more than 70 characters", pages.every((p) => h1sOf(p.html)[0].length <= 70));
  t("red is only used as the key word on the hub and on the call to action button (the stylesheet keeps it to a few rules)",
    (css.match(/var\(--red(?:-deep|-on-dark)?\)/g) || []).length <= 14);
}

section("8. Routing in vercel.json (the host, the old addresses and the other hosts)");
{
  // A small stand-in for how Vercel reads vercel.json: redirects first, then real files,
  // then rewrites. Same helpers as tests/store-route.test.mjs section 11.
  const toRegExp = (source) => {
    let out = "", i = 0;
    while (i < source.length) {
      const param = /^\/:\w+/.exec(source.slice(i));
      if (!param) { out += source[i] === "." ? "\\." : source[i]; i++; continue; }
      i += param[0].length;
      if (source[i] !== "(") { out += "/[^/]+"; continue; }
      let depth = 0, j = i;
      for (; j < source.length; j++) {
        if (source[j] === "\\") { j++; continue; }
        if (source[j] === "(") depth++;
        else if (source[j] === ")" && --depth === 0) break;
      }
      out += "/(?:" + source.slice(i + 1, j) + ")";
      i = j + 1;
    }
    return new RegExp("^" + out + "$");
  };
  const hostOk = (rule, host) =>
    (rule.has || []).every((c) => c.type === "host" && new RegExp("^" + c.value + "$").test(host)) &&
    (rule.missing || []).every((c) => c.type === "host" && !new RegExp("^" + c.value + "$").test(host));
  const fillIn = (dest, path) => dest.replace(/:path\b/, () => path.slice(1)).replace(/:slug\b/, () => path.replace(/\/+$/, "").split("/").pop());
  const STATIC_FILES = (p) => ["/", "/index.html", "/store.html", "/store.css", "/robots.txt", "/sitemap.xml", "/sitemap-programs.xml", "/sitemap-method.xml", "/method.css", "/webinar.css", "/virtual-run.css", "/virtual-run.html"].includes(p) ||
    /^\/(assets|js|athlevo-assets|store-pages)\//.test(p);
  const viaVercel = (host, path) => {
    for (const r of vercel.redirects) {
      if (!toRegExp(r.source).test(path) || !hostOk(r, host)) continue;
      return { status: r.permanent ? 308 : 307, location: fillIn(r.destination, path) };
    }
    if (STATIC_FILES(path)) return { status: 200, file: path === "/" ? "/index.html" : path };
    for (const r of vercel.rewrites) {
      if (!toRegExp(r.source).test(path) || !hostOk(r, host)) continue;
      return { status: 200, rewrite: fillIn(r.destination, path).split("?")[0] };
    }
    return { status: 404 };
  };

  const M = SITE.host, MO = SITE.origin, APP = "https://athlevo.org", P = "programs.athlevo.org", PREVIEW = "athlevo-ai.vercel.app";
  const slugs = order.map((l) => l.slug);
  const table = [
    [M, "/", { status: 308, location: "/lessons" }],
    [M, "/lessons", { status: 200, rewrite: "/method-pages/lessons.html" }],
    [M, "/lessons/", { status: 200, rewrite: "/method-pages/lessons.html" }],
    ...slugs.flatMap((s) => [
      [M, "/lessons/" + s, { status: 200, rewrite: "/method-pages/lessons/" + s + ".html" }],
      [M, "/lessons/" + s + "/", { status: 200, rewrite: "/method-pages/lessons/" + s + ".html" }],
      // athlevo.org sends the lessons over in one hop. A preview deployment serves them under /lessons.
      ["athlevo.org", "/lessons/" + s, { status: 307, location: MO + "/lessons/" + s }],
      [PREVIEW, "/lessons/" + s, { status: 200, rewrite: "/method-pages/lessons/" + s + ".html" }]
    ]),
    ["athlevo.org", "/lessons", { status: 307, location: MO + "/lessons" }],
    [PREVIEW, "/lessons", { status: 200, rewrite: "/method-pages/lessons.html" }],
    [P, "/lessons", { status: 307, location: APP + "/lessons" }],
    // The files the lesson pages load, and the sitemap, are served from the host itself.
    [M, "/method.css", { status: 200, file: "/method.css" }],
    [M, "/assets/athlevo-ae-icon.png", { status: 200, file: "/assets/athlevo-ae-icon.png" }],
    [M, "/robots.txt", { status: 200, file: "/robots.txt" }],
    [M, "/sitemap-method.xml", { status: 200, file: "/sitemap-method.xml" }],
    // The app, the programs and the Sub-1 10k Challenge stay where they are: nothing else answers on this host.
    [M, "/privacy", { status: 307, location: APP + "/privacy" }],
    [M, "/terms", { status: 307, location: APP + "/terms" }],
    [M, "/signup", { status: 307, location: APP + "/signup" }],
    [M, "/ai", { status: 307, location: APP + "/ai" }],
    [M, "/index.html", { status: 307, location: APP + "/index.html" }],
    [M, "/service-worker.js", { status: 307, location: APP + "/service-worker.js" }],
    [M, "/programs", { status: 307, location: APP + "/programs" }],
    [M, "/virtual-run", { status: 307, location: APP + "/virtual-run" }],
    [M, "/api/coach", { status: 307, location: APP + "/api/coach" }],
    [M, "/lessonsx", { status: 307, location: APP + "/lessonsx" }],
    [M, "/method-pages/lessons.html", { status: 307, location: APP + "/method-pages/lessons.html" }],
    // Unchanged on the hosts that already existed.
    ["athlevo.org", "/", { status: 200, file: "/index.html" }],
    ["athlevo.org", "/privacy", { status: 200, rewrite: "/index.html" }],
    ["athlevo.org", "/virtual-run", { status: 200, rewrite: "/virtual-run.html" }],
    ["athlevo.org", "/programs", { status: 307, location: "https://" + P + "/programs" }],
    [P, "/", { status: 307, location: "/programs" }],
    [P, "/programs", { status: 200, rewrite: "/store.html" }],
    [PREVIEW, "/", { status: 200, file: "/index.html" }],
    // Unknown lesson addresses reach the lesson route and 404 there (the file does not exist).
    [M, "/lessons/not-a-lesson", { status: 200, rewrite: "/method-pages/lessons/not-a-lesson.html" }]
  ];
  const same = (got, want) => got.status === want.status && (got.location || "") === (want.location || "") &&
    (want.rewrite ? (got.rewrite || "") === want.rewrite : true) && (want.file ? got.file === want.file : true);
  const bad = table.filter(([h, p, want]) => !same(viaVercel(h, p), want));
  t("vercel.json: " + table.length + " requests on method.athlevo.org and the other hosts behave as designed",
    bad.length === 0, bad.map(([h, p]) => h + p + " got " + JSON.stringify(viaVercel(h, p))).join(" | "));

  const rule = (src, host) => vercel.redirects.find((r) => r.source === src && (r.has || []).some((c) => c.value === host));
  t("the root of the method host is a permanent redirect to the lessons hub (the hub is the front page of the host)",
    rule("/", M) && rule("/", M).permanent === true && rule("/", M).destination === "/lessons");
  const mHost = vercel.redirects.filter((r) => (r.has || []).some((c) => c.value === M));
  t("the host's only other redirect is the temporary catch-all that sends everything not served here to athlevo.org",
    mHost.length === 2 && mHost[1].destination === "https://athlevo.org/:path" && mHost[1].permanent === false && (mHost[1].has || []).length === 1);
  t("athlevo.org's two lesson redirects are temporary, exclude the method host, and come before the legacy /store rules",
    ["/lessons", "/lessons/:slug"].every((s) => {
      const r = rule(s, "athlevo.org");
      return r && r.permanent === false && r.missing.length === 1 && r.missing[0].value === M && r.destination.startsWith(MO + "/lessons") &&
        vercel.redirects.indexOf(r) < vercel.redirects.findIndex((x) => x.source === "/store/first-5k");
    }));
  t("the lesson rewrites are not tied to a host (previews and local servers serve /lessons) and the app's rewrites are untouched",
    ["/lessons", "/lessons/", "/lessons/:slug", "/lessons/:slug/"].every((s) => vercel.rewrites.some((r) => r.source === s && !r.has && /^\/method-pages\/lessons/.test(r.destination))) &&
    vercel.rewrites.some((r) => r.source === "/ai" && r.destination === "/index.html") &&
    vercel.rewrites.some((r) => r.source === "/virtual-run" && r.destination === "/virtual-run.html") &&
    vercel.rewrites.some((r) => r.source === "/programs/:slug" && r.destination === "/store.html"));
  t("the service worker does not cache lesson navigations as the app shell",
    /\/\(programs\|store\|landing-preview\|virtual-run\|lessons\)/.test(sw));

  // The preview server answers the same table where it can (a Host header selects the host).
  const port = 4800 + Math.floor(Math.random() * 300);
  const server = spawn(process.execPath, ["scripts/serve-web.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const ask = (h, path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: h }, method: "GET" }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location || "", type: res.headers["content-type"] || "", body }));
    });
    req.on("error", reject); req.end();
  });
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { try { await ask("127.0.0.1", "/robots.txt"); ready = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const bads = [];
    const expect = async (h, path, status, location, includes) => {
      const r = await ask(h, path);
      if (r.status !== status || (location !== undefined && r.location !== location) || (includes && !r.body.includes(includes))) bads.push(h + path + " got " + r.status + " " + r.location);
    };
    await expect(M, "/", 308, "/lessons");
    await expect(M, "/lessons", 200, undefined, "<h1");
    await expect(M, "/lessons/training-zones", 200, undefined, SITE.origin + "/lessons/training-zones");
    await expect(M, "/lessons/training-zones/", 200, undefined, "<h1");
    await expect(M, "/lessons/not-a-lesson", 404);
    await expect(M, "/method.css", 200);
    await expect(M, "/sitemap-method.xml", 200, undefined, "<urlset");
    await expect(M, "/privacy", 307, APP + "/privacy");
    await expect(M, "/programs", 307, APP + "/programs");
    await expect(M, "/method-pages/lessons.html", 307, APP + "/method-pages/lessons.html");
    await expect("athlevo.org", "/lessons", 307, MO + "/lessons");
    await expect("athlevo.org", "/lessons/pace-ladder", 307, MO + "/lessons/pace-ladder");
    await expect("athlevo.org", "/lessons/pace-ladder?utm_source=x", 307, MO + "/lessons/pace-ladder?utm_source=x");
    await expect("athlevo.org", "/", 200);
    await expect(P, "/lessons", 307, APP + "/lessons");
    await expect("127.0.0.1", "/lessons", 200, undefined, "<h1");
    await expect("127.0.0.1", "/lessons/coaching-rules", 200, undefined, "<h1");
    await expect("127.0.0.1", "/", 200);
    const css1 = await ask("127.0.0.1", "/method.css");
    t("the preview server answers like vercel.json for the method host, athlevo.org, the programs host and any other host (" + (bads.length ? "see list" : "20 requests") + ")",
      bads.length === 0 && /text\/css/.test(css1.type), bads.join(" | "));
  } finally {
    server.kill();
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
