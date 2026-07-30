/*
 * Athlevo landing-page performance identity and integration rail.
 *
 * These source-level checks protect the marketing-page presentation without
 * coupling the signup funnel to a browser implementation.
 *
 * Run: node tests/landing-performance-identity.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const landing = html.slice(
  html.indexOf('<section class="screen lp" id="screen-landing">'),
  html.indexOf("<!-- ══════════════ WELCOME")
);
const integration = (landing.match(
  /<section class="lp-integrations"[\s\S]*?<\/section>/
) || [""])[0];

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

console.log("\n──── Integration truth and placement ────");
test("connected-training rail exists", integration.length > 0);
test("integration rail follows the hero preview",
  landing.indexOf('class="lp-integrations"') > landing.indexOf("</header>"));
test("integration rail precedes the longer athlete proof",
  landing.indexOf('class="lp-integrations"') <
    landing.indexOf("lp-athlete-results"));
[
  "YOUR TRAINING, CONNECTED",
  "Bring your training with you.",
  "Connect directly through Strava or bring data from compatible watches and platforms through Intervals.icu.",
  "Availability depends on the data each platform shares with Intervals.icu."
].forEach(copy => test(`exact copy: ${copy}`, integration.includes(copy)));
test("Strava is marked Direct",
  /Strava<\/span>\s*<span class="lp-integration-status direct">Direct/.test(integration));
test("Intervals.icu is marked Direct",
  /Intervals\.icu<\/span>\s*<span class="lp-integration-status direct">Direct/.test(integration));
["Garmin", "COROS", "Polar", "Suunto", "WHOOP", "Oura"].forEach(platform =>
  test(`${platform} is marked Via Intervals.icu`,
    integration.includes(
      `<span class="lp-integration-name">${platform}</span>\n` +
      '            <span class="lp-integration-status">Via Intervals.icu</span>'
    ))
);
test("supported platforms are not marked Coming soon",
  !integration.includes("Coming soon"));
test("no unapproved platform logos are fabricated",
  !/<img\b/.test(integration) && !/<svg\b/.test(integration));

console.log("\n──── Funnel and analytics wiring remain intact ────");
{
  const ctas = [...landing.matchAll(
    /<button[^>]*data-cta-location="([^"]+)"[^>]*onclick="landingStartFree\(this\)"[^>]*>Build My Training Plan<\/button>/g
  )].map(match => match[1]).sort();
  const expected = ["footer", "hero", "mid_page", "navigation"].sort();
  test("all four signup CTAs retain their handler and labels",
    JSON.stringify(ctas) === JSON.stringify(expected),
    ctas.join(", "));
}
test("secondary hero CTA keeps its destination",
  /<a class="lp-btn ghost" href="#lp-how">See how Athlevo works<\/a>/.test(landing));
test("landing CTA analytics still use the existing entry point",
  /function landingStartFree\(trigger\)[\s\S]*?signup_cta_clicked/.test(html));

console.log("\n──── Distinct visual hierarchy ────");
test("hero no longer uses a decorative startup gradient",
  /\.lp-hero\{[^}]*background:var\(--paper\)/.test(html) &&
  !/\.lp-hero\{[^}]*gradient/.test(html));
test("landing CTAs use compact card geometry rather than pill geometry",
  /\.lp-btn\{[^}]*border-radius:var\(--r-sm\)/.test(html) &&
  !/\.lp-btn\{[^}]*border-radius:var\(--r-pill\)/.test(html));
test("supporting headings use sans-serif by default",
  /\.lp-h2\{font-family:var\(--sans\)/.test(html));
test("serif remains available for selected editorial statements",
  /\.lp-h2\.lp-h2--editorial\{font-family:var\(--serif\)/.test(html) &&
  (landing.match(/lp-h2--editorial/g) || []).length >= 3);
test("feature descriptors use ruled rows rather than rounded pills",
  /\.lp-subgrid span\{[^}]*border-top:1px solid var\(--line\)/.test(html) &&
  !/\.lp-subgrid span\{[^}]*border-radius/.test(html));

console.log("\n──── Narrow viewport and accessibility safeguards ────");
test("the landing screen clips accidental horizontal overflow",
  /#screen-landing\{[^}]*overflow-x:hidden/.test(html));
test("integration columns can shrink without overflow",
  /\.lp-integration-list\{[^}]*minmax\(0,1fr\)/.test(html) &&
  /\.lp-integration-item\{[^}]*min-width:0/.test(html) &&
  /\.lp-integration-name\{[^}]*overflow-wrap:anywhere/.test(html));
test("narrow viewports receive a readable two-column platform rail",
  /@media \(max-width:560px\)\{[\s\S]*?\.lp-integration-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(html));
test("mobile CTAs remain full-width and visible",
  /@media \(max-width:560px\)\{[\s\S]*?\.lp-cta\{flex-direction:column;align-items:stretch\}/.test(html));
test("integration route is exposed as text, not color alone",
  integration.includes(">Direct</span>") &&
  integration.includes(">Via Intervals.icu</span>"));
test("landing reveal honors reduced-motion preferences",
  /@media \(prefers-reduced-motion:reduce\)\{\.lp-reveal\{opacity:1;transform:none;transition:none\}\}/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
