/*
 * Athlevo landing-page performance identity.
 *
 * These source-level checks protect the marketing-page presentation without
 * coupling the signup funnel to a browser implementation.
 *
 * Run: node tests/landing-performance-identity.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const landingContent = readFileSync("./js/landingContent.js", "utf8");
const landing = html.slice(
  html.indexOf('<section class="screen lp" id="screen-landing">'),
  html.indexOf("<!-- ══════════════ WELCOME")
);

let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS — ${name}`);
  } else {
    failed++;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

console.log("\n──── Institutional brand structure ────");
test("brand navigation names both coaching paths and the method",
  ["Coaching", "AI", "Method", "Athletes", "About"].every(label =>
    landing.includes(`>${label}</a>`)));
test("global brand CTA is Train With Athlevo",
  /<a class="lp-btn sm" href="#train-with-athlevo">Train With Athlevo<\/a>/.test(landing));
test("hero is editorial photography-first rather than an app mockup",
  /<img src="assets\/landing\/hero-athlevo\.png"[^>]*alt="Athlevo athletes together after a training session\."[^>]*loading="eager"[^>]*fetchpriority="high"/.test(landing) &&
  !landing.slice(landing.indexOf('<header class="lp-hero"'), landing.indexOf("</header>"))
    .includes("landingStartFree"));
test("the athlete-first philosophy follows the hero",
  landing.indexOf("THE ATHLETE COMES FIRST") > landing.indexOf("</header>") &&
  landing.indexOf("THE ATHLETE COMES FIRST") < landing.indexOf("TRAIN WITH ATHLEVO"));
test("AI and human coaching are presented as two paths",
  landing.includes("One coaching philosophy. Different levels of support.") &&
  landing.includes("ATHLEVO AI") && landing.includes("HUMAN COACHING"));
test("founder story keeps its editorial photo slot",
  landing.includes("DEAN_FOUNDER_EDITORIAL_IMAGE") &&
  landing.includes("Founder &amp; Head Coach"));
test("image slots are semantic hooks with no visible placeholder labels",
  ["ATHLETE_TRAINING_IMAGE_01", "DEAN_FOUNDER_EDITORIAL_IMAGE",
   "FINAL_RACE_IMAGE"].every(slot =>
    landing.includes(`data-image-slot="${slot}"`)) &&
  !landing.includes("lp-photo-label") &&
  !landingContent.includes('node("span", "lp-photo-label"'));
test("athlete story, tier, method, and FAQ collection roots exist",
  ["landingAthleteStories", "landingCoachingTiers", "landingMethodPrinciples", "landingFaq"]
    .every(id => landing.includes(`id="${id}"`)));
test("three athlete stories remain clearly marked content placeholders",
  ["ATHLETE_STORY_01", "ATHLETE_STORY_02", "ATHLETE_STORY_03"]
    .every(slot => landingContent.includes(slot)) &&
  (landingContent.match(/Approved athlete quote to be supplied/g) || []).length === 3);
test("coaching tiers, method principles, and FAQs are editable data collections",
  /coachingTiers:\s*\[/.test(landingContent) &&
  /methodPrinciples:\s*\[/.test(landingContent) &&
  /faq:\s*\[/.test(landingContent));
test("all approved tier prices, five method principles, and ten FAQs are present",
  ["₱1,998/month", "₱4,998/month", "₱7,998/month"].every(price =>
    landingContent.includes(price)) &&
  (landingContent.match(/\{ name: /g) || []).length >= 5 &&
  (landingContent.match(/\{ question: /g) || []).length === 10);
test("content renderer writes text safely rather than injecting HTML",
  /\.textContent = text/.test(landingContent) && !/innerHTML/.test(landingContent));

console.log("\n──── Funnel and analytics wiring remain intact ────");
{
  const ctas = [...landing.matchAll(
    /<button[^>]*data-cta-location="([^"]+)"[^>]*onclick="landingStartFree\(this\)"[^>]*>Build My Training Plan<\/button>/g
  )].map(match => match[1]).sort();
  const expected = ["ai_product"];
  test("only the dedicated AI CTA enters the signup funnel",
    JSON.stringify(ctas) === JSON.stringify(expected),
    ctas.join(", "));
}
test("brand CTAs route separately from the AI signup funnel",
  /Explore Athlevo<\/a>/.test(landing) &&
  /See how we coach<\/a>/.test(landing) &&
  !/data-cta-location="(?:navigation|hero|footer)"/.test(landing));
test("landing CTA analytics still use the existing entry point",
  /function landingStartFree\(trigger\)[\s\S]*?signup_cta_clicked/.test(html));

console.log("\n──── Distinct visual hierarchy ────");
test("hero no longer uses a decorative startup gradient",
  /\.lp-hero\{[^}]*background:var\(--paper\)/.test(html) &&
  !/\.lp-hero\{[^}]*gradient/.test(html));
test("landing CTAs use compact card geometry rather than pill geometry",
  /\.lp-btn\{[^}]*border-radius:var\(--r-sm\)/.test(html) &&
  !/\.lp-btn\{[^}]*border-radius:var\(--r-pill\)/.test(html));
test("product labels use the existing sans-serif hierarchy",
  /\.lp-path-label,[\s\S]*font-size:11px/.test(html));
test("editorial statements retain the existing serif family",
  /#screen-landing \.lp-h2\{font-family:var\(--serif\)/.test(html));
test("coaching tiers and method use ruled editorial grids",
  /\.lp-tier-grid\{[^}]*border-top:1px solid var\(--text\)/.test(html) &&
  /\.lp-principle\{[^}]*border-bottom:1px solid var\(--line\)/.test(html));
test("landing design adds no gradients or glass card treatment",
  !landing.includes("gradient") && !landing.includes("glass"));
test("editorial media is borderless and real images use cover cropping",
  /\.lp-editorial-media\{[^}]*overflow:hidden[^}]*background:var\(--line\)/.test(html) &&
  /\.lp-editorial-media>img,[^}]*object-fit:cover/.test(html) &&
  !/\.lp-editorial-media\{[^}]*border/.test(html));
test("hero crop removes source bars while preserving the athlete group",
  /\.lp-photo-hero>img\{object-fit:cover;object-position:center 46%\}/.test(html) &&
  /@media \(max-width:700px\)\{[\s\S]*?\.lp-photo-hero>img\{object-position:center 42%\}/.test(html));
test("athlete stories use alternating image-and-copy compositions",
  /\.lp-story\{display:grid;grid-template-columns:/.test(html) &&
  /\.lp-story:nth-child\(even\) \.lp-story-image\{order:2\}/.test(html) &&
  /lp-story-copy/.test(landingContent));
test("final race media fills the CTA section behind a contrast layer",
  /\.lp-final-image\{position:absolute;inset:0/.test(html) &&
  /\.lp-final-overlay\{[^}]*background:rgba\(14,15,17,\.82\)/.test(html));

console.log("\n──── Narrow viewport and accessibility safeguards ────");
test("the landing screen clips accidental horizontal overflow",
  /#screen-landing\{[^}]*overflow-x:hidden/.test(html));
test("mobile CTAs remain full-width and visible",
  /@media \(max-width:560px\)\{[\s\S]*?\.lp-cta\{flex-direction:column;align-items:stretch\}/.test(html) &&
  /@media \(max-width:700px\)\{[\s\S]*?\.lp-nav-cta \.lp-btn\{[^}]*white-space:nowrap/.test(html));
test("AI/Human and story layouts collapse for narrow screens",
  /@media \(max-width:700px\)\{[\s\S]*?\.lp-path-grid\{grid-template-columns:1fr\}/.test(html) &&
  /\.lp-story,\.lp-story:nth-child\(even\)\{grid-template-columns:1fr/.test(html));
test("mobile hero composes copy and actions over one full-width image canvas",
  /\.lp-hero-grid\{position:relative;display:block;height:clamp\(560px,175vw,700px\);overflow:hidden\}/.test(html) &&
  /\.lp-photo-hero\{position:absolute;inset:0;width:100%;height:100%;margin:0\}/.test(html) &&
  /\.lp-hero-copy\{position:relative;z-index:2;display:flex;flex-direction:column;height:100%/.test(html));
test("mobile hero uses a restrained contrast overlay and keeps both CTAs tappable",
  /\.lp-photo-hero::after\{[^}]*background:rgba\(8,10,13,\.34\)/.test(html) &&
  /#screen-landing \.lp-hero \.lp-cta\{[^}]*flex-direction:row[^}]*margin-top:auto/.test(html) &&
  /#screen-landing \.lp-hero \.lp-cta \.lp-btn\{[^}]*flex:1[^}]*font-size:12px/.test(html));
test("landing reveal honors reduced-motion preferences",
  /@media \(prefers-reduced-motion:reduce\)\{\.lp-reveal\{opacity:1;transform:none;transition:none\}\}/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
