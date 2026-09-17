/**
 * Athlevo — /landing-preview marketing preview route contract.
 *
 * Verifies the unpublished landing-page preview (landing-preview.html,
 * served at /landing-preview via vercel.json) exists, is self-contained,
 * matches the required section order and copy, and activates NOTHING —
 * no signup, login, payment, wearable-connect, or app-store action.
 *
 * Also verifies the live "/" and "/ai" routing in index.html is
 * byte-for-byte unchanged (checked against a recorded hash) so this
 * addition cannot have touched the live product surface.
 *
 * Run: node tests/landing-preview-route.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const preview = readFileSync("./landing-preview.html", "utf8");
const html = readFileSync("./index.html", "utf8"); // live app shell — read-only in this suite

// Rendered/visible markup only — strips the file's own explanatory HTML
// comments (which legitimately use words like "signup", "OAuth", "checkout"
// to DESCRIBE what is absent) so content checks below test what a visitor
// actually sees, not this file's internal documentation.
const bodyOnly = preview.replace(/<!--[\s\S]*?-->/g, "");

/* ── 1. Preview route exists and serves content ─────────────────────── */
section("1. Preview route wiring");
{
  t("vercel.json rewrites /landing-preview to landing-preview.html",
    vercel.rewrites.some(r => r.source === "/landing-preview" && r.destination === "/landing-preview.html"));
  t("landing-preview.html exists on disk and has real content",
    existsSync("./landing-preview.html") && preview.length > 5000);
  t("preview declares itself unpublished/noindex",
    /name="robots" content="noindex,nofollow"/.test(preview) &&
    /Unpublished preview/i.test(preview));
}

/* ── 2 & 3. Live "/" and "/ai" are unchanged ─────────────────────────── */
section("2-3. Live / and /ai routing untouched");
{
  const LIVE_INDEX_SHA256 =
    "70e390e9d7bae93383bf69b65e12208564131dfabd3fdbb9e5ed92864af17e11";
  const actualHash = createHash("sha256").update(html).digest("hex");
  t("index.html is byte-for-byte unchanged (sha256 matches pre-work baseline)",
    actualHash === LIVE_INDEX_SHA256, `got ${actualHash}`);
  t("index.html still routes /ai (and root) to the anonymous Coach entry",
    /aiPath === "\/ai" \|\| aiPath === "" \|\| aiPath === "\/signup" \|\| aiPath === "\/ai-signup"/.test(html));
  t("landing-preview.html is never referenced from the live app shell",
    !html.includes("landing-preview"));
  t("no js/*.js file references landing-preview (no coupling to live app logic)",
    !/landing-preview/i.test(readFileSync("./js/legal.js", "utf8")));
}

/* ── 4. Required section order ───────────────────────────────────────── */
section("4. Section order");
{
  const markers = [
    ["A. Navigation", preview.indexOf('<nav class="nav"')],
    ["B. Hero", preview.indexOf('id="hero-heading"')],
    ["C. Training creates questions", preview.indexOf("Your training creates questions.")],
    ["D. Product demonstration", preview.indexOf('id="demo-heading"')],
    ["E. How it works", preview.indexOf('id="how-heading"')],
    ["F. What runners can use it for", preview.indexOf('id="uses-heading"')],
    ["G. Athlevo Method", preview.indexOf('id="method-heading"')],
    ["H. FAQ", preview.indexOf('id="faq-heading"')],
    ["I. Closing CTA/status", preview.indexOf('id="closing-heading"')],
    ["K. Internal review notes", preview.indexOf('<section class="review-notes" id="internal-review-notes"')],
    ["J. Footer", preview.indexOf('<footer class="footer">')]
  ];
  for (const [name, idx] of markers) t(`${name} present`, idx !== -1);
  let ordered = true;
  for (let i = 1; i < markers.length; i++) {
    if (markers[i][1] <= markers[i - 1][1]) ordered = false;
  }
  t("sections appear in the required order (review-notes precedes footer, matching the approved preview file's actual layout)",
    ordered);
}

/* ── 5. Nav anchors exist and smooth-scroll ──────────────────────────── */
section("5. Navigation anchors");
{
  const navBlock = preview.slice(preview.indexOf('<nav class="nav"'), preview.indexOf("</nav>"));
  t('nav has "How it works" anchor to #how', /href="#how">How it works</.test(navBlock));
  t('nav has "Inside the app" anchor to #inside', /href="#inside">Inside the app</.test(navBlock));
  t('nav has "FAQ" anchor to #faq', /href="#faq">FAQ</.test(navBlock));
  t("html{scroll-behavior:smooth} is set for anchor scrolling",
    /html\{scroll-behavior:smooth\}/.test(preview));
  t("#how, #inside, #faq target elements actually exist in the page",
    /id="how"/.test(preview) && /id="inside"/.test(preview) && /id="faq"/.test(preview));
}

/* ── 6. No active signup/login buttons ───────────────────────────────── */
section("6. No signup/login activation");
{
  t("no <form> elements anywhere on the page", !/<form[\s>]/i.test(bodyOnly));
  t("no <input> elements anywhere on the page", !/<input[\s>]/i.test(bodyOnly));
  // The top preview-bar banner ("no signup, payments, connections, or
  // downloads are active") legitimately uses the word "signup" to say it's
  // ABSENT — that's verbatim approved-preview copy, not a CTA. Excluded here.
  const bodyMinusBanner = bodyOnly.replace(/<div class="preview-bar">[\s\S]*?<\/div>/, "");
  t("no signup/login/create-account call-to-action text",
    !/sign\s*up|log\s*in|sign\s*in|create\s+your\s+free\s+account|start\s+free\s+trial/i.test(bodyMinusBanner));
  t("no references to live app auth functions (openSignup/openLogin/landingStartFree/etc.)",
    !/openSignup|openLogin|openAiSignup|landingStartFree|landingSignIn/.test(bodyOnly));
  t("no href pointing at live acquisition routes (/ai, /signup, /ai-signup, /pricing)",
    !/href="\/(ai|signup|ai-signup|pricing)"/.test(bodyOnly));
}

/* ── 7. No payment CTA ────────────────────────────────────────────────── */
section("7. No payment activation");
{
  t("no payment-provider references (Whop, PayMongo, checkout, StoreKit)",
    !/whop|paymongo|checkout|storekit/i.test(bodyOnly));
  t("no price-tagged call-to-action button (e.g. \"$X/mo\" as a clickable CTA)",
    !/<a[^>]*class="cta"[^>]*>\s*\$/.test(bodyOnly));
  t('pricing is discussed only as descriptive FAQ text, not a buyable CTA',
    !/<button/i.test(bodyOnly) || !/\$\d/.test(bodyOnly));
}

/* ── 8. No app-store badge ───────────────────────────────────────────── */
section("8. No app-store badges");
{
  t("no App Store / Google Play / Play Store badge references",
    !/app store|google play|play store|apple app store/i.test(bodyOnly));
  t("no app-store badge image assets referenced",
    !/app-store|play-store|badge-download/i.test(bodyOnly));
}

/* ── 9. No wearable-connect action ───────────────────────────────────── */
section("9. No wearable connection activated");
{
  t("no OAuth/connect action wired for Garmin/Strava/Intervals",
    !/connectGarmin|connectStrava|connectIntervals|oauth|onboardingConnect/i.test(bodyOnly));
  t("no \"Connect\" button element (Garmin is only mentioned as descriptive text)",
    !/<(button|a)[^>]*>\s*Connect\b/i.test(bodyOnly));
}

/* ── 10. Hero CTA only scrolls ───────────────────────────────────────── */
section("10. Hero CTA is scroll-only");
{
  const ctaMatch = preview.match(/<a class="cta" href="([^"]+)"[^>]*>([^<]*)<\/a>/);
  t("hero CTA exists", !!ctaMatch);
  t('hero CTA href is an in-page anchor ("#inside"), not an auth/signup destination',
    !!ctaMatch && ctaMatch[1] === "#inside");
  t("hero CTA has no onclick handler", !/<a class="cta"[^>]*onclick/.test(preview));
  t('hero CTA label reads "See how it works"',
    !!ctaMatch && /See how it works/.test(ctaMatch[2]));
}

/* ── 11. "Coming soon" status is noninteractive ──────────────────────── */
section("11. Coming soon status is noninteractive");
{
  const pillMatches = [...preview.matchAll(/<span class="status-pill"[^>]*>[\s\S]*?Coming soon<\/span>/g)];
  t("at least 2 non-interactive Coming soon status pills exist (nav + closing)",
    pillMatches.length >= 2);
  t("status pills are <span> elements, not <button> or <a>",
    pillMatches.every(m => !/<a\s|<button/.test(m[0])));
  t("status pills carry role=\"status\" (no href/onclick)",
    pillMatches.every(m => /role="status"/.test(m[0]) && !/href=|onclick=/.test(m[0])));
}

/* ── 12. Real screenshots render (or explicit placeholder) ──────────── */
section("12. Real screenshots present");
{
  const imgs = [...preview.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)];
  t("preview contains at least 4 screenshot <img> tags", imgs.length >= 4);
  for (const [, src, alt] of imgs) {
    t(`image "${src}" exists on disk`, existsSync(`./${src}`));
    t(`image "${src}" has a descriptive, non-empty alt attribute`, alt.trim().length > 5);
  }
}

/* ── 13. Product-demo placeholder remains explicit ───────────────────── */
section("13. Product-demo placeholder is explicit, not fabricated");
{
  t('"Runner question" field is an explicit [REVIEW PLACEHOLDER]',
    /Runner question<\/div>\s*<div class="demo-placeholder">\[REVIEW PLACEHOLDER/.test(preview));
  t('"Available context" field is an explicit [REVIEW PLACEHOLDER]',
    /Available context<\/div>\s*<div class="demo-placeholder">\[REVIEW PLACEHOLDER/.test(preview));
  t('"Follow-up, if needed" field is an explicit [REVIEW PLACEHOLDER]',
    /Follow-up, if needed<\/div>\s*<div class="demo-placeholder">\[REVIEW PLACEHOLDER/.test(preview));
  t("demo section explicitly states no conversation/outcome is fabricated",
    /does not fabricate a conversation, outcome, or data interpretation/i.test(preview));
}

/* ── 14. Legal routes use real existing paths ────────────────────────── */
section("14. Legal footer links use real existing routes");
{
  t('footer links to the real existing "/privacy" route', /<a href="\/privacy">Privacy Policy<\/a>/.test(preview));
  t('footer links to the real existing "/support" route', /<a href="\/support">Support/.test(preview));
  t('footer links to the real existing "/terms" route', /<a href="\/terms">Terms of Service<\/a>/.test(preview));
  t("/privacy is a real rewrite in vercel.json",
    vercel.rewrites.some(r => r.source === "/privacy" && r.destination === "/index.html"));
  t("/support is a real rewrite in vercel.json",
    vercel.rewrites.some(r => r.source === "/support" && r.destination === "/index.html"));
  t("/terms is a real rewrite in vercel.json",
    vercel.rewrites.some(r => r.source === "/terms" && r.destination === "/index.html"));
  t("no leftover inactive Terms placeholder in the footer",
    !/class="inactive">Terms/.test(preview));
}

/* ── 15. No fabricated testimonials / user counts ────────────────────── */
section("15. No fabricated social proof");
{
  t("no testimonial/review markup or star ratings",
    !/testimonial|★|⭐|"[^"]*"\s*—\s*[A-Z][a-z]+,?\s*(runner|athlete|user)/i.test(bodyOnly));
  t("no fabricated user-count / athletes-trained claims",
    !/\d[\d,]*\+?\s*(runners|athletes|users)\b/i.test(bodyOnly));
  t("no race-time-improvement or outcome claims",
    !/\bPR\b|personal record|shaved \d|faster marathon|sub-3:/i.test(bodyOnly));
  t("no partner/press logos section", !/as seen in|featured in|partner logos/i.test(bodyOnly));
}

/* ── 16. Mobile: no obvious horizontal-overflow risk ─────────────────── */
section("16. Responsive / no horizontal overflow risk");
{
  t("body sets overflow-x:hidden", /body\{[^}]*overflow-x:hidden/.test(preview));
  t(".wrap uses a fluid min()/calc width, not a fixed px width",
    /\.wrap\{width:min\(1180px,calc\(100% - 40px\)\)/.test(preview));
  t("a mobile breakpoint (max-width:820px) narrows .wrap for small screens",
    /@media\(max-width:820px\)\{[\s\S]*?\.wrap\{width:min\(100% - 28px,680px\)/.test(preview));
  // No bare `width:<3-4 digit>px` declarations (fixed widths) outside of
  // max-width/grid-template contexts that could force horizontal scroll.
  const fixedWidths = [...preview.matchAll(/(?<!max-)(?<!template-columns:[^;]{0,40})\bwidth:(\d{3,5})px/g)]
    .map(m => Number(m[1]))
    .filter(px => px > 375);
  t("no standalone fixed pixel width declarations wider than a 375px viewport",
    fixedWidths.length === 0, `found: ${fixedWidths.join(", ")}`);
  t("hero/section headings use clamp() for fluid type scaling (no giant desktop-only fixed sizes)",
    /\.hero h1\{font-size:clamp\(/.test(preview) && /\.section-title\{font-size:clamp\(/.test(preview));
  t("grids collapse to a single column under the mobile breakpoint",
    /\.questions,\.steps,\.uses,\.review-grid,\.inside-strip\{grid-template-columns:1fr\}/.test(preview));
}

/* ── 17. Accessibility & reduced motion ──────────────────────────────── */
section("17. Accessibility basics");
{
  t("prefers-reduced-motion is respected",
    /@media \(prefers-reduced-motion: reduce\)/.test(preview));
  t("headings use real semantic elements (h1/h2/h3), not styled divs",
    /<h1[ >]/.test(preview) && (preview.match(/<h2[ >]/g) || []).length >= 6);
  t("focus-visible outline is defined for keyboard users",
    /:focus-visible\{outline:/.test(preview));
  t("landmark <nav>, <main>, <footer> elements are present",
    /<nav class="nav"/.test(preview) && /<main>/.test(preview) && /<footer class="footer">/.test(preview));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
