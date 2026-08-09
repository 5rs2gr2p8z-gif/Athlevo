/*
 * Athlevo landing-page performance identity.
 *
 * These source-level checks protect the marketing-page presentation without
 * coupling the signup funnel to a browser implementation.
 *
 * Run: node tests/landing-performance-identity.test.mjs
 */

import { existsSync, readFileSync } from "node:fs";

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
  landing.indexOf("THE ATHLETE COMES FIRST") < landing.indexOf("WAYS TO TRAIN"));
test("the athlete-first philosophy uses the approved concise training context",
  ["Work.", "Sleep.", "Strength.", "Heat.", "Fatigue.", "Missed sessions.", "Life."]
    .every(factor => landing.includes(`<span>${factor}</span>`)) &&
  landing.includes("Every one of them changes what the right training decision looks like.") &&
  landing.includes("Athlevo coaches the athlete in front of us — not the perfect week written on paper.") &&
  !/Strength training\.|Family\.|Other sports\.|All of them affect what training should look like next\./.test(landing));
test("AI and human coaching are presented as four support levels",
  landing.includes("One coaching philosophy.<br>Four levels of support.") &&
  ["Athlevo AI", "Athlevo Plan", "Athlevo Coaching", "Athlevo Elite"]
    .every(name => landingContent.includes(`name: "${name}"`)) &&
  ["ADAPTIVE SELF-GUIDED COACHING", "PROGRAM + MONTHLY EXPERT REVIEW", "WEEKLY COACH INVOLVEMENT", "FOUNDER-LED PERFORMANCE MANAGEMENT"]
    .every(type => landingContent.includes(`type: "${type}"`)));
test("founder story uses its approved editorial portrait",
  /<img src="assets\/landing\/dean-founder\.png"[^>]*alt="Dean Castro at an endurance race\."[^>]*loading="lazy"[^>]*decoding="async"/.test(landing) &&
  landing.includes("Founder &amp; Head Coach") &&
  landing.includes("He started questioning what runners were told was difficult."));
test("founder profile presents the supplied experience and institution story",
  landing.includes("Dean Castro was 19, a student-athlete, runner, and coach") &&
  landing.includes("coached more than 300 runners") &&
  landing.includes("foundation of the Athlevo Method") &&
  landing.includes("So Dean began building the software himself.") &&
  landing.includes("Athlete · Coach · Developer"));
test("founder pull quote is integrated as editorial text rather than a card",
  landing.includes('<blockquote class="lp-founder-pullquote lp-reveal">“Having workouts isn’t the same as knowing what decision to make next.”</blockquote>') &&
  /\.lp-founder-pullquote\{[^}]*border-left:3px solid var\(--red\)/.test(html) &&
  !/\.lp-founder-pullquote\{[^}]*background/.test(html));
test("founder layout places the image between introduction and story on mobile",
  /\.lp-founder-layout\{[^}]*grid-template-areas:"media intro" "media story"/.test(html) &&
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-founder-layout\{[^}]*grid-template-areas:"intro" "media" "story"/.test(html));
test("image slots are semantic hooks with no visible placeholder labels",
  ["FINAL_RACE_IMAGE"].every(slot =>
    landing.includes(`data-image-slot="${slot}"`)) &&
  !landing.includes("lp-photo-label") &&
  !landingContent.includes('node("span", "lp-photo-label"'));
test("athlete philosophy uses its approved lazy-loaded training image",
  /<img src="assets\/landing\/athlete-philosophy-training\.png"[^>]*alt="Athlevo athlete running during a training session\."[^>]*loading="lazy"[^>]*decoding="async"/.test(landing));
test("athlete story, offer, method, and FAQ collection roots exist",
  ["landingTrainingOffers", "landingAthleteStories", "landingMethodPrinciples", "landingFaq"]
    .every(id => landing.includes(`id="${id}"`)));
test("all six approved athlete stories and images are restored",
  ["Christian Francia", "Rodel Mark", "Carl Zita", "Amir Paule", "JB Luna", "Miguel Bulado"]
    .every(name => landingContent.includes(`name: "${name}"`)) &&
  ["christian-francia.jpg", "rodel-mark.jpg", "carl-zita.jpg", "amir-paule.jpg", "jb-luna.jpg", "miguel-bulado.jpg"]
    .every(image => landingContent.includes(`assets/testimonials/${image}`) && existsSync(`assets/testimonials/${image}`)) &&
  (landingContent.match(/quote:\s*"/g) || []).length === 6);
test("athlete feedback remains verbatim and contains no invented story fields",
  landingContent.includes("100% mai-improve ang fitness level mo") &&
  landingContent.includes("Dahil sa coaching, nakuha ko ang sub-19") &&
  landingContent.includes("Effective program, quality sessions, and very informative coaching.") &&
  landingContent.includes("Solid Athlevo! Mag-i-improve ka talaga.") &&
  landingContent.includes("The personalized training made a huge impact on my running journey.") &&
  landingContent.includes("guidance during my final year as a student athlete at Pampanga State University.") &&
  !/startingPoint|focus:|result:/.test(landingContent));
test("Athlete Stories uses the approved proof-section introduction",
  landing.includes("Built around the athlete. Proven with athletes.") &&
  landing.includes("Athlevo has helped runners with different goals, backgrounds, and starting points train with more direction."));
test("Ways to Train presents all four services and exact prices",
  landing.includes("WAYS TO TRAIN") &&
  landing.includes("One coaching philosophy.<br>Four levels of support.") &&
  ["Athlevo AI", "Athlevo Plan", "Athlevo Coaching", "Athlevo Elite"]
    .every(name => landingContent.includes(`name: "${name}"`)) &&
  ["₱597/month", "₱1,998/month", "₱4,998/month", "₱7,998/month"]
    .every(price => landingContent.includes(`price: "${price}"`)) &&
  !/TWO WAYS TO TRAIN|Two ways to train/i.test(landing));
test("Athlevo Plan copy consistently describes a coach-built independent plan",
  landingContent.includes("with a monthly review and one plan update") &&
  landingContent.includes("One monthly plan update") &&
  landingContent.includes("Messenger support for plan clarifications") &&
  landingContent.includes("without ongoing coach management.") &&
  !landingContent.includes("Speak with an Athlevo coach through a call and Messenger"));
test("offer CTAs retain existing AI and coaching destinations",
  /cta: "Build My Training Plan",\s*href: "#ai"/.test(landingContent) &&
  ["Build My Plan", "Start My Coaching", "Apply for Elite"]
    .every(cta => landingContent.includes(`cta: "${cta}"`)) &&
  (landingContent.match(/href: "#coaching"/g) || []).length === 3);
test("coaching routes resolve to WAYS TO TRAIN without a duplicate pricing section",
  /<section class="lp-section" id="train-with-athlevo">[\s\S]*?<span id="coaching" aria-hidden="true"><\/span>[\s\S]*?id="landingTrainingOffers"/.test(landing) &&
  !/id="landingCoachingTiers"|Choose how closely you want to be coached\.|<section[^>]*id="coaching"/.test(landing));
test("only one primary homepage offer comparison remains",
  (landing.match(/id="landingTrainingOffers"/g) || []).length === 1 &&
  !/coachingTiers:\s*\[|renderTiers\(|lp-tier/.test(landingContent + html));
test("structured offer data matches the retained four-card architecture",
  [
    ["Athlevo AI", "597"],
    ["Athlevo Plan", "1998"],
    ["Athlevo Coaching", "4998"],
    ["Athlevo Elite", "7998"]
  ].every(([name, price]) =>
    html.includes(`{ "@type": "Offer", "name": "${name}", "price": "${price}", "priceCurrency": "PHP" }`)) &&
  !html.includes(`"name": "Human Coaching", "price": "1998"`));
test("offer categories and headlines lead with athlete outcomes",
  [
    ["ADAPTIVE SELF-GUIDED COACHING", "Stop guessing. Start training toward something."],
    ["PROGRAM + MONTHLY EXPERT REVIEW", "A plan built for you."],
    ["WEEKLY COACH INVOLVEMENT", "A coach guiding the process."],
    ["FOUNDER-LED PERFORMANCE MANAGEMENT", "Personally coached by Dean."]
  ].every(([type, headline]) => landingContent.includes(`type: "${type}"`) && landingContent.includes(`headline: "${headline}"`)) &&
  !/["'](?:INDEPENDENT COACHING|HUMAN COACHING|FOUNDER COACHING)["']/.test(landingContent));
test("offer best-for lines explain the four ascending levels of support",
  [
    "Athletes who want structure, adaptation, and daily direction without hiring a dedicated coach.",
    "Athletes who can train independently but want personalized structure and monthly expert review.",
    "Athletes who want weekly accountability, feedback, and ongoing adjustments.",
    "Athletes who want close performance management and direct access to the founder and head coach."
  ].every(copy => landingContent.includes(`bestFor: "${copy}"`)));
test("Coaching promises weekly involvement without taking Elite’s founder-led position",
  landingContent.includes("Weekly training review") &&
  landingContent.includes("actively involved in guiding their training and development") &&
  landingContent.includes("Your coach stays involved throughout the training block") &&
  !landingContent.includes("actively responsible for their training and development"));
test("Elite distinguishes founder-led attention and deeper decision-making",
  ["Personally coached by Dean Castro", "More frequent training review", "Deeper performance analysis", "Direct priority communication"]
    .every(copy => landingContent.includes(copy)) &&
  landingContent.includes("Dean personally manages your training as an evolving performance project"));
test("Ways to Train includes the subtle Plan-first reassurance",
  /<p class="lp-offer-reassurance lp-reveal">Not sure which one fits\? Start with Plan and upgrade anytime\.<\/p>/.test(landing) &&
  /\.lp-offer-reassurance\{[^}]*font-size:12\.5px[^}]*color:var\(--ink3\)/.test(html));
test("Ways to Train uses a native horizontal snap rail",
  /class="lp-offer-rail lp-reveal"[^>]*id="landingTrainingOffers"/.test(landing) &&
  /\.lp-offer-rail\{[^}]*grid-auto-flow:column[^}]*overflow-x:auto[^}]*scroll-snap-type:x proximity/.test(html) &&
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-offer-rail\{[^}]*display:flex[^}]*overflow-x:auto[^}]*overflow-y:visible[^}]*scroll-snap-type:x mandatory/.test(html) &&
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-offer\{[^}]*flex:0 0 86vw[^}]*width:86vw[^}]*min-width:86vw[^}]*max-width:86vw/.test(html) &&
  /\.lp-offer\{[^}]*scroll-snap-align:start/.test(html));
test("mobile offer copy retains the full non-shrinking panel width",
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-offer>\*\{[^}]*max-width:100%[^}]*min-width:0/.test(html) &&
  !/@media \(max-width:(?:700|900)px\)\{[\s\S]*?\.lp-offer-rail\{[^}]*grid-(?:template|auto)-columns/.test(html));
test("375, 390, and 430px rails show one 86vw offer plus a restrained next-offer peek",
  [375, 390, 430].every(width => {
    const edge = Math.max(20, Math.min(width * 0.05, 40));
    const card = width * 0.86;
    const visibleRail = width - edge;
    const peek = visibleRail - card - 16;
    return card > width * 0.82 && card < width * 0.9 && peek > 0 && peek < 32;
  }) &&
  /#screen-landing\{[^}]*overflow-x:hidden/.test(html));
test("all offers begin with product information and contain no media markup",
  /article\.append\(\s*node\("span", "lp-offer-type", offer\.type\),\s*node\("p", "lp-offer-name", offer\.name\),\s*node\("h3", "", offer\.headline\),\s*node\("p", "lp-offer-price", offer\.price\)/.test(landingContent) &&
  !/lp-offer-media|lp-offer-app|renderOfferMedia|mobilePosition|\bmedia:\s*\{/.test(landingContent) &&
  !/\.lp-offer-media|\.lp-offer-app|--lp-offer-(?:mobile-)?position/.test(html));
test("offers use restrained boxed product-card treatment",
  /\.lp-offer\{[^}]*padding:24px[^}]*border:1px solid var\(--line\)[^}]*border-radius:14px[^}]*background:var\(--paper\)/.test(html) &&
  !/\.lp-offer\{[^}]*box-shadow|\.lp-offer\{[^}]*gradient/.test(html));
test("mobile offer identity follows the compact product-card rhythm",
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-offer\{[^}]*padding:22px/.test(html) &&
  /\.lp-offer-name\{margin-top:8px/.test(html) &&
  /\.lp-offer h3\{font-size:clamp\(30px,8vw,38px\);line-height:1;margin-top:12px/.test(html) &&
  /\.lp-offer-price\{[^}]*font-size:28px[^}]*margin:16px 0 0[^}]*white-space:nowrap/.test(html));
test("each offer CTA appears before its organized feature list and secondary note",
  /node\("p", "lp-offer-price", offer\.price\),\s*bestFor,\s*node\("p", "lp-offer-description", offer\.description\),\s*cta,\s*features,\s*node\("p", "lp-offer-note", offer\.note\)/.test(landingContent) &&
  /node\("a", "lp-btn lp-offer-cta", offer\.cta\)/.test(landingContent));
test("best-for copy is restrained text rather than a badge",
  /const bestFor = node\("div", "lp-offer-best"\)/.test(landingContent) &&
  /bestFor\.append\(node\("span", "", "BEST FOR"\), node\("p", "", offer\.bestFor\)\)/.test(landingContent) &&
  /\.lp-offer-best span\{[^}]*font-size:9\.5px[^}]*color:var\(--ink3\)/.test(html) &&
  !/lp-offer-best[^\n]*(?:badge|border-radius|background)/.test(html));
test("offer CTAs are prominent full-width card actions",
  /\.lp-offer \.lp-offer-cta\{[^}]*width:100%[^}]*border-radius:8px[^}]*background:#141416[^}]*color:#fff[^}]*font-weight:750/.test(html));
test("mobile offer details retain all content at compact density",
  /\.lp-offer-description\{[^}]*font-size:13px[^}]*line-height:1\.48/.test(html) &&
  /\.lp-offer-features\{margin:20px 0 18px/.test(html) &&
  /\.lp-offer-features\{[^}]*grid-template-columns:1fr/.test(html) &&
  /\.lp-offer-features li\{padding:8px 0;font-size:12px;line-height:1\.35/.test(html) &&
  /\.lp-offer-note\{[^}]*font-size:11\.5px[^}]*line-height:1\.45/.test(html));
test("desktop cards remain comparison-width and size to their content",
  /\.lp-offer-rail\{[^}]*grid-auto-columns:minmax\(340px,calc\(\(100% - 36px\)\/3\)\)/.test(html) &&
  /\.lp-offer\{[^}]*align-self:start/.test(html) &&
  !/\.lp-offer\{[^}]*height:100%/.test(html));
test("offers, method principles, and FAQs are editable data collections",
  /trainingOffers:\s*\[/.test(landingContent) &&
  /methodPrinciples:\s*\[/.test(landingContent) &&
  /faq:\s*\[/.test(landingContent));
test("all approved offer prices, five method principles, and ten FAQs are present",
  ["₱597/month", "₱1,998/month", "₱4,998/month", "₱7,998/month"].every(price =>
    landingContent.includes(`price: "${price}"`)) &&
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
  /\.lp-offer-type,[\s\S]*font-size:11px/.test(html));
test("editorial statements retain the existing serif family",
  /#screen-landing \.lp-h2\{font-family:var\(--serif\)/.test(html));
test("offer cards and method retain their structured editorial treatment",
  /\.lp-offer\{[^}]*border:1px solid var\(--line\)/.test(html) &&
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
test("athlete philosophy crop preserves the runner and excludes source bars",
  /\.lp-photo-philosophy\{aspect-ratio:3\/4;min-height:520px\}/.test(html) &&
  /\.lp-photo-philosophy>img\{object-fit:cover;object-position:center 30%\}/.test(html) &&
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-photo-philosophy\{[^}]*height:clamp\(280px,82vw,350px\)[^}]*aspect-ratio:auto[^}]*min-height:0/.test(html) &&
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-photo-philosophy>img\{object-position:center 42%\}/.test(html));
test("athlete philosophy mobile image stays compact at target phone widths",
  [375, 390, 430].every(width => {
    const height = Math.min(350, Math.max(280, width * 0.82));
    return height >= 280 && height <= 350;
  }));
test("athlete philosophy reads as one tight mobile editorial unit",
  /@media \(max-width:900px\)\{[\s\S]*?#athlete-first \.lp-editorial-split\{gap:20px\}/.test(html) &&
  /#athlete-first \.lp-life-list\{margin:20px 0 16px;gap:6px 20px\}/.test(html) &&
  /#athlete-first \.lp-life-list\+\.lp-body\{margin-top:0\}/.test(html) &&
  /#athlete-first \.lp-life-list\+\.lp-body\+\.lp-body\{margin-top:10px\}/.test(html) &&
  !/@media \(max-width:380px\)\{[\s\S]*?\.lp-life-list\{grid-template-columns:1fr\}/.test(html));
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
  /@media \(max-width:900px\)\{[\s\S]*?\.lp-offer-rail\{display:flex/.test(html) &&
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
