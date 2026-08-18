/*
 * Athlevo landing conversion-improvement contract.
 *
 * Source-level checks for the conversion sprint: legal-link integrity,
 * human-tier CTA routing, hero clarity + priced app-entry CTA, proof strip,
 * offer contrast copy, section order, testimonial order, FAQ risk reversal,
 * final-CTA behavior, accurate schema (no fabricated ratings), and heading
 * structure. These protect the changes without coupling to a browser.
 *
 * Run: node tests/landing-conversion.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const content = readFileSync("./js/landingContent.js", "utf8");
const landing = html.slice(
  html.indexOf('<section class="screen lp" id="screen-landing">'),
  html.indexOf("<!-- ══════════════ WELCOME")
);

let passed = 0, failed = 0;
function test(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS — ${name}`); }
  else { failed++; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}

console.log("\n──── 1. Legal links are valid JS (no smart quotes) ────");
test("no curly/smart quotes remain in any inline on* handler",
  !/on\w+="[^"]*[‘’][^"]*"/.test(html));
test("openLegal handlers use straight-quoted string arguments only",
  (html.match(/openLegal\(/g) || []).length > 0 &&
  !/openLegal\([‘’]/.test(html) &&
  /onclick="openLegal\('privacy'\)"/.test(html) &&
  /onclick="openLegal\('terms'\)"/.test(html));
test("theme + toast handlers that shared the bug are also straight-quoted",
  /setAthlevoTheme\('(?:system|light|dark)'\)/.test(html) &&
  !/setAthlevoTheme\([‘’]/.test(html) &&
  !/toast\([‘’]/.test(html));

console.log("\n──── 2. Human-tier CTAs no longer dead-end at #coaching ────");
test("no offer in landing content routes to the dead #coaching anchor",
  !/href:\s*"#coaching"/.test(content));
test("Athlevo Plan CTA routes to an actionable contact destination",
  /cta: "Get My Plan",\s*href: "mailto:support@athlevo\.org\?subject=Athlevo%20Plan%20Enquiry"/.test(content));
test("Athlevo Coaching CTA routes to an actionable contact destination",
  /cta: "Start Coaching",\s*href: "mailto:support@athlevo\.org\?subject=Athlevo%20Coaching%20Enquiry"/.test(content));
test("Athlevo Elite CTA routes to an actionable contact destination",
  /cta: "Apply for Elite",\s*href: "mailto:support@athlevo\.org\?subject=Athlevo%20Elite%20Enquiry"/.test(content));
test("the AI tier still enters the app via the existing signup handler (unchanged)",
  /cta: "Start Training",[\s\S]*?appEntry: true,[\s\S]*?ctaLocation: "ai_product"/.test(content));

console.log("\n──── 3-4. Hero clarity + single dominant priced CTA ────");
const hero = landing.slice(landing.indexOf('<header class="lp-hero"'), landing.indexOf("</header>"));
test("hero shows the AI + human, one-philosophy positioning kicker",
  /<span class="lp-kicker">ENDURANCE COACHING — AI \+ HUMAN, ONE PHILOSOPHY<\/span>/.test(hero));
test("approved H1 is preserved",
  /<h1 class="lp-h1">Your training plan<br>should change<br>when your life<br>does\.<\/h1>/.test(hero));
test("subheadline communicates the app-to-coach ladder",
  /from an adaptive app you run yourself to a coach in your corner every week/.test(hero));
test("hero carries the supported proof line (300\\+ runners)",
  /<p class="lp-hero-proof">300\+ runners coached · marathon, hybrid &amp; performance goals\.<\/p>/.test(hero));
test("primary hero CTA is a priced Athlevo AI app-entry button",
  /<button class="lp-btn" type="button" data-cta-location="hero_ai" onclick="landingStartFree\(this\)">Start with Athlevo AI — ₱597\/mo<\/button>/.test(hero));
test("hero price is ₱597",
  /Start with Athlevo AI — ₱597\/mo/.test(hero));
test("secondary hero CTA is a subordinate scroll link, not a second app-entry",
  /<a class="lp-btn ghost" href="#train-with-athlevo">See coaching options<\/a>/.test(hero) &&
  (hero.match(/landingStartFree/g) || []).length === 1);

console.log("\n──── 5. Thin editorial proof strip below the hero ────");
test("a restrained proof strip follows the hero (no logo wall / SaaS gloss)",
  /<\/header>\s*<!-- PROOF STRIP -->\s*<section class="lp-proofstrip"/.test(landing) &&
  /<span class="lp-proofstrip-stat">300\+ runners coached<\/span>/.test(landing) &&
  /Running · Marathon · Hybrid · Performance/.test(landing));
test("proof strip styling reuses existing brand tokens only",
  /\.lp-proofstrip\{[^}]*border-top:1px solid var\(--line\)/.test(html) &&
  /\.lp-proofstrip-sep\{[^}]*background:var\(--red\)/.test(html) &&
  !/\.lp-proofstrip[^{]*\{[^}]*gradient/.test(html));

console.log("\n──── 6. Reassurance + support-level contrast copy ────");
test("offer reassurance no longer points beginners past the true entry tier",
  /Want a human from day one\? Start with Plan\./.test(landing) &&
  !/Not sure which one fits\? Start with Plan and upgrade anytime\./.test(landing));
test("each tier states its support level as a concise contrast line",
  /supportLevel: "Self-guided adaptive app\."/.test(content) &&
  /supportLevel: "Built for you, run independently\."/.test(content) &&
  /supportLevel: "A coach with you every week\."/.test(content) &&
  /supportLevel: "Founder-led, highest touch\."/.test(content));
test("the support-level line is rendered under the offer name",
  /article\.append\(node\("p", "lp-offer-name", offer\.name\)\);\s*if \(offer\.supportLevel\) article\.append\(node\("p", "lp-offer-support", offer\.supportLevel\)\)/.test(content));

console.log("\n──── 7. Section order: pricing before the long founder read ────");
test("Ways to Train appears before the Founder/Method section",
  landing.indexOf("WAYS TO TRAIN") < landing.indexOf("WHY ATHLEVO EXISTS") &&
  landing.indexOf("WHY ATHLEVO EXISTS") < landing.indexOf("THE ATHLEVO METHOD"));
test("Athlete Stories still precede Ways to Train",
  landing.indexOf("ATHLETE STORIES") < landing.indexOf("WAYS TO TRAIN"));
test("all key section anchors still resolve",
  ["id=\"train-with-athlevo\"", "id=\"about\"", "id=\"athletes\"", "id=\"method\""]
    .every(a => landing.includes(a)) &&
  /<span id="coaching" aria-hidden="true"><\/span>/.test(landing) &&
  /<span id="ai" aria-hidden="true"><\/span>/.test(landing));

console.log("\n──── 8. Testimonial order leads with specific proof ────");
test("Rodel (Sub-19 5K) and Miguel lead the athlete stories",
  content.indexOf('name: "Rodel Mark"') < content.indexOf('name: "Miguel Bulado"') &&
  content.indexOf('name: "Miguel Bulado"') < content.indexOf('name: "Christian Francia"'));
test("all six approved stories remain, verbatim and complete",
  ["Christian Francia", "Rodel Mark", "Carl Zita", "Amir Paule", "JB Luna", "Miguel Bulado"]
    .every(n => content.includes(`name: "${n}"`)) &&
  (content.match(/quote:\s*"/g) || []).length === 6);

console.log("\n──── 9-10. FAQ risk reversal (accurate to product/terms) ────");
test("FAQ explains what happens after signup",
  /question: "What happens after I sign up\?"/.test(content) &&
  /short onboarding covering your goal, schedule, training history/.test(content));
test("FAQ cancellation answer matches Terms §10 (no overpromise)",
  /question: "Can I cancel anytime\?"/.test(content) &&
  /stop future recurring charges/.test(content) &&
  /does not automatically refund previous payments/.test(content));

console.log("\n──── 11. Final CTA no longer loops to pricing ────");
const finalCta = landing.slice(landing.indexOf('<section class="lp-final-brand">'));
test("final primary CTA enters the app via the existing handler",
  /<button class="lp-btn light" type="button" data-cta-location="final_ai" onclick="landingStartFree\(this\)">Start with Athlevo AI<\/button>/.test(finalCta));
test("final secondary CTA reaches the existing human contact path",
  /<a class="lp-btn ghost-light" href="mailto:support@athlevo\.org\?subject=Athlevo%20Human%20Coaching">Talk to a Coach<\/a>/.test(finalCta));
test("enrollment continuation state is preserved",
  /Continue your enrollment\./.test(finalCta));

console.log("\n──── 15. SEO: accurate FAQPage, no fabricated ratings ────");
test("FAQPage JSON-LD is present and valid JSON",
  (() => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const faq = blocks.map(b => { try { return JSON.parse(b[1]); } catch { return null; } })
      .find(o => o && o["@type"] === "FAQPage");
    return !!faq && Array.isArray(faq.mainEntity) && faq.mainEntity.length === 12;
  })());
test("no fabricated rating/review schema was introduced",
  !/AggregateRating|ratingValue|reviewCount|"@type":\s*"Review"/.test(html));
test("Organization offer schema and prices are preserved",
  ["597", "1998", "4998", "7998"].every(p => html.includes(`"price": "${p}"`)));

console.log("\n──── 16. Accessibility / heading structure ────");
test("landing keeps a single H1",
  (landing.match(/<h1[\s>]/g) || []).length === 1);
test("new CTAs are semantic buttons/links (native activation, no div-buttons)",
  !/<div[^>]*onclick="landingStartFree/.test(landing));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
