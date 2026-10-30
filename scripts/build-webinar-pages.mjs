#!/usr/bin/env node
/**
 * Writes the two webinar pages from content/webinar.mjs.
 *
 * Outputs (generated, do not edit by hand):
 *   webinar.html            /webinar            the landing page with the registration form
 *   webinar-thank-you.html  /webinar/thank-you  shown after a registration (noindex)
 *
 * All wording, the date and the time live in content/webinar.mjs. This file only holds the
 * markup. It reuses the storefront's components, so the look is store.css plus the few
 * layout rules in webinar.css; it adds no colours, fonts or styles of its own.
 *
 *   node scripts/build-webinar-pages.mjs          write the files
 *   node scripts/build-webinar-pages.mjs --check  fail if either file is out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISTANCES, LANDING, SESSION, SITE, THANKS, TRAINING, sessionDetails } from "../content/webinar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const text = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** Escaped text where *a word* becomes <em>a word</em>. */
const rich = (s) => String(s).split("*").map((part, i) => (i % 2 ? "<em>" + text(part) + "</em>" : text(part))).join("");

// ---- The storefront's own pictures (same files, sizes and alt text as /programs) ----

const HERO_SIZES = "(min-width: 981px) min(720px, 58vw), 92vw";
const heroPicture = () =>
  "<picture>" +
  '<source type="image/avif" sizes="' + HERO_SIZES + '" srcset="/assets/store/stretch-640.avif 640w, /assets/store/stretch-1080.avif 1080w">' +
  '<source type="image/webp" sizes="' + HERO_SIZES + '" srcset="/assets/store/stretch-640.webp 640w, /assets/store/stretch-1080.webp 1080w">' +
  '<img src="/assets/store/stretch-1080.webp" alt="An Athlevo athlete in a white Athlevo shirt and red shorts holding one knee to the chest in a standing stretch." width="1080" height="1616" decoding="async" loading="eager" fetchpriority="high">' +
  "</picture>";

const COACH_SIZES = "(min-width: 641px) 360px, 92vw";
const coachPicture = () =>
  "<picture>" +
  '<source type="image/avif" sizes="' + COACH_SIZES + '" srcset="/assets/store/founder-640.avif 640w, /assets/store/founder-920.avif 920w">' +
  '<source type="image/webp" sizes="' + COACH_SIZES + '" srcset="/assets/store/founder-640.webp 640w, /assets/store/founder-920.webp 920w">' +
  '<img src="/assets/store/founder-920.webp" alt="Dean Castro in a white Athlevo jersey, arms crossed, looking off to the side." width="920" height="1150" decoding="async" loading="lazy">' +
  "</picture>";

// ---- Shared pieces ----

const PIXEL_INSTRUCTIONS =
  "  <!-- ======================= META PIXEL =======================\n" +
  "       Paste your Meta Pixel base code here: the whole <script> block and the <noscript>\n" +
  "       line from Events Manager. It is the same spot on both pages. The thank-you page sends\n" +
  "       the Lead event itself (see the end of that page), so leave Lead out of the snippet.\n" +
  "       Whatever sits between this comment and the closing marker below is kept when the\n" +
  "       pages are rebuilt.\n" +
  "       ========================================================== -->\n";
const PIXEL_END = "  <!-- /META PIXEL -->";

/** What is already pasted in the Pixel spot of an existing page (empty when nothing is). */
function pastedPixel(existingHtml) {
  if (!existingHtml) return "";
  const start = existingHtml.indexOf("<!-- ======================= META PIXEL");
  const end = existingHtml.indexOf(PIXEL_END);
  if (start < 0 || end < start) return "";
  const afterComment = existingHtml.indexOf("-->", start);
  return afterComment < 0 || afterComment > end ? "" : existingHtml.slice(afterComment + 3, end).replace(/^\n/, "");
}

/** The marked Meta Pixel spot for a page head, keeping anything already pasted into it. */
const pixelSpot = (pasted = "") => PIXEL_INSTRUCTIONS + pasted + PIXEL_END;

const HEAD_COMMON =
  '  <link rel="icon" type="image/png" href="/assets/athlevo-ae-icon.png">\n' +
  '  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap" rel="stylesheet">\n' +
  '  <link rel="stylesheet" href="/store.css">\n' +
  '  <link rel="stylesheet" href="/webinar.css">';

const HEADER =
  '  <a class="skip" href="#main">Skip to main content</a>\n' +
  '  <header class="site-header">\n' +
  '    <div class="nav"><span class="wordmark">Athlevo<i aria-hidden="true">.</i></span></div>\n' +
  "  </header>";

const footer = (lines) =>
  '  <footer class="site-footer">\n' +
  '    <div class="wrap footer-row">\n' +
  '      <p class="footer-line">' + text(lines[0]) + "</p>\n" +
  '      <p class="copyright">' + text(lines[1]) + "</p>\n" +
  "    </div>\n" +
  "  </footer>";

/** The Date / Time / Format / Cost block. */
const detailsBlock = (session) =>
  '<dl class="pdp-facts">' +
  sessionDetails(session).map(([label, value]) => "<div><dt>" + text(label) + "</dt><dd>" + text(value) + "</dd></div>").join("") +
  "</dl>";

// ---- /webinar ----

function field(id, name, label, control, error) {
  return '<div class="field">' +
    '<label for="' + id + '">' + text(label) + "</label>" +
    control +
    (error ? '<p class="field-error" id="' + id + '-error" hidden>' + text(error) + "</p>" : "") +
    "</div>";
}

function selectControl(id, name, choose, options) {
  return '<select id="' + id + '" name="' + name + '" required>' +
    '<option value="">' + text(choose) + "</option>" +
    options.map((o) => '<option value="' + attr(o.value) + '">' + text(o.label) + "</option>").join("") +
    "</select>";
}

function formHtml(f) {
  const E = f.errors;
  return '<form class="webinar-form" id="register" method="post" action="' + attr(SITE.registerApi) + '" novalidate tabindex="-1" aria-labelledby="register-heading">' +
    '<h3 class="webinar-form-title" id="register-heading">' + text(f.heading) + "</h3>" +
    '<p class="webinar-form-sub">' + text(f.subtext) + "</p>" +
    field("webinar-name", "name", f.labels.name,
      '<input id="webinar-name" name="name" type="text" autocomplete="name" maxlength="120" required>', E.name) +
    field("webinar-mobile", "mobile", f.labels.mobile,
      '<input id="webinar-mobile" name="mobile" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" required>', E.mobile) +
    field("webinar-email", "email", f.labels.email,
      '<input id="webinar-email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254">', E.email) +
    field("webinar-distance", "distance", f.labels.distance,
      selectControl("webinar-distance", "distance", f.choose, DISTANCES), E.distance) +
    field("webinar-training", "training", f.labels.training,
      selectControl("webinar-training", "training", f.choose, TRAINING), E.training) +
    field("webinar-question", "question", f.labels.question,
      '<textarea id="webinar-question" name="question" rows="4" maxlength="1000"></textarea>', null) +
    // Spam trap: people never see or reach it; a bot that fills every field gives itself away.
    '<div class="hp" aria-hidden="true"><label for="webinar-website">Leave this field empty</label>' +
    '<input id="webinar-website" name="contact_website" type="text" tabindex="-1" autocomplete="off"></div>' +
    '<p class="form-error" id="webinar-form-error" role="alert" data-message="' + attr(E.submit) + '"></p>' +
    '<button class="btn btn-red btn-lg" type="submit">' + text(f.submit) + "</button>" +
    '<p class="offer-supporting">' + text(f.help) + "</p>" +
    "</form>";
}

function landingPage(session, pasted) {
  const L = LANDING;
  const head =
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>" + text(L.title) + "</title>\n" +
    '  <meta name="description" content="' + attr(L.description) + '">\n' +
    '  <link rel="canonical" href="' + attr(SITE.canonical) + '">\n' +
    '  <meta property="og:site_name" content="Athlevo">\n' +
    '  <meta property="og:type" content="website">\n' +
    '  <meta property="og:title" content="' + attr(L.ogTitle) + '">\n' +
    '  <meta property="og:description" content="' + attr(L.ogDescription) + '">\n' +
    '  <meta property="og:url" content="' + attr(SITE.canonical) + '">\n' +
    pixelSpot(pasted) + "\n" +
    HEAD_COMMON;

  const hero =
    '<section class="pdp pdp-offer wrap" aria-labelledby="hero-heading">' +
    '<div class="pdp-hero pdp-hero--offer">' +
    "<figure>" + heroPicture() + "</figure>" +
    '<div class="offer-first">' +
    '<p class="eyebrow">' + text(L.hero.eyebrow) + "</p>" +
    '<h1 id="hero-heading">' + rich(L.hero.headline) + "</h1>" +
    '<p class="offer-description">' + text(L.hero.supporting) + "</p>" +
    '<a class="btn btn-red btn-lg" href="#register">' + text(L.hero.button) + "</a>" +
    '<p class="offer-supporting">' + text(L.hero.small) + "</p>" +
    "</div></div></section>";

  const how =
    '<section class="section" id="how" aria-labelledby="how-heading"><div class="wrap">' +
    '<div class="section-head"><p class="eyebrow">' + text(L.how.eyebrow) + "</p>" +
    '<h2 class="section-title" id="how-heading">' + rich(L.how.heading) + "</h2></div>" +
    '<div class="how-grid">' +
    L.how.cards.map((c) =>
      '<article class="how-card"><p class="eyebrow">' + text(c.number) + "</p><h3>" + text(c.title) + "</h3><p>" + text(c.text) + "</p></article>"
    ).join("") +
    "</div>" +
    '<p class="intro-text how-line">' + text(L.how.line) + "</p>" +
    "</div></section>";

  const coach =
    '<section class="section" id="coach" aria-labelledby="coach-heading"><div class="wrap">' +
    '<div class="offer-coach-row">' +
    '<figure class="offer-coach-photo">' + coachPicture() + "</figure>" +
    "<div>" +
    '<p class="eyebrow">' + text(L.coach.eyebrow) + "</p>" +
    '<h2 class="section-title is-left" id="coach-heading">' + rich(L.coach.heading) + "</h2>" +
    "<p>" + text(L.coach.text) + "</p>" +
    '<div class="coach-card-creds"><ul>' + L.coach.credentials.map((c) => "<li>" + text(c) + "</li>").join("") + "</ul></div>" +
    "</div></div></div></section>";

  const session_ =
    '<section class="section" id="session" aria-labelledby="session-heading"><div class="wrap session-grid">' +
    '<div class="session-copy">' +
    '<p class="eyebrow">' + text(L.session.eyebrow) + "</p>" +
    '<h2 class="section-title is-left" id="session-heading">' + rich(L.session.heading) + "</h2>" +
    '<p class="session-intro">' + text(L.session.intro) + "</p>" +
    detailsBlock(session) +
    '<h3 class="offer-subhead">' + text(L.session.whoLabel) + "</h3>" +
    "<p>" + text(L.session.who) + "</p>" +
    "</div>" +
    '<div class="session-form">' + formHtml(L.form) + "</div>" +
    "</div></section>";

  const faq =
    '<section class="section" id="faq" aria-labelledby="faq-heading"><div class="wrap">' +
    '<h2 class="section-title" id="faq-heading">' + rich(L.faq.heading) + "</h2>" +
    '<div class="faq">' +
    L.faq.items.map((item, i) =>
      "<details" + (i === 0 ? " open" : "") + "><summary>" + text(item.q) + "</summary><p>" + text(item.a) + "</p></details>"
    ).join("") +
    "</div></div></section>";

  const closing =
    '<section class="section closing" aria-labelledby="closing-heading"><div class="wrap">' +
    '<h2 class="section-title" id="closing-heading">' + rich(L.closing.heading) + "</h2>" +
    '<div class="intro-actions"><a class="btn btn-red btn-lg" href="#register">' + text(L.closing.button) + "</a></div>" +
    "</div></section>";

  return "<!DOCTYPE html>\n" +
    '<html lang="en">\n<head>\n' + head + "\n</head>\n" +
    '<body class="webinar">\n' + HEADER + "\n" +
    '  <main id="main" tabindex="-1">\n' +
    [hero, how, coach, session_, faq, closing].join("\n") + "\n" +
    "  </main>\n" + footer(L.footer) + "\n" +
    '  <script src="/js/webinar.js" defer></script>\n' +
    "</body>\n</html>\n";
}

// ---- /webinar/thank-you ----

function thankYouPage(session, pasted) {
  const T = THANKS;
  const head =
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>" + text(T.title) + "</title>\n" +
    '  <meta name="robots" content="noindex, nofollow">\n' +
    pixelSpot(pasted) + "\n" +
    HEAD_COMMON;

  const main =
    '<article class="pdp wrap signup-confirm">' +
    '<p class="eyebrow">' + text(T.eyebrow) + "</p>" +
    '<div class="signup-confirm-panel">' +
    "<h1>" + rich(T.heading) + "</h1>" +
    '<p class="signup-confirm-lede">' + text(T.line) + "</p>" +
    '<ol class="offer-steps signup-confirm-steps">' +
    T.steps.map((s) => "<li><strong>" + text(s.title) + "</strong><p>" + text(s.text) + "</p></li>").join("") +
    "</ol>" +
    detailsBlock(session) +
    '<p class="offer-supporting">' + text(T.event) + "</p>" +
    "</div></article>";

  // The Lead event. fbq exists only once the Pixel code above has been pasted in; until then
  // this does nothing. It runs once per browser session so a refresh is not counted again.
  const lead =
    "  <script>\n" +
    "    (function () {\n" +
    '      if (typeof window.fbq !== "function") return;\n' +
    '      try { if (window.sessionStorage.getItem("athlevoWebinarLead")) return; } catch (e) { /* storage blocked: still count it */ }\n' +
    '      window.fbq("track", "Lead");\n' +
    '      try { window.sessionStorage.setItem("athlevoWebinarLead", "1"); } catch (e) { /* ignore */ }\n' +
    "    })();\n" +
    "  </script>";

  return "<!DOCTYPE html>\n" +
    '<html lang="en">\n<head>\n' + head + "\n</head>\n" +
    '<body class="webinar">\n' + HEADER + "\n" +
    '  <main id="main" tabindex="-1">\n' + main + "\n  </main>\n" +
    footer(T.footer) + "\n" + lead + "\n" +
    "</body>\n</html>\n";
}

/** The pages as they are on disk, so a Pixel pasted into one is carried into the rebuild. */
function onDisk(root, path) {
  try { return readFileSync(join(root, path), "utf8"); } catch { return ""; }
}

/**
 * Returns [{ path, content }] for both pages, relative to the repo root. `existing` maps a page's
 * path to its current HTML: whatever is pasted in that page's Meta Pixel spot is kept.
 */
export function buildWebinarPages(session = SESSION, existing = {}) {
  return [
    { path: "webinar.html", content: landingPage(session, pastedPixel(existing["webinar.html"])) },
    { path: "webinar-thank-you.html", content: thankYouPage(session, pastedPixel(existing["webinar-thank-you.html"])) }
  ];
}

/** Paths whose content on disk differs from what a rebuild would write. */
export function staleWebinarFiles(root = ROOT) {
  const existing = { "webinar.html": onDisk(root, "webinar.html"), "webinar-thank-you.html": onDisk(root, "webinar-thank-you.html") };
  return buildWebinarPages(SESSION, existing).filter(({ path, content }) => existing[path] !== content).map((f) => f.path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const stale = staleWebinarFiles();
    if (stale.length) {
      console.error("Out of date, run: node scripts/build-webinar-pages.mjs\n  " + stale.join("\n  "));
      process.exit(1);
    }
    console.log("Webinar pages are up to date.");
  } else {
    const files = buildWebinarPages(SESSION, {
      "webinar.html": onDisk(ROOT, "webinar.html"), "webinar-thank-you.html": onDisk(ROOT, "webinar-thank-you.html")
    });
    for (const { path, content } of files) writeFileSync(join(ROOT, path), content);
    console.log("Wrote " + files.length + " files:\n  " + files.map((f) => f.path).join("\n  "));
  }
}
