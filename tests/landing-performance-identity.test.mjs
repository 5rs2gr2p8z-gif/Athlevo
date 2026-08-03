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

console.log("\n──── Section ordering and removed content ────");
test("phone mockup markup is removed",
  !landing.includes('class="lp-phone"') &&
  !landing.includes('class="lp-coach-peek"'));
test("phone mockup CSS is removed",
  !html.includes('.lp-phone{') && !html.includes('.lp-coach-peek{'));
test("integrations section is removed",
  !landing.includes('class="lp-integrations"') &&
  !landing.includes("Bring your training with you"));
test("integrations CSS is removed",
  !html.includes('.lp-integrations{') &&
  !html.includes('.lp-integration-list{'));
test("athlete results follows immediately after the hero",
  landing.indexOf("lp-athlete-results") > landing.indexOf("</header>") &&
  !landing.slice(landing.indexOf("</header>"), landing.indexOf("lp-athlete-results"))
    .includes('<section class="lp-integrations"'));

console.log("\n──── Athlete identity ────");
test("Frances Patawaran replaces Carl Zita",
  landing.includes("Frances Patawaran") && !landing.includes("Carl Zita"));
test("Frances Patawaran testimonial image path is correct",
  landing.includes("assets/testimonials/frances-patawaran.jpeg"));

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
test("mobile CTAs remain full-width and visible",
  /@media \(max-width:560px\)\{[\s\S]*?\.lp-cta\{flex-direction:column;align-items:stretch\}/.test(html));
test("landing reveal honors reduced-motion preferences",
  /@media \(prefers-reduced-motion:reduce\)\{\.lp-reveal\{opacity:1;transform:none;transition:none\}\}/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
