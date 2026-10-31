/**
 * Athlevo /programs program storefront contract.
 *
 * Run: node tests/store-route.test.mjs
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import vm from "node:vm";
import { staleFiles } from "../scripts/build-store-pages.mjs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const storeHtml = readFileSync("./store.html", "utf8");
const catalogSrc = readFileSync("./js/storeCatalog.js", "utf8");
const storefrontSrc = readFileSync("./js/storefront.js", "utf8");
const css = readFileSync("./store.css", "utf8");
const indexHtml = readFileSync("./index.html", "utf8");
const sw = readFileSync("./service-worker.js", "utf8");

const catalogSandbox = { window: {} };
catalogSandbox.window = catalogSandbox;
catalogSandbox.globalThis = catalogSandbox;
vm.runInNewContext(catalogSrc, catalogSandbox);
const catalog = catalogSandbox.AthlevoStoreCatalog;

const bodyOnly = storeHtml.replace(/<!--[\s\S]*?-->/g, "");

section("1. Route wiring");
{
  t("store.html exists", existsSync("./store.html") && storeHtml.length > 400);
  t("vercel rewrites /programs to store.html",
    vercel.rewrites.some(r => r.source === "/programs" && r.destination === "/store.html"));
  t("vercel rewrites /programs/:slug to store.html",
    vercel.rewrites.some(r => r.source === "/programs/:slug" && r.destination === "/store.html"));
  t("the old /store paths are no longer rewritten, only redirected",
    !vercel.rewrites.some(r => r.source === "/store" || r.source.startsWith("/store/")));
  t("existing /ai rewrite is unchanged",
    vercel.rewrites.some(r => r.source === "/ai" && r.destination === "/index.html"));
  t("existing /pricing rewrite is unchanged",
    vercel.rewrites.some(r => r.source === "/pricing" && r.destination === "/index.html"));
  t("storefront is not loaded from the app shell",
    !indexHtml.includes("storeCatalog") && !indexHtml.includes("storefront.js"));
}

section("2. Catalog data");
{
  const ORDER = ["Athlevo Plan", "Athlevo Guided", "Athlevo Coaching", "Athlevo VIP Coaching"];
  t("catalog exposes the four offers", catalog.products.length === 4);
  const names = catalog.products.map(p => p.name).join("|");
  t("card names and order match the approved list", names === ORDER.join("|"), names);
  t("First 10K is removed from the catalog",
    !catalog.products.some(p => /10k/i.test(p.name + p.slug)) &&
    catalog.getProduct("first-10k") === null &&
    catalog.getProduct(catalog.resolveSlug("first-10k")) === null);
  t("slugs are unique and URL-safe",
    catalog.products.every(p => /^[a-z0-9-]+$/.test(p.slug)) &&
    new Set(catalog.products.map(p => p.slug)).size === 4);
  t("slugs follow the new names",
    catalog.products.map(p => p.slug).join(",") === "athlevo-plan,athlevo-guided,athlevo-coaching,athlevo-vip-coaching");
  t("each card uses its assigned photo",
    [["athlevo-plan", "/assets/store/track-1280.webp"],
     ["athlevo-guided", "/assets/store/hybrid-1023.webp"],
     ["athlevo-coaching", "/assets/store/road-1280.webp"],
     ["athlevo-vip-coaching", "/assets/store/pack-1206.webp"]]
      .every(([slug, src]) => catalog.getProduct(slug).hero.src === src));
  t("offers carry no old race-specific copy or durations",
    catalog.products.every(p =>
      ["durationWeeks", "durationLabel", "intendedRunner", "summary", "description",
       "whoFor", "startingFitness", "receives", "intakeAndDelivery", "collection"]
        .every(k => !(k in p))));
  // The one exception is the Athlevo Plan, which is a 4-week plan (owner, 2026-10-31).
  const offerJson = (list) => JSON.stringify(list.map(({ coachSupport, hero, page, ...rest }) =>
    ({ ...rest, page: page && { ...page, athleteFeedback: undefined } })));
  const raceOrWeeks = /\b(5k|10k|half[- ]marathon|marathon|\d+[- ]weeks?)\b/i;
  t("offer data mentions no race distances or week counts, except the Athlevo Plan's 4-week plan (approved athlete quotes excepted)",
    !raceOrWeeks.test(offerJson(catalog.products.filter(p => p.slug !== "athlevo-plan"))) &&
    !raceOrWeeks.test(offerJson(catalog.products.filter(p => p.slug === "athlevo-plan")).replace(/\b4-week\b/g, "")) &&
    /4-week/.test(offerJson(catalog.products.filter(p => p.slug === "athlevo-plan"))));
  t("all four offers have built pages, so none is left on the bare layout",
    catalog.products.every(p => !!p.page) &&
    catalog.getProduct("hybrid-programming") === null && catalog.getProduct("elite-coaching") === null);
  t("race-based collections are gone",
    !("collections" in catalog) && !("getCollection" in catalog) && !("filterProducts" in catalog));
  t("old race URLs and the old Elite address resolve to the renamed offers; the dropped Hybrid Programming has no page to resolve to",
    catalog.resolveSlug("first-5k") === "athlevo-plan" &&
    catalog.resolveSlug("faster-5k") === "athlevo-coaching" &&
    catalog.resolveSlug("marathon") === "athlevo-vip-coaching" &&
    catalog.resolveSlug("elite-coaching") === "athlevo-vip-coaching" &&
    !("half-marathon" in catalog.legacySlugs) && !("hybrid-programming" in catalog.legacySlugs) &&
    catalog.getProduct(catalog.resolveSlug("half-marathon")) === null &&
    catalog.getProduct(catalog.resolveSlug("hybrid-programming")) === null);
  t("current slugs resolve to themselves",
    catalog.products.every(p => catalog.resolveSlug(p.slug) === p.slug && catalog.getProduct(p.slug) === p));
  t("related programs are the other three offers and never include self",
    catalog.products.every(p => {
      const rel = catalog.relatedProducts(p).map(r => r.slug).sort().join(",");
      const expected = catalog.products.filter(o => o !== p).map(o => o.slug).sort().join(",");
      return rel === expected;
    }));
  t("purchasingAvailable is false", catalog.purchasingAvailable === false);
}

section("3. No invented commercial claims");
{
  const blob = catalogSrc + storeHtml + storefrontSrc;
  const PRICES = { "athlevo-plan": "₱999", "athlevo-guided": "₱2,997", "athlevo-coaching": "₱4,998", "athlevo-vip-coaching": "₱7,998" };
  const withoutConfirmedPrice = Object.values(PRICES).reduce((acc, price) => acc.split(price).join(""), blob);
  t("no prices, currency, or fake discounts beyond the confirmed ₱999, ₱2,997, ₱4,998 and ₱7,998",
    !/\$\d|₱\d|€\d|£\d|was\s*₱|sale price|\bfees?\b|free trial/i.test(withoutConfirmedPrice) &&
    !/%\s*off|discount|coupon/i.test(catalogSrc + storeHtml));
  t("the only discount wording is the code box: the storefront hard-codes no percentage and no amount",
    !/\d\s*%\s*(off|discount)/i.test(storefrontSrc) && !/₱\s*\d/.test(storefrontSrc) && !/\b(jcir|partner)\b/i.test(catalogSrc + storeHtml + storefrontSrc));
  const dataOf = (slug) => JSON.stringify(catalog.getProduct(slug));
  t("each confirmed price lives only in its own offer's page data",
    Object.values(PRICES).every(price => catalogSrc.split(price).length - 1 === 1) &&
    !storeHtml.includes("₱") && !storefrontSrc.includes("₱") &&
    Object.entries(PRICES).every(([slug, price]) => catalog.getProduct(slug).page.price.amount === price &&
      Object.values(PRICES).filter(other => other !== price).every(other => !dataOf(slug).includes(other))));
  t("the VIP price is published only on the VIP page, and the /programs page shows no price",
    /7,998/.test(dataOf("athlevo-vip-coaching")) && !/7,998/.test(storeHtml) &&
    ["athlevo-plan", "athlevo-guided", "athlevo-coaching"].every(slug => !/7,998/.test(dataOf(slug))));
  t("no testimonials or invented athlete results on the storefront",
    !/testimonial|guaranteed pr|sub-\d+|i improved my/i.test(storeHtml + storefrontSrc) &&
    !/athleteStories/.test(catalogSrc));
  t("no accreditations or guarantees in catalog copy",
    !/certified by|accredited|guarantee a (time|result)|race-time guarantee/i.test(catalogSrc));
  t("undecided coach-support terms stay in internal catalog data",
    catalog.products.every(p => p.coachSupport && p.coachSupport.status === "pending"));
  // Customer-facing copy = everything the storefront can render, minus coachSupport.
  const publicCopy = JSON.stringify({
    hero: catalog.hero, intro: catalog.intro, faqs: catalog.faqs,
    products: catalog.products.map(({ coachSupport, ...rest }) => ({ ...rest, hero: rest.hero.alt }))
  });
  t("customer-facing copy omits pending or undecided terms",
    !/pending|not decided|not approved|to be announced|still being decided/i.test(publicCopy + storeHtml));
  t("storefront never renders coachSupport",
    !/coachSupport|Coach support/i.test(storefrontSrc));
}

section("4. Storefront chrome");
{
  t("the notice in the shell is the one the catalog writes for the current sign-up state",
    storeHtml.includes('<div class="notice">' + catalog.notice() + "</div>"));
  t("nav includes Athlevo, Programs, FAQ",
    /wordmark[\s\S]*Athlevo/.test(storeHtml) &&
    /href="\/programs#programs"[^>]*>Programs</.test(storeHtml) &&
    /href="\/programs#faq">FAQ</.test(storeHtml) &&
    !/How It Works/.test(storeHtml));
  t("skip link is present", /Skip to main content/.test(storeHtml));
  t("header and footer brand is the text wordmark with the red full stop, hidden from screen readers",
    /<a class="wordmark" href="\/programs">Athlevo<i aria-hidden="true">\.<\/i><\/a>/.test(storeHtml) &&
    /<a class="footer-mark" href="\/programs">Athlevo<i aria-hidden="true">\.<\/i><\/a>/.test(storeHtml) &&
    /\.wordmark i,\s*\.footer-mark i\s*\{[^}]*color:\s*var\(--red-on-dark\)[^}]*font-style:\s*normal/.test(css) &&
    /--red-on-dark:\s*#e5484d/.test(css));
  t("the storefront chrome carries no logo image",
    !/athlevo-coaching-logo|brand-logo/.test(storeHtml) && !/brand-logo/.test(css));
  t("hero headline is in the catalog source",
    catalog.hero.headline === "Online Running Coach in the Philippines");
  t("product pages render detail sections only when an offer defines them",
    /if \(!items \|\| !items\.length\) return;/.test(storefrontSrc) &&
    /if \(grid\.children\.length\)/.test(storefrontSrc) &&
    /if \(product\.summary\)/.test(storefrontSrc) &&
    /Duration/.test(storefrontSrc) &&
    /Who it is for/.test(storefrontSrc) &&
    /Starting fitness/.test(storefrontSrc) &&
    /What you receive/.test(storefrontSrc) &&
    /Intake and delivery/.test(storefrontSrc) &&
    /Related programs/.test(storefrontSrc));
  t("purchase button stays disabled",
    /Purchasing not available/.test(storefrontSrc) &&
    /aria-disabled", "true"/.test(storefrontSrc));
  t("no form fields, card inputs or payment-details code in the storefront (payment happens on PayMongo)",
    !/<(form|input|textarea|select)\b/i.test(bodyOnly) &&
    !/openSignup|openLogin|whop|storekit/i.test(storeHtml + storefrontSrc) &&
    !/\b(card number|cvv|cvc|expiry)\b/i.test(storefrontSrc));
}

section("4b. Catalog page structure");
{
  t("catalog page has a short intro", typeof catalog.intro === "string" && catalog.intro.length > 20 && catalog.intro.length < 480);
  t("hero is a clean photo with no overlaid text",
    !/hero-copy/.test(storefrontSrc + css));
  t("mobile nav uses a hamburger icon button",
    /class="nav-toggle"[^>]*aria-label="Menu"[\s\S]*class="bars"/.test(storeHtml));
  t("catalog page renders hero, intro, program cards, and FAQ",
    /\$\("section", "hero"\)/.test(storefrontSrc) &&
    /\$\("section", "intro"\)/.test(storefrontSrc) &&
    /program-grid/.test(storefrontSrc) &&
    /id = "faq"/.test(storefrontSrc));
  const renderCat = storefrontSrc.slice(storefrontSrc.indexOf("function renderCatalog"), storefrontSrc.indexOf("function renderProduct("));
  t("catalog order is hero, intro, programs, Meet the coaches, FAQ",
    ['$("section", "hero")', '$("section", "intro")', 'programs.id = "programs"', 'coaches.id = "coaches"', 'faq.id = "faq"']
      .map(s => renderCat.indexOf(s)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])));
  t("coaches section is headed 'Meet the coaches' and renders every catalog coach",
    /"Meet the coaches"/.test(renderCat) && /catalog\.coaches\.forEach/.test(renderCat) && /function renderCoachCard/.test(storefrontSrc));
  t("coaches list holds only verified people: Dean Vincent Castro, Christian Francia, Louie Agawa",
    catalog.coaches.map(c => c.name).join("|") === "Dean Vincent Castro|Christian Francia|Louie Agawa" &&
    catalog.coaches[0].role === "Founder & Head Coach, Athlevo" &&
    catalog.coaches[0] === catalog.getProduct("athlevo-vip-coaching").page.coach &&
    catalog.coaches[1].role === "Strength & Conditioning Coach, Assistant Running Coach, Athlevo" &&
    catalog.coaches[1].intro === "Christian is an assistant coach at Athlevo. He specializes in strength and conditioning.");
  t("only the owner-supplied certifications appear, on Dean's, Christian's and Louie's cards, exactly as supplied",
    catalog.coaches.filter(c => c.certifications).map(c => c.name).join("|") === "Dean Vincent Castro|Christian Francia|Louie Agawa" &&
    JSON.stringify(catalog.coaches[0].certifications) === JSON.stringify(
      ["USATF Level 1 Certified Coach", "STRYD Certified Running Coach"]) &&
    catalog.coaches[0].credentialsLabel === "Credentials" &&
    JSON.stringify(catalog.coaches[1].certifications) === JSON.stringify(
      ["Functional training", "Fitness body anatomy", "Movement analysis and corrective exercise", "Basic nutrition", "OCR"]) &&
    !("credentialsLabel" in catalog.coaches[1]) &&
    /"Certified in"/.test(storefrontSrc) &&
    catalog.getProduct("athlevo-vip-coaching").page.coach === catalog.coaches[0]);
  const louie = catalog.coaches[2];
  t("Louie Agawa: role, intro and credentials exactly as supplied",
    louie.role === "Running Coach, Athlevo" &&
    louie.intro === "Louie is a running coach at Athlevo and a competitive middle to long distance runner." &&
    louie.credentialsLabel === "Credentials" &&
    JSON.stringify(louie.certifications) === JSON.stringify(
      ["World Athletics Certified Coach — CECS Level 1", "ISSA Certified Running Coach"]) &&
    /coach\.credentialsLabel \|\| "Certified in"/.test(storefrontSrc));
  t("coach cards show credentials only: no coach has personal bests and none render",
    catalog.coaches.every(c => !("personalBests" in c)) &&
    !/personalBests|Personal bests|coach-card-bests/.test(storefrontSrc) &&
    !/coach-card-bests/.test(readFileSync("store.css", "utf8")));
  t("Louie's photo: original plus optimized WebP and AVIF exist, with alt text",
    louie.photo.src === "/assets/store/louie-640.webp" &&
    louie.photo.original === "/assets/landing/louie-agawa-coach.jpg" &&
    existsSync("." + louie.photo.original) &&
    louie.photo.webp.length === 1 && louie.photo.avif.length === 1 &&
    existsSync("." + louie.photo.webp[0].src) && existsSync("." + louie.photo.avif[0].src) &&
    /Louie Agawa/.test(louie.photo.alt) && louie.photo.width === 640 && louie.photo.height === 800);
  t("coach entries have name, role, optimized photo and a short bio, with no credentials or achievements",
    catalog.coaches.every(c => c.name && c.role && c.photo && c.photo.src.startsWith("/assets/store/") && c.photo.alt &&
      c.intro.length > 40 && c.intro.length < 300 &&
      !/certif\w*|licen[sc]\w*|accredit\w*|usatf|champion|record|winner|podium|years of|\d+\+?\s*(athletes|years)/i.test(c.intro + " " + c.role)));
  t("coach photos are lazy-loaded below the fold", !/picture\(coach\.photo, \{[^}]*eager/.test(storefrontSrc));
  t("coach card layout stacks to one column on mobile",
    /\.coach-card\s*\{\s*grid-template-columns:\s*1fr/.test(css.slice(css.lastIndexOf("@media (max-width: 640px)"))));
  t("program cards link to /programs/:slug and show only the name",
    /function renderProgramCard/.test(storefrontSrc) &&
    /productHref\(product\.slug\)/.test(storefrontSrc) &&
    !/durationLabel/.test(storefrontSrc.slice(storefrontSrc.indexOf("function renderProgramCard"), storefrontSrc.indexOf("function renderProductCard"))));
  t("catalog page no longer carries program detail sections",
    !/Who it is for|Starting fitness|How it works|Personalization|Filter by collection/.test(
      storefrontSrc.slice(storefrontSrc.indexOf("function renderCatalog"), storefrontSrc.indexOf("function renderProduct("))));
  t("every product has a card image", catalog.products.every(p => p.hero && p.hero.src));
  const cssFlat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleBody = (selector, source = cssFlat) => {
    const m = source.match(new RegExp("(?:^|\\})\\s*" + selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };
  const mobileCss = (cssFlat.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  const tabletCss = (cssFlat.match(/@media \(max-width: 980px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  t("card names display in uppercase",
    /text-transform:\s*uppercase/.test(ruleBody(".program-card h3")));
  t("desktop catalog is a balanced two-column grid",
    /display:\s*grid/.test(ruleBody(".program-grid")) &&
    /grid-template-columns:\s*repeat\(2,/.test(ruleBody(".program-grid")) &&
    /max-width:\s*\d+px/.test(ruleBody(".program-grid")) &&
    !/flex-basis|flex:/.test(ruleBody(".program-card")));
  t("mobile catalog is one card per row",
    /\.program-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(mobileCss));
  t("tablet keeps two columns (no override below 980px)",
    !/\.program-grid/.test(tabletCss));
  t("cards keep the approved design (radius, shadow, overlay, 4:5 ratio)",
    /border-radius:\s*var\(--radius\)/.test(ruleBody(".program-card")) &&
    /box-shadow/.test(ruleBody(".program-card")) &&
    /aspect-ratio:\s*4 \/ 5/.test(ruleBody(".program-card")) &&
    /rgba\(10, 11, 14, 0\.38\)/.test(cssFlat));
  t("related cards no longer show duration or runner meta",
    !/product-meta/.test(storefrontSrc) && !/durationLabel \+/.test(storefrontSrc));
  t("product pages resolve legacy slugs to the canonical URL",
    /catalog\.resolveSlug\(slug\)/.test(storefrontSrc) &&
    /history\.replaceState\(\{ athlevoStore: true \}, "", productHref\(canonical\) \+ \(global\.location\.hash \|\| ""\)\)/.test(storefrontSrc));
  t(".wrap layout selector exists in store.css", /^\.wrap\s*\{[^}]*max\)/m.test(css) || /^\.wrap\s*\{[^}]*var\(--max\)/m.test(css));
  t("store.css has no orphaned declarations outside a rule",
    (() => { let depth = 0, bad = false; const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
      let buf = "";
      for (const ch of src) {
        if (ch === "{") { depth++; buf = ""; }
        else if (ch === "}") { depth--; buf = ""; }
        else if (depth === 0) { buf += ch; }
        if (depth < 0) bad = true;
      }
      return !bad && depth === 0 && buf.trim() === ""; })());
}

section("4c. Shared storefront copy");
{
  // Owner-supplied search copy for /programs (2026-10-22), written for "online running coach in the Philippines".
  const INTRO = "Athlevo Coaching is an online running coach service based in Pampanga and open to runners anywhere in the Philippines. Coach Dean Castro is a USATF Level 1 and STRYD certified coach. Your plan follows your schedule, your recovery and your race goal, from first 5K to marathon. You also learn why each workout is there, so you can train smarter on your own.";
  const META = "Train with an online running coach in the Philippines. USATF Level 1 and STRYD certified. Structured 5K to marathon plans, built around your schedule.";
  const metaMatch = storeHtml.match(/<meta name="description" content="([^"]*)">/);
  t("headline matches the approved copy", catalog.hero.headline === "Online Running Coach in the Philippines");
  t("intro matches the approved copy", catalog.intro === INTRO, catalog.intro);
  t("meta description matches the approved copy", !!metaMatch && metaMatch[1] === META, metaMatch && metaMatch[1]);
  t("unused hero lede (old coach-review claim) is gone", !("lede" in catalog.hero));
  const sharedCopy = [catalog.hero.headline, catalog.intro, metaMatch ? metaMatch[1] : "",
    ...catalog.faqs.flatMap(f => [f.question, f.answer])].join("\n");
  // Louie's bio says he is a "middle to long distance runner" (his own description, not a
  // distance choice for customers), so that one phrase is exempt from the scan.
  const louieBio = catalog.coaches.find(c => c.name === "Louie Agawa").intro;
  // The owner's search copy for /programs names distances on purpose, so the intro paragraph, the
  // hub-only FAQs and the meta description are exempt. Everything else is still scanned.
  const scanBody = bodyOnly
    .replace(/<meta (name|property)="(og:)?description" content="[^"]*">/g, "")
    .replace(/<meta property="og:description" content="[^"]*">/g, "")
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")
    .replace(/<p class="intro-text">[\s\S]*?<\/p>/, "")
    .replace(/<section[^>]*id="faq"[\s\S]*?<\/section>/, "");
  const scanShared = [catalog.hero.headline, ...catalog.faqs.flatMap(f => [f.question, f.answer])].join("\n");
  t("shared copy has no distance choice, race ladder, or former-product wording",
    !/\b(5k|10k|half[- ]marathon|marathon|distances?|choose your|first 5k|faster 5k|ladder)\b/i.test(
      (scanShared + "\n" + scanBody + "\n" + storefrontSrc).split(louieBio).join("")),
    (sharedCopy.match(/\b(5k|10k|half[- ]marathon|marathon|distances?|choose your|ladder)\b/i) || [])[0]);
  t("FAQs keep only the confirmed answers",
    catalog.faqs.map(f => f.question).join("|") === "Can I buy a program today?|Are race times guaranteed?",
    catalog.faqs.map(f => f.question).join("|"));
  t("FAQs make no intake, coach-review, delivery, support, or pricing commitments",
    !/\b(intake|coach\w*|reviews?|reviewed|personaliz\w*|block|check-?ins?|messag\w*|support|respon\w*|within|business days?|refunds?|price|cost|free)\b|\b\d+[- ]?(hours?|days?|weeks?)\b|\b(same|next)[- ]day\b|24\/7/i.test(
      catalog.faqs.map(f => f.answer).join(" ")));
  t("purchasing FAQ matches the disabled purchasing state",
    /Not yet\. Purchasing is not open/.test(catalog.faqs[0].answer) && catalog.purchasingAvailable === false);
}

section("4e. Search copy for /programs (\"online running coach in the Philippines\")");
{
  const ldBlocks = [...storeHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let graph = [];
  try { graph = JSON.parse(ldBlocks[0][1])["@graph"]; } catch (e) { /* asserted below */ }
  const node = (type) => graph.find(n => n["@type"] === type) || {};
  const hubFaqs = catalog.getHubFaqs();
  const productHtml = (slug) => readFileSync("./store-pages/" + slug + ".html", "utf8");
  const titleTag = (storeHtml.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const metaTag = (storeHtml.match(/<meta name="description" content="([^"]*)">/) || [])[1] || "";

  t("the /programs title and meta description are written for the search, within search-result limits",
    titleTag === "Online Running Coach in the Philippines | Athlevo Coaching" && titleTag.length <= 60 &&
    /online running coach in the philippines/i.test(metaTag) && metaTag.length <= 160,
    titleTag.length + "/" + metaTag.length);
  t("/programs carries one JSON-LD block (Organization, Person, FAQPage) and the product pages carry none",
    ldBlocks.length === 1 && graph.map(n => n["@type"]).join(",") === "Organization,Person,FAQPage" &&
    catalog.products.every(p => !/ld\+json/.test(productHtml(p.slug))));
  t("the FAQPage markup is exactly the FAQs the page shows, in the same order",
    (node("FAQPage").mainEntity || []).map(q => q.name + "|" + q.acceptedAnswer.text).join("\n") ===
      hubFaqs.map(f => f.question + "|" + f.answer).join("\n") && hubFaqs.length === 8);
  t("the Person markup is Dean's catalog record: same name, same credentials, nothing added",
    node("Person").name === catalog.coaches[0].name &&
    (node("Person").hasCredential || []).map(c => c.name).join("|") === catalog.coaches[0].certifications.join("|"));
  t("the Organization links only the Facebook page the landing page already links, and the markup has no ratings, reviews, offers or prices",
    (node("Organization").sameAs || []).join(",") === catalog.hub.messageUrl && indexHtml.includes(catalog.hub.messageUrl) &&
    !/aggregateRating|"review"|"offers"|"price"|"priceRange"/.test(ldBlocks[0][1]));
  t("the markup cannot close its script tag: no raw < inside the JSON-LD", !/</.test(ldBlocks[0][1]));
  t("the hub-only FAQs appear on /programs and nowhere else",
    catalog.getHubFaqs().slice(2).every(f => storeHtml.includes(f.question)) &&
    catalog.products.every(p => !productHtml(p.slug).includes("Do you coach runners outside Pampanga?")));
  t("the hub-only answers make no guarantee, refund, price or free-offer promise",
    !/\b(guarantee\w*|refunds?|free|price|cost)\b/i.test(hubFaqs.slice(2).map(f => f.answer).join(" ")) &&
    /don't promise a number or a race time/.test(hubFaqs.find(f => f.question === "How fast will I improve?").answer));
  t("the intro has two calls to action: See the programs (in page) and Message PR to start (the Facebook page, new tab, noopener)",
    (() => {
      const a = storeHtml.match(/<a[^>]*>See the programs<\/a>/);
      const b = storeHtml.match(/<a[^>]*>Message PR to start<\/a>/);
      return !!a && /href="\/programs#programs"/.test(a[0]) && !!b && b[0].includes('href="' + catalog.hub.messageUrl + '"') &&
        /target="_blank"/.test(b[0]) && /rel="noopener noreferrer"/.test(b[0]);
    })());
  const robots = existsSync("./robots.txt") ? readFileSync("./robots.txt", "utf8") : "";
  const programsSitemap = readFileSync("./sitemap-programs.xml", "utf8");
  t("robots.txt lets every crawler in (search and AI) and names both sitemaps; the programs one lists /programs",
    /^User-agent:\s*\*/m.test(robots) && /^Allow:\s*\/\s*$/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
    /^Sitemap:\s*https:\/\/athlevo\.org\/sitemap\.xml\s*$/m.test(robots) &&
    /^Sitemap:\s*https:\/\/programs\.athlevo\.org\/sitemap-programs\.xml\s*$/m.test(robots) &&
    programsSitemap.includes("<loc>https://programs.athlevo.org/programs</loc>"));
}

// ---------------------------------------------------------------------------------------------
// Helpers for the offer-page sections below.
// ---------------------------------------------------------------------------------------------
const offerHtml = (slug) => readFileSync("./store-pages/" + slug + ".html", "utf8");
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const mainOf = (html) => (html.match(/<!-- prerender:main -->([\s\S]*?)<!-- \/prerender:main -->/) || ["", ""])[1];
const SIGN_UP_BUTTON = /<button class="btn btn-red btn-lg" type="button">Sign Up<\/button>/g;
// What the prerendered page of one offer shows, for the per-offer checks.
const prerendered = (slug) => {
  const page = catalog.getProduct(slug).page, html = offerHtml(slug), text = textOf(mainOf(html));
  return {
    page, html, text,
    holdsContent: text.includes(page.price.amount) && page.overview.includes.every(i => text.includes(i)) &&
      page.getStarted.steps.every(i => text.includes(i)) &&
      page.athleteFeedback.items.every(i => text.includes(i.quote) && text.includes(i.name)) &&
      text.includes(page.getStarted.notice) === !page.signUp.open && !text.includes("Purchasing not available"),
    buttons: (html.match(SIGN_UP_BUTTON) || []).length,
    codeBoxes: (html.match(/<input\b[^>]*name="discount-code"[^>]*>/g) || []).length,
    inputs: (html.match(/<input\b/g) || []).length
  };
};

section("4d. Offer pages: what the four offers share");
{
  const offers = catalog.products;
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel) => {
    const m = flat.match(new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };
  const tabletCss = (flat.match(/@media \(max-width: 980px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  const mobileCss = (flat.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  const landingSrc = readFileSync("./js/landingContent.js", "utf8");
  const jsonOf = (o) => JSON.stringify({ ...o.page, athleteFeedback: undefined });

  t("every offer's Sign Up is an in-page link to How to Get Started until its switch is on, not a purchase",
    offers.every(o => o.page.cta.label === "Sign Up" && o.page.cta.target === "how-to-get-started") &&
    /a\.href = "#" \+ data\.cta\.target/.test(storefrontSrc) &&
    /bindAnchor\(a, data\.cta\.target\)/.test(storefrontSrc));
  t("Sign Up scrolls, moves focus, and keeps the header clear",
    /scrollIntoView\(\{ behavior: "auto", block: "start" \}\)/.test(storefrontSrc) &&
    /target\.focus\(\{ preventScroll: true \}\)/.test(storefrontSrc) &&
    /section\.tabIndex = -1/.test(storefrontSrc) &&
    /\.offer-section\s*\{\s*scroll-margin-top:\s*calc\(var\(--nav-h\) \+ 24px\)/.test(flat));
  t("a #hash on a product URL scrolls to its section",
    /hashElement\(global\.location\.hash\)/.test(storefrontSrc));
  t("Sign Up is the prominent red button",
    /background:\s*var\(--red\)/.test(rule(".btn-red")) && /color:\s*var\(--white\)/.test(rule(".btn-red")) &&
    /min-height:\s*5\d+px/.test(rule(".btn-lg")));
  t("photo stays below the sign-up block on tablet and mobile",
    /\.pdp-hero--offer figure\s*\{\s*order:\s*2;/.test(tabletCss) &&
    /\.pdp-hero--offer img\s*\{\s*height:\s*min\(56vh,\s*480px\)/.test(tabletCss));
  t("mobile Sign Up buttons are full width and quotes stack",
    /\.pdp-hero--offer \.btn-lg\s*\{\s*width:\s*100%/.test(mobileCss) &&
    /\.offer-quotes\s*\{\s*grid-template-columns:\s*1fr/.test(mobileCss));
  t("a price with no period would draw no empty period label (no offer needs that today; the guard stays)",
    (storefrontSrc.match(/if \(data\.price\.period\) /g) || []).length === 2);

  const fb = offers[0].page.athleteFeedback;
  t("all four offers show the same approved athlete feedback, labelled 'From Athlevo athletes.' and never attributed to a plan's customers",
    offers.every(o => o.page.athleteFeedback === fb) && fb.label === "From Athlevo athletes." &&
    !/plan (customer|member|client|athlete)/i.test(JSON.stringify(fb)));
  t("every quote, name, and context is verbatim from the approved landing content",
    fb.items.length > 0 && fb.items.every(i => i.source === "js/landingContent.js" &&
      landingSrc.includes('name: "' + i.name + '"') &&
      landingSrc.includes('context: "' + i.context + '"') &&
      landingSrc.includes('quote: "' + i.quote + '"')));
  t("feedback has no star ratings or scores", !/[★⭐]|\d\s*\/\s*5|\bstars?\b/i.test(JSON.stringify(fb)));
  t("the feedback section is omitted when no approved items exist",
    /feedback && feedback\.items && feedback\.items\.length/.test(storefrontSrc));

  t("page data has no discounts, fees, or promotions on any offer",
    offers.every(o => !/\b(discounts?|fees?|free|trial|coupons?|promos?|refunds?)\b|% off/i.test(jsonOf(o))));
  t("no invented delivery timelines, support channels, response times or guarantees on any offer",
    offers.every(o => !/\b(messenger|whatsapp|facebook|email|viber|telegram|within|hours?|business days?|24\/7|reply|replies|respond|guarantee\w*)\b|\bresponse times?\b/i.test(jsonOf(o)) &&
      !/\d+\s*(minutes?|hours?|days?|weeks?)/i.test(jsonOf(o))));
  t("nobody is promised weekly reviews or a fixed schedule",
    offers.every(o => !/weekly|every week|daily|biweekly|fortnight/i.test(JSON.stringify(o.page) + o.name)));
  t("no offer page talks about face-to-face sessions, medical care, or a named platform",
    offers.every(o => !/\b(face-to-face|in-person|gym|medical|physio\w*|trainingpeaks|strava|garmin|google|calendar|spreadsheet)\b/i.test(jsonOf(o))));
  t("coach-support terms stay in internal data, not on the pages",
    offers.every(o => o.coachSupport.status === "pending" && !/coachSupport/.test(jsonOf(o))));
  t("the tiers build on each other: Guided is the plan plus a coach, Coaching includes everything in Guided, VIP everything in Coaching",
    /Athlevo Plan with a coach/.test(catalog.getProduct("athlevo-guided").page.overview.intro) &&
    catalog.getProduct("athlevo-coaching").page.overview.includes[0] === "Everything in Athlevo Guided." &&
    catalog.getProduct("athlevo-vip-coaching").page.overview.includes[0] === "Everything in Athlevo Coaching.");
  t("the old ₱1,998 Athlevo Plan is gone from the catalog: no ₱1,998 price and none of its monthly-review wording",
    !/1,998|monthly review|Basic coach support/.test(JSON.stringify(catalog.products)));

  const order = ['offerSection("overview"', 'offerSection("athlete-feedback"', 'offerSection("plan-pricing"',
    'offerSection("coach"', 'offerSection("how-to-get-started"'].map(k => storefrontSrc.indexOf(k));
  t("sections render in order: overview, feedback, pricing, coach, how to get started",
    order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order.join(","));
  t("offer page collects no payment details: one input, for the discount code only, and no form, textarea or select",
    !/\$\("(form|textarea|select)"|createElement\("(form|textarea|select)"\)/.test(storefrontSrc) &&
    (storefrontSrc.match(/\$\("input"/g) || []).length === 1 &&
    /setAttribute\("name", "discount-code"\)/.test(storefrontSrc) && /setAttribute\("autocomplete", "off"\)/.test(storefrontSrc) &&
    !/cc-|cvv|cvc|card-?number/i.test(storefrontSrc) &&
    (storefrontSrc.match(/\$\("button"/g) || []).length === 4);
  t("other offers still use the shared bare product layout",
    /if \(product\.page\) \{\s*root\.appendChild\(renderOfferPage\(product\)\);\s*return;\s*\}/.test(storefrontSrc) &&
    /function appendFaqAndRelated/.test(storefrontSrc));
}

section("4e. Athlevo Plan page (₱999/month, a 4-week plan)");
{
  const plan = catalog.getProduct("athlevo-plan");
  const page = plan.page, su = page.signUp;
  const pageJson = JSON.stringify({ ...page, athleteFeedback: undefined });
  const pre = prerendered("athlevo-plan");

  t("first screen: title, headline, description, supporting text",
    plan.name === "Athlevo Plan" &&
    page.seoTitle === "Athlevo Plan — A Training Plan Built by a Coach" &&
    page.headline === "A training plan built for you." &&
    page.description === "A personalized 4-week training plan, built by an Athlevo coach around your schedule, fitness level, and goals." &&
    page.supporting === "Month-to-month. No lock-in.");
  t("price is ₱999 a month, month-to-month, and the plan is described as a 4-week plan",
    page.price.amount === "₱999" && page.price.period === "/month" && page.pricing.terms === "Month-to-month, no lock-in." &&
    /4-week/.test(page.overview.intro) && /4-week/.test(page.overview.includes[0]) && /4-week/.test(page.pricing.includes[0]));
  t("what is included is the plan and nothing more",
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "A personalized 4-week training plan, built by an Athlevo coach.",
      "Built around your schedule, your fitness level, and your goals."
    ]) &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Personalized 4-week training plan",
      "Built by an Athlevo coach",
      "Built around your schedule, fitness level, and goals"
    ]));
  t("no coach contact, reviews, adjustments, nutrition, recovery or strength work is promised; Athlevo Guided is named as the step up",
    !/answer your questions|review|adjust|nutrition|recovery|strength|hands-on|priority/i.test(JSON.stringify([
      page.headline, page.description, page.supporting, page.overview.includes, page.pricing.includes, page.getStarted.steps])) &&
    /see Athlevo Guided/.test(page.overview.note));
  t("no coach is named or implied: no coach profile and no Meet the Coach section",
    !("coach" in page) && !/\b(Dean|Castro|Louie|Christian|Francia|founder|head coach)\b/i.test(pageJson) &&
    !/id="coach"|Meet the Coach/.test(pre.html));
  t("sign-up wiring: its own endpoints and reference code, no call to schedule, no discount code box, and the same renewal line as the other offers",
    typeof su.open === "boolean" && su.refCode === "TP" && su.call === false && su.takesCodes === false &&
    su.checkoutEndpoint === "/api/plan-signup/checkout" && su.statusEndpoint === "/api/plan-signup/status" &&
    su.renewal === "There is no automatic renewal. We will remind you when your next payment is due." &&
    page.getStarted.notice === "Registration opening soon");
  t("how to get started: payment, questionnaire, the coach builds the plan, receive it; no call",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "An Athlevo coach builds your personalized 4-week training plan from your answers.",
      "Receive your plan."
    ]) && !/\bcall\b/i.test(page.getStarted.steps.join(" ")));
  t("the prerendered Plan page holds the price (₱999/month), inclusions, steps and quotes, with no coach block",
    pre.holdsContent && /₱999/.test(pre.text) && /\/month/.test(pre.text) && /4-week/.test(pre.text) && !pre.text.includes("Meet the Coach"));
  t("the prerendered Plan page has Sign Up buttons exactly when its switch is on, and never a code box, form field or card input",
    pre.buttons === (su.open ? 2 : 0) && pre.codeBoxes === 0 && pre.inputs === 0 &&
    !/Have a discount code\?/.test(pre.html) && !/<(form|textarea|select)\b/i.test(pre.html) && !/cc-|cvv|cvc|card-?number/i.test(pre.html) &&
    (su.open || !/checkout|paymongo|payment=/i.test(pre.html.replace(/<script[\s\S]*?<\/script>/g, ""))));
}

section("4f. Athlevo Guided page (₱2,997/month)");
{
  const guided = catalog.getProduct("athlevo-guided");
  const page = guided.page, su = page.signUp;
  const pageJson = JSON.stringify({ ...page, athleteFeedback: undefined });
  const pre = prerendered("athlevo-guided");

  t("first screen: title, headline, description, supporting text",
    guided.name === "Athlevo Guided" &&
    page.seoTitle === "Athlevo Guided — Training Plan and a Coach to Ask" &&
    page.headline === "Your plan, and a coach to answer your questions." &&
    page.description === "A personalized running and strength training plan, built by an Athlevo coach, plus a coach to answer your questions." &&
    page.supporting === "Month-to-month. No lock-in.");
  t("price is ₱2,997/month, month-to-month with no lock-in",
    page.price.amount + page.price.period === "₱2,997/month" && page.pricing.terms === "Month-to-month, no lock-in.");
  t("what is included: the plan, running and strength training, and a coach to answer questions",
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "A personalized training plan, built by an Athlevo coach.",
      "Running and strength training.",
      "Built around your schedule, your fitness level, and your goals.",
      "A coach to answer your questions."
    ]) &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Personalized training plan, built by an Athlevo coach",
      "Running and strength training",
      "A coach to answer your questions"
    ]));
  t("Guided promises answers to questions, not reviews: adjustments, nutrition, recovery protocols and a hands-on coach are named as Athlevo Coaching",
    !/review|adjust|nutrition|recovery|hands-on|priority/i.test(JSON.stringify([
      page.headline, page.description, page.supporting, page.overview.includes, page.pricing.includes, page.getStarted.steps])) &&
    /Frequent training adjustments, nutrition, recovery protocols, and a hands-on coach are part of Athlevo Coaching/.test(page.overview.note));
  t("no coach is named or implied: no coach profile and no Meet the Coach section",
    !("coach" in page) && !/\b(Dean|Castro|Louie|Christian|Francia|founder|head coach)\b/i.test(pageJson) &&
    !/id="coach"|Meet the Coach/.test(pre.html));
  t("sign-up wiring: its own endpoints and reference code, a call to schedule, the code box, and the monthly renewal line",
    typeof su.open === "boolean" && su.refCode === "PL" && su.call === true && su.takesCodes !== false &&
    su.checkoutEndpoint === "/api/guided-signup/checkout" && su.statusEndpoint === "/api/guided-signup/status" &&
    su.renewal === "There is no automatic renewal. We will remind you when your next payment is due." &&
    page.getStarted.notice === "Registration opening soon");
  t("how to get started: payment, questionnaire, call, plan and coach contact, follow the plan and ask the coach",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "Schedule a call with the Athlevo team.",
      "Receive your personalized plan and coach contact instructions.",
      "Follow your plan and ask your coach when you have questions."
    ]));
  t("the prerendered Guided page holds the price, inclusions, steps and quotes, and no coach block",
    pre.holdsContent && /\/month/.test(pre.text) && !pre.text.includes("Meet the Coach"));
  t("the prerendered Guided page has Sign Up buttons and the discount code box exactly when its switch is on, and no card field",
    pre.buttons === (su.open ? 2 : 0) && pre.codeBoxes === (su.open ? 2 : 0) && pre.inputs === pre.codeBoxes &&
    pre.html.includes("Have a discount code?") === su.open &&
    !/<(form|textarea|select)\b/i.test(pre.html) && !/cc-|cvv|cvc|card-?number/i.test(pre.html) &&
    (su.open || !/checkout|paymongo|payment=/i.test(pre.html.replace(/<script[\s\S]*?<\/script>/g, ""))));
}

section("4g. Athlevo Coaching page (₱4,998/month)");
{
  const coaching = catalog.getProduct("athlevo-coaching");
  const page = coaching.page, su = page.signUp;
  const pageJson = JSON.stringify({ ...page, athleteFeedback: undefined });
  const pre = prerendered("athlevo-coaching");

  t("first screen: title, headline, description, supporting text",
    coaching.name === "Athlevo Coaching" &&
    page.seoTitle === "Athlevo Coaching — Online Running and Strength Coaching" &&
    page.headline === "A hands-on coach for your training, nutrition, and recovery." &&
    page.description === "Everything in Athlevo Guided, plus frequent training adjustments, nutrition, recovery protocols, and a hands-on coach." &&
    page.supporting === "Month-to-month. No lock-in.");
  t("price is ₱4,998/month, month-to-month with no lock-in",
    page.price.amount + page.price.period === "₱4,998/month" && page.pricing.terms === "Month-to-month, no lock-in.");
  t("what is included: everything in Guided, frequent adjustments, running, strength, nutrition, recovery protocols and a hands-on coach",
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "Everything in Athlevo Guided.",
      "Frequent training adjustments, based on how your training is going.",
      "Running and strength training.",
      "Nutrition.",
      "Recovery protocols.",
      "A hands-on coach."
    ]) &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Everything in Athlevo Guided",
      "Frequent training adjustments",
      "Running, strength, nutrition, and recovery protocols",
      "A hands-on coach"
    ]));
  t("adjustments are described as frequent and based on training, never as weekly",
    /Frequent training adjustments/.test(page.overview.includes[1]) && /how your training is going/.test(page.overview.includes[1]) &&
    !/weekly|every week/i.test(JSON.stringify(page)));
  t("no coach is named or implied: no coach profile and no Meet the Coach section; Dean and priority responses belong to VIP",
    !("coach" in page) && !/\b(Dean|Castro|Louie|Christian|Francia|founder|head coach)\b/i.test(pageJson) &&
    !/priority/i.test(pageJson) && !/id="coach"|Meet the Coach/.test(pre.html));
  t("sign-up wiring: its own endpoints and reference code, a call to schedule, the code box, and the monthly renewal line",
    typeof su.open === "boolean" && su.refCode === "CO" && su.call === true && su.takesCodes !== false &&
    su.checkoutEndpoint === "/api/coaching-signup/checkout" && su.statusEndpoint === "/api/coaching-signup/status" &&
    su.renewal === "There is no automatic renewal. We will remind you when your next payment is due." &&
    page.getStarted.notice === "Registration opening soon");
  t("how to get started: payment, questionnaire, onboarding call, plan, frequent adjustments from the coach",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "Schedule your onboarding call.",
      "Receive your personalized training plan.",
      "Train with frequent adjustments from your hands-on coach."
    ]));
  t("the prerendered Coaching page holds the price, inclusions, steps and quotes, and no coach block",
    pre.holdsContent && /\/month/.test(pre.text) && !pre.text.includes("Meet the Coach"));
  t("the prerendered Coaching page has Sign Up buttons and the discount code box exactly when its switch is on, and no card field",
    pre.buttons === (su.open ? 2 : 0) && pre.codeBoxes === (su.open ? 2 : 0) && pre.inputs === pre.codeBoxes &&
    pre.html.includes("Have a discount code?") === su.open &&
    !/<(form|textarea|select)\b/i.test(pre.html) && !/cc-|cvv|cvc|card-?number/i.test(pre.html) &&
    (su.open || !/checkout|paymongo|payment=/i.test(pre.html.replace(/<script[\s\S]*?<\/script>/g, ""))));
}

section("4h. Athlevo VIP Coaching page (₱7,998/month)");
{
  const vip = catalog.getProduct("athlevo-vip-coaching");
  const page = vip.page, su = page.signUp;
  const pre = prerendered("athlevo-vip-coaching");

  t("first screen: title, headline, description, supporting text",
    vip.name === "Athlevo VIP Coaching" &&
    page.seoTitle === "Athlevo VIP Coaching — Online Coaching with Dean Castro" &&
    page.headline === "Coached directly by Dean, with priority responses." &&
    page.description === "Everything in Athlevo Coaching, with Head Coach Dean Castro as your coach and priority responses." &&
    page.supporting === "Month-to-month. No lock-in.");
  t("price is ₱7,998/month, month-to-month with no lock-in",
    page.price.amount + page.price.period === "₱7,998/month" && page.pricing.terms === "Month-to-month, no lock-in.");
  t("what is included: everything in Coaching, Dean as your coach, priority responses",
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "Everything in Athlevo Coaching.",
      "Dean Castro, Head Coach of Athlevo, as your coach.",
      "Priority responses."
    ]) &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Everything in Athlevo Coaching",
      "Dean Castro as your coach",
      "Priority responses"
    ]));
  t("coach: Dean's catalog record, with an existing optimized photo",
    page.coach === catalog.coaches[0] &&
    page.coach.name === "Dean Vincent Castro" &&
    page.coach.role === "Founder & Head Coach, Athlevo" &&
    page.coach.photo.src === "/assets/store/founder-920.webp" &&
    page.coach.photo.original === "/assets/landing/dean-castro-coach.jpg" &&
    existsSync("." + page.coach.photo.original) &&
    page.coach.photo.webp.length === 2 && page.coach.photo.avif.length === 2);
  t("coach intro invents no credentials and does not promise Dean coaches every customer",
    /structured running and strength training/.test(page.coach.intro) &&
    !/\b(certif\w*|usatf|licen[sc]\w*|degree|champion\w*|records?|awards?|years|olympi\w*|podium|winner|won)\b/i.test(page.coach.intro) &&
    !/personally|every (plan )?(customer|athlete|client|member)|each (customer|athlete|client)/i.test(page.coach.intro));
  t("sign-up wiring: its own endpoints and reference code, a call to schedule, no code box, and the monthly renewal line",
    typeof su.open === "boolean" && su.refCode === "EL" && su.call === true && su.takesCodes === false &&
    su.checkoutEndpoint === "/api/vip-signup/checkout" && su.statusEndpoint === "/api/vip-signup/status" &&
    su.renewal === "There is no automatic renewal. We will remind you when your next payment is due." &&
    page.getStarted.notice === "Registration opening soon");
  t("how to get started: payment, questionnaire, onboarding call, plan, train with Dean with priority responses",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "Schedule your onboarding call.",
      "Receive your personalized training plan.",
      "Train with Dean as your coach, with priority responses."
    ]));
  t("the prerendered VIP page holds the price, inclusions, steps and quotes, and Dean's Meet the Coach block with his credentials",
    pre.holdsContent && /\/month/.test(pre.text) && pre.text.includes("Meet the Coach") && pre.text.includes("Dean Vincent Castro") &&
    catalog.coaches[0].certifications.every(x => pre.html.includes("<li>" + x + "</li>")));
  t("the prerendered VIP page has Sign Up buttons exactly when its switch is on, never a code box, and no other offer's price",
    pre.buttons === (su.open ? 2 : 0) && pre.codeBoxes === 0 && pre.inputs === 0 && !/Have a discount code\?/.test(pre.html) &&
    !/₱999|₱2,997|₱4,998/.test(pre.text) && !/<(form|textarea|select)\b/i.test(pre.html) && !/cc-|cvv|cvc|card-?number/i.test(pre.html));
}

section("5. Client routing");
{
  t("storefront reads /programs and /programs/:slug, and still accepts the old /store paths",
    storefrontSrc.includes('var BASE = "/programs"') &&
    storefrontSrc.includes('path === BASE || path === "/store"') &&
    /\^\\\/\(\?:programs\|store\)\\\/\(\[\^\/\]\+\)\$/.test(storefrontSrc) &&
    storefrontSrc.includes('(FLAT ? "" : BASE) + "/" + encodeURIComponent(slug)'));
  t("on programs.athlevo.org an offer is /<slug> (FLAT), everywhere else /programs/<slug>",
    storefrontSrc.includes("var FLAT = !!(global.location && global.location.hostname === catalog.programsHost)") &&
    storefrontSrc.includes('(FLAT && path === "/")') &&
    storefrontSrc.includes("if (!match && FLAT) match = path.match(/^\\/([^/]+)$/)") &&
    catalog.programsHost === "programs.athlevo.org" && catalog.productPath("athlevo-plan", "programs.athlevo.org") === "/athlevo-plan" &&
    catalog.productPath("athlevo-plan", "athlevo.org") === "/programs/athlevo-plan");
  t("a stale /store address is rewritten to /programs in the address bar, keeping the query and hash",
    /function canonicalizeLegacyPath\(\)/.test(storefrontSrc) &&
    /history\.replaceState\(\{ athlevoStore: true \}, "", target \+ \(loc\.search \|\| ""\) \+ \(loc\.hash \|\| ""\)\)/.test(storefrontSrc) &&
    /if \(legacy\) target = BASE \+/.test(storefrontSrc) &&
    storefrontSrc.indexOf("canonicalizeLegacyPath();") > storefrontSrc.indexOf("function renderView()"));
  t("no link in the storefront still points at /store",
    !/["'`]\/store(["'`#/])/.test(storefrontSrc.replace(/path === "\/store"|\^\\\/store/g, "")) &&
    !/href="\/store[#/"]/.test(storeHtml));
  t("history API is used for in-store navigation",
    /history\.pushState/.test(storefrontSrc) && /popstate/.test(storefrontSrc));
}

section("6. App shell and service worker isolation");
{
  t("initializeAthlevoApp still treats /ai and root as Coach entry",
    /aiPath === "\/ai" \|\| aiPath === "" \|\| aiPath === "\/signup" \|\| aiPath === "\/ai-signup"/.test(indexHtml));
  t("store navigations are not written into the app-shell cache",
    /isAppShellNav/.test(sw) &&
    /\/\(programs\|store\|landing-preview\)/.test(sw));
  t("storefront uses the site's Fraunces display type and the Athlevo red accent",
    /family=Fraunces:opsz,wght@9\.\.144,400;9\.\.144,500;9\.\.144,600/.test(storeHtml) &&
    /--display:\s*"Fraunces", Georgia/.test(css) && /--red: #c0272d/.test(css));
  t("typography is consistent: one serif for headings, the system sans for body, nothing else",
    !/Space[ +]Grotesk/.test(storeHtml + css) &&
    (css.match(/font-family:\s*[^;]+;/g) || []).every(d => /^font-family:\s*var\(--(display|wordmark|sans)\);$/.test(d)) &&
    /--wordmark:\s*var\(--display\)/.test(css) &&
    /body\s*\{[^}]*font-family:\s*var\(--sans\)/.test(css));
  t("every heading and name uses the display serif at weight 500 or 600 (no bold sans-style 700)",
    [".intro h1", ".section-title", ".pdp h1", ".offer-section > h2", ".coach-card-name", ".offer-coach-name", ".wordmark"]
      .every(sel => {
        const m = css.match(new RegExp(sel.replace(/[.>]/g, c => "\\" + c).replace(/ /g, "\\s*") + "\\s*\\{([^}]*)\\}"));
        return m && /font-family:\s*var\(--(display|wordmark)\)/.test(m[1]) && /font-weight:\s*(500|600)\b/.test(m[1]);
      }) &&
    !/(var\(--display\)|var\(--wordmark\))[^}]*font-weight:\s*700|font-weight:\s*700[^}]*(var\(--display\)|var\(--wordmark\))/.test(css));
  t("scroll reveal is an enhancement: needs IntersectionObserver, skips reduced motion, never touches the first screen",
    /typeof global\.IntersectionObserver !== "function" \|\| prefersReducedMotion\(\)/.test(storefrontSrc) &&
    /prefers-reduced-motion: reduce/.test(storefrontSrc.slice(storefrontSrc.indexOf("function prefersReducedMotion"))) &&
    /getBoundingClientRect\(\)\.top < fold\) return/.test(storefrontSrc) &&
    !/REVEAL_SELECTOR = \[[^\]]*\.(intro|hero)\b/.test(storefrontSrc) &&
    /function render\(\) \{\s*renderView\(\);\s*setupReveal\(\);\s*\}/.test(storefrontSrc));
  t("blocks the reader jumped past are shown in place, and the scroll listener is replaced on every redraw",
    /getBoundingClientRect\(\)\.bottom > 0\) return true/.test(storefrontSrc) &&
    /addEventListener\("scroll", revealScrollHandler, \{ passive: true \}\)/.test(storefrontSrc) &&
    /removeEventListener\("scroll", revealScrollHandler\)/.test(storefrontSrc) &&
    /revealObserver\.disconnect\(\)/.test(storefrontSrc));
  t("hidden states exist only for attributes the script adds; reduced motion and print show everything",
    /\[data-reveal="pending"\]\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(14px\);/.test(css) &&
    /img\[data-img="loading"\]\s*\{\s*opacity:\s*0;/.test(css) &&
    /@media \(prefers-reduced-motion: reduce\), print \{[\s\S]*\[data-reveal="pending"\]\s*\{\s*opacity:\s*1;\s*transform:\s*none;/.test(css) &&
    !/data-reveal|data-img/.test(storeHtml) &&
    ![".program-card", ".coach-card", ".offer-section", ".section-title", ".faq"].some(sel => new RegExp("\\" + sel + "\\s*\\{[^}]*opacity:\\s*0").test(css)));
  t("hero intro text uses the body font at 18-22px and the headline at 38-64px, in the same section",
    /\.intro h1\s*\{[^}]*font-size:\s*clamp\(38px, 6vw, 64px\)/.test(css) &&
    /\.intro-text\s*\{[^}]*font-size:\s*clamp\(18px, 2\.2vw, 22px\)/.test(css) &&
    !/\.intro-text\s*\{[^}]*font-family/.test(css));
}

section("7. Responsive storefront images");
{
  const heroWebp = statSync("./assets/store/stretch-1080.webp").size;
  t("catalog photos keep original sources on disk",
    existsSync("./assets/landing/store-hero-stretch.jpg") &&
    existsSync("./assets/landing/hero-athlevo.png") &&
    existsSync("./assets/landing/dean-founder.png") &&
    existsSync("./assets/landing/dean-castro-coach.jpg"));
  t("catalog hero is the stretch photo with 640w and 1080w WebP and AVIF files on disk",
    catalog.hero.image.original === "/assets/landing/store-hero-stretch.jpg" &&
    catalog.hero.image.width === 1080 && catalog.hero.image.height === 1616 &&
    catalog.hero.image.alt.length > 20 &&
    ["640", "1080"].every(w => ["webp", "avif"].every(ext => existsSync("./assets/store/stretch-" + w + "." + ext))));
  t("Christian Francia's coach photo is cropped, optimized, and the original is kept",
    catalog.coaches[1].photo.original === "/assets/landing/christian-francia-coach.jpg" &&
    existsSync("./assets/landing/christian-francia-coach.jpg") &&
    catalog.coaches[1].photo.width === 880 && catalog.coaches[1].photo.height === 1100 &&
    ["640", "880"].every(w => ["webp", "avif"].every(ext => existsSync("./assets/store/christian-" + w + "." + ext))));
  const hybridWebp = statSync("./assets/store/hybrid-1023.webp").size;
  const hybrid = catalog.getProduct("athlevo-guided").hero;
  t("Athlevo Guided uses the supplied athlete photo, cropped 4:5, with the original kept",
    hybrid.original === "/assets/landing/hybrid-programming-athlete.png" &&
    existsSync("./assets/landing/hybrid-programming-athlete.png") &&
    hybrid.width === 1023 && hybrid.height === 1279 &&
    ["640", "1023"].every(w => ["webp", "avif"].every(ext => existsSync("./assets/store/hybrid-" + w + "." + ext))));
  t("No offer card uses the founder photo, which stays on Dean's coach card only",
    hybrid.src !== catalog.coaches[0].photo.src &&
    catalog.coaches[0].photo.src === "/assets/store/founder-920.webp" &&
    catalog.products.filter(p => p.hero.src === catalog.coaches[0].photo.src).length === 0);
  t("Guided photo alt text describes the scene without naming a person or race number",
    hybrid.alt.length > 20 && !/dean|castro|founder|christian|francia|\d{4,}/i.test(hybrid.alt));
  t("Guided photo has a top-anchored focus so the head stays in the square mobile card",
    hybrid.focus === "50% 0%" &&
    /if \(photo\.focus\) node\.style\.objectPosition = photo\.focus/.test(storefrontSrc) &&
    catalog.products.filter(p => p.hero.focus).length === 1);
  t("Guided WebP is under 500KB", hybridWebp < 500 * 1024, String(hybridWebp));
  t("hero crop keeps the shirt lettering and hands in the wide banner",
    /\.hero img\s*\{[^}]*object-position:\s*center 16%/.test(css));
  t("derived store photos are WebP/AVIF under assets/store",
    catalog.hero.image.src.startsWith("/assets/store/") &&
    catalog.hero.image.webp.length === 2 &&
    catalog.hero.image.avif.length === 2);
  t("desktop hero WebP is under 500KB", heroWebp < 500 * 1024, String(heroWebp));
  t("storefront renders picture/srcset with reserved width and height",
    /createElement\("picture"\)/.test(storefrontSrc) &&
    /srcset/.test(storefrontSrc) &&
    /node\.width = photo\.width/.test(storefrontSrc));
  t("catalog hero is eager and not lazy-loaded",
    /eager:\s*true,\s*sizes:\s*SIZES\.hero/.test(storefrontSrc) &&
    storefrontSrc.indexOf("picture(catalog.hero.image, { eager: true") >= 0);
  t("below-the-fold catalog photos use lazy loading",
    /picture\(product\.hero, \{ sizes: SIZES\.card \}\)/.test(storefrontSrc) &&
    !/picture\(product\.hero, \{ sizes: SIZES\.card[^)]*eager/.test(storefrontSrc));
}

section("8. Crawler-readable pages");
{
  const stale = staleFiles();
  t("generated store pages and sitemap are up to date (fix: node scripts/build-store-pages.mjs)",
    stale.length === 0, stale.join(", "));

  const read = (p) => readFileSync("./" + p, "utf8");
  const pages = [{ slug: null, file: "store.html" }]
    .concat(catalog.products.map(p => ({ slug: p.slug, file: "store-pages/" + p.slug + ".html" })))
    .map(r => ({ ...r, meta: catalog.seo(r.slug), html: read(r.file) }));
  const bySlug = (slug) => pages.find(p => p.slug === slug);
  const unescapeHtml = (x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const tag = (html, re) => { const m = html.match(re); return m ? unescapeHtml(m[1]) : null; };
  const visible = (html) => unescapeHtml(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " "));

  t("each route has its own metadata in the catalog, and unknown routes have none",
    pages.length === 5 && pages.every(p => p.meta && p.meta.url === "https://programs.athlevo.org" + (p.slug ? "/" + p.slug : "/programs")) &&
    catalog.seo("not-a-program") === null);
  t("no prerendered page links to, or names as canonical, an old /store address",
    pages.every(p => !/(href|content)="(https:\/\/athlevo\.org)?\/store(["#/])/.test(p.html)));
  t("every page carries its own title, description and canonical in the static HTML",
    pages.every(p => tag(p.html, /<title>([^<]*)<\/title>/) === p.meta.title &&
      tag(p.html, /<meta name="description" content="([^"]*)">/) === p.meta.description &&
      tag(p.html, /<link rel="canonical" href="([^"]*)">/) === p.meta.url &&
      tag(p.html, /<meta property="og:url" content="([^"]*)">/) === p.meta.url &&
      tag(p.html, /<meta property="og:title" content="([^"]*)">/) === p.meta.title));
  t("titles, descriptions and canonicals are unique across pages",
    ["title", "description", "url"].every(k => new Set(pages.map(p => p.meta[k])).size === pages.length));
  t("titles fit in search results (≤ 65 chars) and descriptions in snippets (≤ 160 chars)",
    pages.every(p => p.meta.title.length <= 65 && p.meta.description.length <= 160),
    pages.map(p => p.meta.title.length + "/" + p.meta.description.length).join(" "));
  t("the shared catalog description is the approved text",
    catalog.seo(null).description === "Train with an online running coach in the Philippines. USATF Level 1 and STRYD certified. Structured 5K to marathon plans, built around your schedule.");
  t("no page is marked noindex",
    pages.every(p => !/noindex/i.test(p.html)));
  t("every page has exactly one h1 and it names the page",
    pages.every(p => (p.html.match(/<h1[ >]/g) || []).length === 1) &&
    /<h1>Online Running Coach in the Philippines<\/h1>/.test(bySlug(null).html) &&
    catalog.products.every(p => new RegExp("<h1>" + p.name + "</h1>").test(bySlug(p.slug).html)));

  const home = visible(bySlug(null).html);
  t("/programs text is in the HTML: headline, intro, programs, coaches and FAQs",
    home.includes(catalog.hero.headline) && home.includes(catalog.intro) &&
    catalog.products.every(p => home.includes(p.name) && bySlug(null).html.includes('href="/' + p.slug + '"')) &&
    catalog.coaches.every(c => home.includes(c.name) && home.includes(c.role)) &&
    home.includes("Meet the coaches") &&
    catalog.getHubFaqs().every(f => home.includes(f.question) && home.includes(f.answer)));
  t("every coach's certifications are in the /programs HTML exactly as supplied, with the supplied role lines",
    catalog.coaches.every(c => c.certifications.every(x => bySlug(null).html.includes("<li>" + x + "</li>"))) &&
    catalog.coaches.every(c => home.includes(c.role)) &&
    home.includes("Strength & Conditioning Coach, Assistant Running Coach, Athlevo") &&
    home.includes("Running Coach, Athlevo"));
  t("the VIP page's Meet the Coach block shows Dean's credentials; the Plan, Guided and Coaching pages name no coach",
    catalog.coaches[0].certifications.every(x => bySlug("athlevo-vip-coaching").html.includes("<li>" + x + "</li>")) &&
    /<p class="coach-card-creds-label">Credentials<\/p>/.test(bySlug("athlevo-vip-coaching").html) &&
    ["athlevo-plan", "athlevo-guided", "athlevo-coaching"].every(slug => !/id="coach"|USATF|STRYD/.test(bySlug(slug).html)));

  t("every offer's text is in the HTML: price, what is included, athlete quotes and how to get started (opening-soon notice only while closed)",
    catalog.products.every(o => {
      const v = visible(bySlug(o.slug).html), d = o.page;
      return v.includes(d.price.amount) && (!d.price.period || v.includes(d.price.period)) &&
        v.includes(d.getStarted.notice) === !d.signUp.open &&
        d.overview.includes.every(i => v.includes(i)) && d.getStarted.steps.every(i => v.includes(i)) &&
        d.athleteFeedback.items.every(i => v.includes(i.quote) && v.includes(i.name)) &&
        !v.includes("Purchasing not available");
    }));
  t("the VIP page names Dean as the coach and the other three name no one",
    visible(bySlug("athlevo-vip-coaching").html).includes(catalog.getProduct("athlevo-vip-coaching").page.coach.name) &&
    ["athlevo-plan", "athlevo-guided", "athlevo-coaching"].every(slug => !visible(bySlug(slug).html).includes("Dean Vincent Castro")));
  t("the dropped and renamed pages are gone: no Hybrid Programming or Elite Coaching page or rewrite",
    !existsSync("./store-pages/hybrid-programming.html") && !existsSync("./store-pages/elite-coaching.html") &&
    !existsSync("./hybrid-programming.html") && !existsSync("./elite-coaching.html") &&
    !vercel.rewrites.some(r => /hybrid-programming|elite-coaching/.test(r.source + r.destination)));

  t("pages load only the two storefront scripts, and contain no form fields beyond the discount code box",
    pages.every(p => {
      const srcs = [...p.html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
      const inputs = p.html.match(/<input\b[^>]*>/g) || [];
      return srcs.join(",") === "/js/storeCatalog.js,/js/storefront.js" && (p.html.match(/<script(?![^>]*application\/ld\+json)/g) || []).length === 2 &&
        !/<(form|textarea|select)\b/i.test(p.html) && inputs.every(i => /name="discount-code"/.test(i));
    }));
  t("only the /programs page marks Programs as the current nav item",
    pages.every(p => /aria-current="page"/.test(p.html) === (p.slug === null)));
  t("each page keeps the markers the build script needs",
    pages.every(p => /<!-- prerender:head -->[\s\S]*<!-- \/prerender:head -->/.test(p.html) &&
      /<!-- prerender:notice -->[\s\S]*<!-- \/prerender:notice -->/.test(p.html) &&
      /<!-- prerender:main -->[\s\S]*<!-- \/prerender:main -->/.test(p.html)));

  const rewrites = vercel.rewrites.map(r => r.source);
  t("each offer is rewritten to its own prerendered page, ahead of the generic /programs/:slug rule",
    catalog.products.every(p => {
      const i = vercel.rewrites.findIndex(r => r.source === "/programs/" + p.slug);
      return i > -1 && vercel.rewrites[i].destination === "/store-pages/" + p.slug + ".html" &&
        i < rewrites.indexOf("/programs/:slug") && existsSync("./store-pages/" + p.slug + ".html");
    }));
  const legacy = Object.entries(catalog.legacySlugs);
  const storeEra = ["first-5k", "faster-5k", "marathon", "half-marathon"]; // the addresses that were ever under /store
  t("pre-rename /store offer URLs redirect permanently, in one hop, to the new /programs page; Hybrid Programming's old address goes to the hub; First 10K has none",
    legacy.length === 4 && legacy.every(([, to]) => catalog.getProduct(to)) &&
    ["first-5k", "faster-5k", "marathon"].every(from => vercel.redirects.some(r => r.source === "/store/" + from &&
      r.destination === "/programs/" + catalog.legacySlugs[from] && r.permanent === true)) &&
    vercel.redirects.some(r => r.source === "/store/half-marathon" && r.destination === "/programs" && r.permanent === true) &&
    !vercel.redirects.some(r => r.source === "/store/first-10k"));
  const retired = (source) => vercel.redirects.find(r => r.source === source);
  const hostCatchAll = vercel.redirects.findIndex(r => r.destination === "https://athlevo.org/:path");
  const apexSlug = vercel.redirects.findIndex(r => r.source === "/programs/:slug" && (r.has || []).length === 1);
  t("the retired addresses redirect on every host, ahead of every rule that could catch them: Elite Coaching goes permanently to Athlevo VIP Coaching, Hybrid Programming goes to the hub",
    [["/elite-coaching", "https://programs.athlevo.org/athlevo-vip-coaching", true],
     ["/programs/elite-coaching", "https://programs.athlevo.org/athlevo-vip-coaching", true],
     ["/hybrid-programming", "https://programs.athlevo.org/programs", false],
     ["/programs/hybrid-programming", "https://programs.athlevo.org/programs", false]]
      .every(([source, destination, permanent]) => {
        const r = retired(source);
        const at = vercel.redirects.indexOf(r);
        return !!r && r.destination === destination && r.permanent === permanent && !r.has && !r.missing &&
          at < hostCatchAll && at < apexSlug && at < vercel.redirects.findIndex(x => x.source === "/store/:slug");
      }) &&
    hostCatchAll > -1 && apexSlug > -1);
  const redirectSources = vercel.redirects.map(r => r.source);
  const SHORT = catalog.products.map(p => p.slug);
  t("short links (athlevo.org/athlevo-plan and the other three) redirect, temporarily and in one hop, to the offer page on programs.athlevo.org; other hosts (previews) go to /programs/<slug>",
    SHORT.every(slug => catalog.getProduct(slug) &&
      vercel.redirects.filter(r => r.source === "/" + slug).length === 2 &&
      vercel.redirects.some(r => r.source === "/" + slug && r.destination === "https://programs.athlevo.org/" + slug && r.permanent === false &&
        r.has.length === 1 && r.has[0].value === "athlevo.org" && r.missing.length === 1 && r.missing[0].value === "programs.athlevo.org") &&
      vercel.redirects.some(r => r.source === "/" + slug && r.destination === "/programs/" + slug && r.permanent === false) &&
      vercel.rewrites.some(r => r.source === "/programs/" + slug)));
  t("short links collide with nothing: no rewrite (except the programs.athlevo.org page itself), root file or folder uses those paths",
    SHORT.every(slug => !vercel.rewrites.some(r => (r.source === "/" + slug || r.source === "/" + slug + "/:path*") &&
        !(r.has && r.has.length === 1 && r.has[0].type === "host" && r.has[0].value === "programs.athlevo.org")) &&
      !existsSync("./" + slug) && !existsSync("./" + slug + ".html")));
  t("the local preview server mirrors the short links and keeps the query string (a ?code= link survives)",
    /const SHORT_LINKS = new Set\(\["athlevo-plan", "athlevo-guided", "athlevo-coaching", "athlevo-vip-coaching"\]\)/.test(readFileSync("./scripts/serve-web.mjs", "utf8")) &&
    /res\.writeHead\(307, \{ location: shortLink \+ url\.search \}\)/.test(readFileSync("./scripts/serve-web.mjs", "utf8")));
  t("the old /store and /store/:slug paths redirect permanently to /programs, after the specific legacy-slug rules",
    vercel.redirects.some(r => r.source === "/store" && r.destination === "/programs" && r.permanent === true) &&
    vercel.redirects.some(r => r.source === "/store/:slug" && r.destination === "/programs/:slug" && r.permanent === true) &&
    storeEra.every(from => redirectSources.indexOf("/store/" + from) > -1 && redirectSources.indexOf("/store/" + from) < redirectSources.indexOf("/store/:slug")) &&
    vercel.redirects.filter(r => r.source.startsWith("/store")).every(r => r.permanent === true && r.destination.startsWith("/programs")));

  const sitemap = read("sitemap.xml");
  const programsSitemap = read("sitemap-programs.xml");
  const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  t("the app's sitemap lists only the home page on athlevo.org",
    locsOf(sitemap).join("|") === "https://athlevo.org/" &&
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(sitemap) && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap));
  t("the programs sitemap lists /programs and each offer on programs.athlevo.org (offers flat), and no old /store or athlevo.org URLs",
    locsOf(programsSitemap).join("|") === ["https://programs.athlevo.org/programs"].concat(catalog.products.map(p => "https://programs.athlevo.org/" + p.slug)).join("|") &&
    !/store/.test(programsSitemap) && !/\/\/athlevo\.org/.test(programsSitemap) &&
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(programsSitemap) && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(programsSitemap));
  const robots = read("robots.txt");
  t("robots.txt allows crawling and points to both sitemaps",
    /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
    /^Sitemap: https:\/\/athlevo\.org\/sitemap\.xml$/m.test(robots) &&
    /^Sitemap: https:\/\/programs\.athlevo\.org\/sitemap-programs\.xml$/m.test(robots));

  t("the browser keeps title, description, canonical and share tags in step with the route",
    /catalog\.seo\(\)/.test(storefrontSrc) && /catalog\.seo\(product\.slug\)/.test(storefrontSrc) &&
    /meta\[name="description"\]/.test(storefrontSrc) && /link\[rel="canonical"\]/.test(storefrontSrc) &&
    /meta\[property="og:url"\]/.test(storefrontSrc));
  const serveSrc = readFileSync("./scripts/serve-web.mjs", "utf8");
  t("the local preview server serves the same per-offer pages and mirrors the /store redirects",
    /store-pages/.test(serveSrc) && /\.xml/.test(serveSrc) &&
    /pathname === "\/programs"/.test(serveSrc) && /function redirectFor/.test(serveSrc) && /res\.writeHead\(308/.test(serveSrc));
}

section("10. Sign-up on the four offers (client)");
{
  const offers = catalog.products;
  const signUps = offers.map(o => o.page.signUp);
  const { DEFAULT_PAYMONGO_PAYMENT_METHODS } = await import("../lib/server/paymongoClient.js");
  const srv = await import("../lib/server/planSignup.js");
  const { SIGNUP_REFERENCE_PATTERN } = srv;
  const SERVER = {
    "athlevo-plan": { product: srv.ATHLEVO_PLAN_PRODUCT, path: srv.PLAN_PAGE_PATH, ref: srv.newPlanReference, steps: srv.planNextSteps, key: "plan" },
    "athlevo-guided": { product: srv.ATHLEVO_GUIDED_PRODUCT, path: srv.GUIDED_PAGE_PATH, ref: srv.newGuidedReference, steps: srv.guidedNextSteps, key: "guided" },
    "athlevo-coaching": { product: srv.ATHLEVO_COACHING_PRODUCT, path: srv.COACHING_PAGE_PATH, ref: srv.newCoachingReference, steps: srv.coachingNextSteps, key: "coaching" },
    "athlevo-vip-coaching": { product: srv.ATHLEVO_VIP_PRODUCT, path: srv.VIP_PAGE_PATH, ref: srv.newVipReference, steps: srv.vipNextSteps, key: "vip" }
  };
  const monthly = offers.filter(o => o.slug !== "athlevo-plan").map(o => o.page.signUp);

  t("each offer has a boolean sign-up switch, and the store-wide purchasing flag stays false (offers open one by one)",
    signUps.every(su => typeof su.open === "boolean") && catalog.purchasingAvailable === false);
  t("all four offers have a sign-up object, in the order they are sold",
    offers.filter(p => p.page && p.page.signUp).map(p => p.slug).join(",") === "athlevo-plan,athlevo-guided,athlevo-coaching,athlevo-vip-coaching");
  const anyOpen = signUps.some(su => su.open);
  t("the store notice and FAQ agree with the switches (the banner is written by the build)",
    anyOpen === !/Purchasing is not yet available/.test(storeHtml) &&
    storeHtml.includes('<div class="notice">' + catalog.notice() + "</div>") &&
    storeHtml.includes(catalog.getFaqs()[0].answer) &&
    (anyOpen ? !/Not yet\. Purchasing is not open/.test(catalog.getFaqs()[0].answer) : catalog.getFaqs()[0].answer === catalog.faqs[0].answer));
  t("the page endpoints are the rewrites the server answers, one distinct pair per offer",
    offers.every(o => {
      const su = o.page.signUp, key = SERVER[o.slug].key;
      const rewriteTo = (src) => (vercel.rewrites.find(r => r.source === src) || {}).destination;
      return rewriteTo(su.checkoutEndpoint) === "/api/providers?action=" + key + "_signup_checkout" &&
        rewriteTo(su.statusEndpoint) === "/api/providers?action=" + key + "_signup_status";
    }) &&
    new Set(signUps.map(su => su.checkoutEndpoint)).size === 4 && new Set(signUps.map(su => su.statusEndpoint)).size === 4);
  t("payment copy names exactly the methods the server offers, and never GCash",
    (() => {
      const label = { qrph: "QRPh", grab_pay: "GrabPay", maya: "Maya" };
      return signUps.every(su =>
        DEFAULT_PAYMONGO_PAYMENT_METHODS.every(m => label[m] && su.payment.includes(label[m])) &&
        DEFAULT_PAYMONGO_PAYMENT_METHODS.length === 3 && !/gcash/i.test(su.payment));
    })());
  t("all four offers say there is no automatic renewal and promise a reminder",
    signUps.every(su => /no automatic renewal/.test(su.renewal) && /remind you/.test(su.renewal)));
  t("the no-refund line is the agreement's Section 6 wording, shown before payment, on all four",
    signUps.every(su => su.terms === "All payments to Athlevo are final and non-refundable, to the fullest extent allowed under Philippine law.") &&
    /\[data\.signUp\.payment, data\.signUp\.renewal, data\.signUp\.terms\]/.test(storefrontSrc));
  t("the browser and the server agree on the reference format and the return pages",
    new RegExp(storefrontSrc.match(/var SIGNUP_REF = \/(.+)\/i;/)[1]).source === SIGNUP_REFERENCE_PATTERN.source &&
    offers.every(o => SERVER[o.slug].path === "/" + o.slug));
  const env = { PLAN_QUESTIONNAIRE_URL: "https://example.com/q", PLAN_SCHEDULE_URL: "https://example.com/s" };
  t("the catalog and the server agree on each offer: name, price, reference code and whether there is a call step",
    offers.every(o => {
      const s = SERVER[o.slug], su = o.page.signUp;
      return s.product.name === o.name &&
        o.page.price.amount === "₱" + (s.product.priceCents / 100).toLocaleString("en-US") &&
        s.ref().split("-")[1] === su.refCode &&
        s.steps(env).call === su.call;
    }) && new Set(signUps.map(su => su.refCode)).size === 4);
  t("every offer is monthly: each page shows /month and the server product covers 30 days",
    offers.every(o => o.page.price.period === "/month" && SERVER[o.slug].product.entitlementDays === 30 && !("oneTime" in SERVER[o.slug].product)));
  t("the browser skips the call step and the code box only where the catalog says so",
    /cfg\.call === false/.test(storefrontSrc) && /cfg\.takesCodes !== false/.test(storefrontSrc) &&
    offers.filter(o => o.page.signUp.call === false).map(o => o.slug).join(",") === "athlevo-plan" &&
    offers.filter(o => o.page.signUp.takesCodes === false).map(o => o.slug).join(",") === "athlevo-plan,athlevo-vip-coaching");
  // A returning buyer's link is for one offer, but the reference in it says which offer was paid for.
  const confirmationProduct = vm.runInNewContext(
    "(function (catalog) { " + storefrontSrc.match(/function confirmationProduct\(route\) \{[\s\S]*?\n  \}\n/)[0] + " return confirmationProduct; })", {})(catalog);
  const refFor = (code) => code ? "ATH-" + code + "-FEEDFACE01-" + "A".repeat(24) : "";
  const opens = (slug, code) => { const r = confirmationProduct({ slug, ref: refFor(code) }); return r && r.slug; };
  t("a returning buyer's confirmation opens under the offer named in the payment reference, whichever page the link is on",
    opens("athlevo-plan", "TP") === "athlevo-plan" &&
    opens("athlevo-plan", "PL") === "athlevo-guided" &&          // a link saved when Guided was the Plan
    opens("athlevo-guided", "PL") === "athlevo-guided" &&
    opens("athlevo-coaching", "CO") === "athlevo-coaching" &&
    opens("athlevo-vip-coaching", "EL") === "athlevo-vip-coaching" &&
    opens("elite-coaching", "EL") === "athlevo-vip-coaching" &&  // a link saved when VIP was Elite
    opens("athlevo-coaching", "el") === "athlevo-vip-coaching" &&
    opens("athlevo-guided", "") === "athlevo-guided" &&
    opens("not-an-offer", "PL") === null);

  t("the confirmation names the offer from the catalog instead of hard-coding the Plan",
    /"Thank you for signing up for " \+ product\.name/.test(storefrontSrc) &&
    /"Confirmation of your " \+ product\.name \+ " payment\."/.test(storefrontSrc) &&
    !/signing up for Athlevo Plan/.test(storefrontSrc));
  t("the only network calls are to the configured endpoints, with no payment data handled",
    (storefrontSrc.match(/\bfetch\(/g) || []).length === 1 &&
    /postJson\(cfg\.checkoutEndpoint, chosen\.code \? \{ code: chosen\.code \} : \{\}\)/.test(storefrontSrc) &&
    /postJson\(cfg\.checkoutEndpoint, \{ code: code, check: true \}\)/.test(storefrontSrc) &&
    /postJson\(cfg\.statusEndpoint/.test(storefrontSrc) && !/["']\/api\//.test(storefrontSrc));
  t("the browser sends nothing but the code text (and the check flag): never an amount, percentage or price",
    !/postJson\([^)]*(amount|percent|price|discount)[^)]*\)/i.test(storefrontSrc));
  t("the checkout redirect only follows an https URL, and next-step links are https-only",
    /res\.ok && typeof target === "string" && \/\^https:/.test(storefrontSrc) && /function secureUrl/.test(storefrontSrc) &&
    /rel = "noopener noreferrer"/.test(storefrontSrc));
  t("the confirmation page is noindex, off the sitemap, and only for offers with sign-up",
    /noindex: true/.test(storefrontSrc) && /noindex, nofollow/.test(storefrontSrc) &&
    !/payment=/.test(readFileSync("./sitemap.xml", "utf8")) && /paidFor\.page\.signUp/.test(storefrontSrc));
  t("polling is bounded and stops when the visitor navigates away",
    /POLL_MAX = 24/.test(storefrontSrc) && /attempts >= POLL_MAX/.test(storefrontSrc) &&
    /stopConfirmation\(\);\s*var route = parseRoute\(\)/.test(storefrontSrc) && /run !== confirmRun/.test(storefrontSrc));
  t("returning from checkout via the back button redraws the page",
    /addEventListener\("pageshow"/.test(storefrontSrc) && /event\.persisted/.test(storefrontSrc));
  t("the confirmation copy promises no timelines, contacts or outcomes",
    (() => {
      const block = storefrontSrc.slice(storefrontSrc.indexOf("function renderConfirmation"), storefrontSrc.indexOf("function renderMissing"));
      return !/\b(within|hours?|business days?|24\/7|whatsapp|messenger|viber|telegram|email you|call you|contact you)\b/i.test(block);
    })());

  t("the confirmation page shows an agreement link only when the server returns an https one",
    /var agreement = secureUrl\(body\.agreement_url\)/.test(storefrontSrc) && /if \(agreement\) \{/.test(storefrontSrc) &&
    /externalLink\(agreement, "Read the Athlevo agreement"\)/.test(storefrontSrc));

  // Open state: render the real storefront with the switch on, in a throwaway copy.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildStorePages } = await import("../scripts/build-store-pages.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "store-open-"));
  try {
    mkdirSync(join(tmp, "js"));
    writeFileSync(join(tmp, "store.html"), storeHtml);
    writeFileSync(join(tmp, "js/storefront.js"), storefrontSrc);
    // The catalog has exactly one switch per offer; the fixtures set them explicitly so these
    // tests hold whichever way the shipped catalog has them. [plan, guided, coaching, vip]
    const SWITCH = /\bopen: (?:true|false),/g;
    t("the catalog has exactly one switch per offer", (catalogSrc.match(SWITCH) || []).length === 4);
    const build = (flags) => {
      let i = 0;
      writeFileSync(join(tmp, "js/storeCatalog.js"), catalogSrc.replace(SWITCH, () => "open: " + flags[i++] + ","));
      return Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    };
    const PLAN = "athlevo-plan", GUIDED = "athlevo-guided", COACHING = "athlevo-coaching", VIP = "athlevo-vip-coaching";
    const SU = Object.fromEntries(catalog.products.map(o => [o.slug, o.page.signUp]));
    const pageOf = (files, slug) => files["store-pages/" + slug + ".html"];
    const bannersOf = (files) => Object.values(files).filter(c => c.startsWith("<!DOCTYPE")).map(c => (c.match(/<div class="notice">([^<]*)<\/div>/) || [])[1]);
    const everyBanner = (files, text) => bannersOf(files).length === 5 && bannersOf(files).every(b => b === text);
    const buttonsIn = (html) => (html.match(SIGN_UP_BUTTON) || []).length;
    const codeBoxesIn = (html) => (html.match(/name="discount-code"/g) || []).length;
    // Closed: the registration notice and an in-page link, no buttons, no code box, no payment note.
    const shut = (html) => buttonsIn(html) === 0 && codeBoxesIn(html) === 0 && /Registration opening soon/.test(html) &&
      /href="#how-to-get-started"/.test(html) && !/signup-note/.test(html);
    // Open: two Sign Up buttons and live regions, no in-page link or notice, and the payment, renewal and no-refund lines once.
    const live = (html, slug) => buttonsIn(html) === 2 && !/href="#how-to-get-started"/.test(html) && !/Registration opening soon/.test(html) &&
      (html.match(/class="signup-status" role="status" aria-live="polite"/g) || []).length === 2 &&
      (html.match(/class="signup-note"/g) || []).length === 1 &&
      html.includes(SU[slug].payment) && html.includes(SU[slug].renewal) && html.includes(SU[slug].terms);

    // Nothing open: nothing can be bought, and Sign Up is only an in-page link.
    const none = build([false, false, false, false]);
    t("closed (none): every page's banner says purchasing is not yet available", everyBanner(none, "Purchasing is not yet available"));
    t("closed (none): all four offers show the registration notice and an in-page Sign Up link, with no buttons and no code box",
      catalog.products.every(o => shut(pageOf(none, o.slug))));
    t("closed (none): the FAQ still says purchasing is not open", /Not yet\. Purchasing is not open/.test(pageOf(none, PLAN)));

    // Athlevo Plan alone.
    const planFlags = [true, false, false, false];
    t("the Plan-only fixture opens exactly one switch", planFlags.filter(Boolean).length === 1);
    const planOnly = build(planFlags);
    const planPage = pageOf(planOnly, PLAN);
    t("open (Plan only): every page's banner announces the Plan",
      everyBanner(planOnly, "Athlevo Plan is open for sign-up") && !planOnly["store.html"].includes("Purchasing is not yet available"));
    t("open (Plan only): the Plan page has Sign Up in the hero and the pricing card, the payment, renewal and no-refund lines once, and no code box",
      live(planPage, PLAN) && codeBoxesIn(planPage) === 0 && !/Have a discount code\?/.test(planPage));
    t("open (Plan only): the Plan page shows ₱999/month and names no coach",
      textOf(mainOf(planPage)).includes("₱999") && /\/month/.test(textOf(mainOf(planPage))) &&
      !/id="coach"|Meet the Coach/.test(planPage));
    t("open (Plan only): the FAQ names the Plan and says the other programs are not available yet",
      /Athlevo Plan is open for sign-up\. The other programs are not available to buy yet\./.test(planPage) && !/Not yet\. Purchasing is not open/.test(planPage));
    t("open (Plan only): Guided, Coaching and VIP stay closed", [GUIDED, COACHING, VIP].every(s => shut(pageOf(planOnly, s))));

    // Guided and Coaching: both take the discount code.
    const gcFlags = [false, true, true, false];
    const gc = build(gcFlags);
    t("open (Guided and Coaching): every page's banner names both",
      everyBanner(gc, "Athlevo Guided and Athlevo Coaching are open for sign-up"));
    t("open (Guided and Coaching): each page has Sign Up in the hero and the pricing card, the payment, renewal and no-refund lines once, and a code box per button",
      [GUIDED, COACHING].every(s => live(pageOf(gc, s), s) && codeBoxesIn(pageOf(gc, s)) === 2 &&
        pageOf(gc, s).includes("Have a discount code?") && !/id="coach"|Meet the Coach/.test(pageOf(gc, s))));
    t("open (Guided and Coaching): the FAQ names both, and Plan and VIP stay closed",
      /Athlevo Guided and Athlevo Coaching are open for sign-up\. The other programs are not available to buy yet\./.test(pageOf(gc, COACHING)) &&
      [PLAN, VIP].every(s => shut(pageOf(gc, s))));

    // Three open, VIP closed: the FAQ says "program" for the one left.
    const three = build([true, true, true, false]);
    t("open (all but VIP): banner and FAQ name the three and say the other program is not available",
      everyBanner(three, "Athlevo Plan, Athlevo Guided and Athlevo Coaching are open for sign-up") &&
      /Athlevo Plan, Athlevo Guided and Athlevo Coaching are open for sign-up\. The other program is not available to buy yet\./.test(pageOf(three, VIP)) &&
      shut(pageOf(three, VIP)));

    // Coaching alone.
    const coOnly = build([false, false, true, false]);
    t("open (Coaching only): banner and FAQ name only Coaching, and the other three pages stay closed",
      coOnly["store.html"].includes('<div class="notice">Athlevo Coaching is open for sign-up</div>') &&
      /Athlevo Coaching is open for sign-up\. The other programs are not available to buy yet\./.test(pageOf(coOnly, COACHING)) &&
      live(pageOf(coOnly, COACHING), COACHING) && [PLAN, GUIDED, VIP].every(s => shut(pageOf(coOnly, s))));

    // All four open, as shipped.
    const all4 = build([true, true, true, true]);
    t("open (all four): every page's banner says all programs are open, and the FAQ agrees with nothing left closed",
      everyBanner(all4, "All programs are open for sign-up") &&
      /All programs are open for sign-up\./.test(pageOf(all4, VIP)) && !/not available to buy yet/.test(pageOf(all4, VIP)) &&
      !/Not yet\. Purchasing is not open/.test(pageOf(all4, VIP)));
    t("open (all four): every offer has its Sign Up buttons and payment note, and none still shows the opening-soon notice",
      catalog.products.every(o => live(pageOf(all4, o.slug), o.slug)));
    t("open (all four): the code box is on Guided and Coaching (once per Sign Up button), and not on Plan or VIP",
      [GUIDED, COACHING].every(s => codeBoxesIn(pageOf(all4, s)) === 2) &&
      [PLAN, VIP].every(s => codeBoxesIn(pageOf(all4, s)) === 0 && !/Have a discount code\?/.test(pageOf(all4, s))));
    const vipText = textOf(mainOf(pageOf(all4, VIP)));
    t("open (all four): the VIP page shows ₱7,998 and no other price, and names Dean as the coach, with his credentials",
      vipText.includes("₱7,998") && !/₱999|₱2,997|₱4,998/.test(vipText) &&
      /Meet the Coach/.test(vipText) && vipText.includes("Dean Vincent Castro") &&
      catalog.coaches[0].certifications.every(x => pageOf(all4, VIP).includes("<li>" + x + "</li>")));
    t("open (all four): each page shows its price with /month",
      [[PLAN, "₱999"], [GUIDED, "₱2,997"], [COACHING, "₱4,998"], [VIP, "₱7,998"]].every(([s, p]) => textOf(mainOf(pageOf(all4, s))).includes(p) && /\/month/.test(textOf(mainOf(pageOf(all4, s))))));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

section("11. programs.athlevo.org (the same pages, served from their own host)");
{
  const { spawn } = await import("node:child_process");
  const { request } = await import("node:http");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildStorePages } = await import("../scripts/build-store-pages.mjs");

  const HOST = "programs.athlevo.org";
  const SLUGS = catalog.products.map(p => p.slug);

  // A small stand-in for how Vercel reads vercel.json: redirects first, then real files,
  // then rewrites. Only what this file uses: literal paths, :name, and :name(regex).
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
    (rule.has || []).every(c => c.type === "host" && new RegExp("^" + c.value + "$").test(host)) &&
    (rule.missing || []).every(c => c.type === "host" && !new RegExp("^" + c.value + "$").test(host));
  const fillIn = (dest, source, path) => {
    const m = toRegExp(source).exec(path);
    // :path names the rest of the path in the catch-all; :slug the last segment.
    return dest.replace(/:path\b/, () => path.slice(1)).replace(/:slug\b/, () => path.split("/").pop());
  };
  const STATIC_FILES = (p) => ["/", "/index.html", "/store.html", "/store.css", "/robots.txt", "/sitemap.xml", "/sitemap-programs.xml", "/webinar.css", "/webinar.html", "/webinar-thank-you.html"].includes(p) ||
    /^\/(assets|js|athlevo-assets|store-pages)\//.test(p);
  const viaVercel = (host, path) => {
    for (const r of vercel.redirects) {
      if (!toRegExp(r.source).test(path) || !hostOk(r, host)) continue;
      return { status: r.permanent ? 308 : 307, location: fillIn(r.destination, r.source, path) };
    }
    if (STATIC_FILES(path)) return { status: 200, file: path === "/" ? "/index.html" : path };
    for (const r of vercel.rewrites) {
      if (!toRegExp(r.source).test(path) || !hostOk(r, host)) continue;
      return { status: 200, rewrite: fillIn(r.destination, r.source, path).split("?")[0] };
    }
    return { status: 404 };
  };

  const APP = "https://athlevo.org";
  const PROGRAMS = "https://" + HOST;
  const PREVIEW = "athlevo-ai.vercel.app";
  const table = [
    // [host, path, expected]
    [HOST, "/", { status: 307, location: "/programs" }],
    [HOST, "/programs", { status: 200, rewrite: "/store.html" }],
    ...SLUGS.flatMap(s => [
      [HOST, "/" + s, { status: 200, rewrite: "/store-pages/" + s + ".html" }],
      [HOST, "/programs/" + s, { status: 308, location: "/" + s }],
      // athlevo.org sends every old program address, in one hop, to the new host.
      ["athlevo.org", "/" + s, { status: 307, location: PROGRAMS + "/" + s }],
      ["athlevo.org", "/programs/" + s, { status: 307, location: PROGRAMS + "/" + s }],
      // A preview deployment (any other host) still serves the pages under /programs.
      [PREVIEW, "/" + s, { status: 307, location: "/programs/" + s }],
      [PREVIEW, "/programs/" + s, { status: 200, rewrite: "/store-pages/" + s + ".html" }]
    ]),
    // Retired addresses: Elite Coaching was renamed Athlevo VIP Coaching and Hybrid Programming was dropped.
    // They answer the same on every host, in one hop.
    ...[HOST, "athlevo.org", PREVIEW].flatMap(h => [
      [h, "/elite-coaching", { status: 308, location: PROGRAMS + "/athlevo-vip-coaching" }],
      [h, "/programs/elite-coaching", { status: 308, location: PROGRAMS + "/athlevo-vip-coaching" }],
      [h, "/hybrid-programming", { status: 307, location: PROGRAMS + "/programs" }],
      [h, "/programs/hybrid-programming", { status: 307, location: PROGRAMS + "/programs" }]
    ]),
    [HOST, "/programs/not-an-offer", { status: 200, rewrite: "/store.html" }],
    [HOST, "/api/plan-signup/checkout", { status: 200, rewrite: "/api/providers" }],
    [HOST, "/api/guided-signup/checkout", { status: 200, rewrite: "/api/providers" }],
    [HOST, "/api/coaching-signup/status", { status: 200, rewrite: "/api/providers" }],
    [HOST, "/api/vip-signup/checkout", { status: 200, rewrite: "/api/providers" }],
    [HOST, "/assets/store/founder-920.webp", { status: 200, file: "/assets/store/founder-920.webp" }],
    [HOST, "/js/storefront.js", { status: 200, file: "/js/storefront.js" }],
    [HOST, "/store.css", { status: 200, file: "/store.css" }],
    [HOST, "/robots.txt", { status: 200, file: "/robots.txt" }],
    // The app stays on athlevo.org: its pages, files and old links never answer on this host.
    [HOST, "/privacy", { status: 307, location: APP + "/privacy" }],
    [HOST, "/support", { status: 307, location: APP + "/support" }],
    [HOST, "/terms", { status: 307, location: APP + "/terms" }],
    [HOST, "/signup", { status: 307, location: APP + "/signup" }],
    [HOST, "/ai", { status: 307, location: APP + "/ai" }],
    [HOST, "/index.html", { status: 307, location: APP + "/index.html" }],
    [HOST, "/service-worker.js", { status: 307, location: APP + "/service-worker.js" }],
    [HOST, "/store/first-5k", { status: 307, location: APP + "/store/first-5k" }],
    [HOST, "/programs-extra", { status: 307, location: APP + "/programs-extra" }],
    [HOST, "/apiary", { status: 307, location: APP + "/apiary" }],
    // athlevo.org itself is unchanged: its root is the app.
    ["athlevo.org", "/", { status: 200, file: "/index.html" }],
    ["athlevo.org", "/privacy", { status: 200, rewrite: "/index.html" }],
    ["athlevo.org", "/api/plan-signup/checkout", { status: 200, rewrite: "/api/providers" }],
    ["athlevo.org", "/robots.txt", { status: 200, file: "/robots.txt" }],
    ["athlevo.org", "/sitemap.xml", { status: 200, file: "/sitemap.xml" }],
    [HOST, "/sitemap-programs.xml", { status: 200, file: "/sitemap-programs.xml" }],
    // The hub, and old and unknown program addresses, also go to the new host (which sorts out the rest).
    ["athlevo.org", "/programs", { status: 307, location: PROGRAMS + "/programs" }],
    ["athlevo.org", "/programs/first-5k", { status: 307, location: PROGRAMS + "/programs/first-5k" }],
    ["athlevo.org", "/programs/not-an-offer", { status: 307, location: PROGRAMS + "/programs/not-an-offer" }],
    // The legacy /store paths take their old first hop, then the rules above.
    ["athlevo.org", "/store", { status: 308, location: "/programs" }],
    ["athlevo.org", "/store/first-5k", { status: 308, location: "/programs/athlevo-plan" }],
    ["athlevo.org", "/store/athlevo-plan", { status: 308, location: "/programs/athlevo-plan" }],
    ["athlevo.org", "/store/faster-5k", { status: 308, location: "/programs/athlevo-coaching" }],
    ["athlevo.org", "/store/marathon", { status: 308, location: "/programs/athlevo-vip-coaching" }],
    ["athlevo.org", "/store/half-marathon", { status: 308, location: "/programs" }],
    ["athlevo.org", "/store/elite-coaching", { status: 308, location: "/programs/elite-coaching" }],
    [PREVIEW, "/", { status: 200, file: "/index.html" }],
    [PREVIEW, "/programs", { status: 200, rewrite: "/store.html" }],
    // The free webinar pages (see docs/webinar.md): served on the programs host, moved there from athlevo.org.
    [HOST, "/webinar", { status: 200, rewrite: "/webinar.html" }],
    [HOST, "/webinar/", { status: 200, rewrite: "/webinar.html" }],
    [HOST, "/webinar/thank-you", { status: 200, rewrite: "/webinar-thank-you.html" }],
    [HOST, "/webinar/thank-you/", { status: 200, rewrite: "/webinar-thank-you.html" }],
    [HOST, "/webinar.css", { status: 200, file: "/webinar.css" }],
    [HOST, "/js/webinar.js", { status: 200, file: "/js/webinar.js" }],
    [HOST, "/api/webinar/register", { status: 200, rewrite: "/api/providers" }],
    [HOST, "/webinars", { status: 307, location: APP + "/webinars" }],
    [HOST, "/webinar.html", { status: 307, location: APP + "/webinar.html" }],
    ["athlevo.org", "/webinar", { status: 307, location: PROGRAMS + "/webinar" }],
    ["athlevo.org", "/webinar/", { status: 307, location: PROGRAMS + "/webinar/" }],
    ["athlevo.org", "/webinar/thank-you", { status: 307, location: PROGRAMS + "/webinar/thank-you" }],
    ["athlevo.org", "/webinar/thank-you/", { status: 307, location: PROGRAMS + "/webinar/thank-you/" }],
    ["athlevo.org", "/api/webinar/register", { status: 200, rewrite: "/api/providers" }],
    [PREVIEW, "/webinar", { status: 200, rewrite: "/webinar.html" }],
    [PREVIEW, "/webinar/thank-you", { status: 200, rewrite: "/webinar-thank-you.html" }]
  ];
  const same = (got, want) => got.status === want.status && (got.location || "") === (want.location || "") &&
    (want.rewrite ? (got.rewrite || "").startsWith(want.rewrite) : true) && (want.file ? got.file === want.file : true);

  const bad = table.filter(([h, p, want]) => !same(viaVercel(h, p), want));
  t("vercel.json: " + table.length + " requests on programs.athlevo.org and athlevo.org behave as designed",
    bad.length === 0, bad.map(([h, p, w]) => h + p + " got " + JSON.stringify(viaVercel(h, p))).join(" | "));

  const host = vercel.redirects.filter(r => (r.has || []).some(c => c.value === HOST));
  const catchAll = host[host.length - 1];
  t("the host's redirects come before the legacy and short-link redirects, and the catch-all is last of them",
    host.length === 2 + SLUGS.length && host[0].source === "/" && catchAll.destination === "https://athlevo.org/:path" &&
    catchAll.permanent === false &&
    vercel.redirects.indexOf(catchAll) < vercel.redirects.findIndex(r => r.source === "/store/first-5k"));
  t("short links are only redirects off the programs host (on it they are the pages)",
    SLUGS.every(s => {
      const r = vercel.redirects.find(x => x.source === "/" + s && x.destination === "/programs/" + s);
      return r && r.missing.length === 1 && r.missing[0].type === "host" && r.missing[0].value === HOST &&
        vercel.rewrites.some(w => w.source === "/" + s && w.has && w.has[0].value === HOST && w.destination === "/store-pages/" + s + ".html");
    }));
  t("every host rule is keyed on exactly programs.athlevo.org or athlevo.org, and every athlevo.org rule excludes programs.athlevo.org",
    [...vercel.redirects, ...vercel.rewrites].every(r => [...(r.has || []), ...(r.missing || [])].every(c => c.type === "host" && (c.value === HOST || c.value === "athlevo.org"))) &&
    [...vercel.redirects, ...vercel.rewrites].filter(r => (r.has || []).some(c => c.value === "athlevo.org"))
      .every(r => r.has.length === 1 && (r.missing || []).length === 1 && r.missing[0].value === HOST));
  const apexRules = vercel.redirects.filter(r => (r.has || []).some(c => c.value === "athlevo.org"));
  t("athlevo.org's redirects to the new host are the hub, the four offers (by /programs/<slug> and by short link) the rest of /programs/<x> and the four /webinar addresses: temporary, in one hop, query kept, before the legacy /store rules",
    apexRules.length === 1 + 4 + 1 + 4 + 4 && apexRules.every(r => r.permanent === false && r.destination.startsWith(PROGRAMS + "/")) &&
    SLUGS.every(s => apexRules.some(r => r.source === "/programs/" + s && r.destination === PROGRAMS + "/" + s) &&
      apexRules.some(r => r.source === "/" + s && r.destination === PROGRAMS + "/" + s)) &&
    apexRules.some(r => r.source === "/programs" && r.destination === PROGRAMS + "/programs") &&
    apexRules.some(r => r.source === "/programs/:slug" && r.destination === PROGRAMS + "/programs/:slug") &&
    vercel.redirects.indexOf(apexRules[0]) < vercel.redirects.findIndex(r => r.source === "/store/first-5k") &&
    vercel.redirects.indexOf(apexRules.find(r => r.source === "/programs/:slug")) > vercel.redirects.findIndex(r => r.source === "/programs/elite-coaching" && !r.has));

  // Everything the store pages load or link to must still work from this host: files and
  // API calls are served, the three legal pages go to athlevo.org, nothing else is needed.
  const pages = ["store.html", ...readdirSync("./store-pages").map(f => "store-pages/" + f)];
  const refs = new Set();
  for (const f of pages) {
    for (const m of readFileSync("./" + f, "utf8").matchAll(/(?:href|src|action)="(\/[^"]*)"/g)) refs.add(m[1].split("#")[0].split("?")[0] || "/programs");
  }
  for (const m of storefrontSrc.matchAll(/["'](\/api\/[a-z-]+\/[a-z-]+)["']/g)) refs.add(m[1]);
  for (const s of catalog.products) {
    const su = s.page && s.page.signUp;
    if (su) { refs.add(su.checkoutEndpoint); refs.add(su.statusEndpoint); }
  }
  const strays = [...refs].filter(p => {
    const got = viaVercel(HOST, p);
    if (got.status === 200) return false;
    if (got.status === 308 && got.location.startsWith("/")) return false; // /programs/<slug> -> /<slug>, same host
    return !(got.status === 307 && ["/privacy", "/support", "/terms"].some(l => got.location === APP + l));
  });
  t("every link, file and API call on the store pages works from programs.athlevo.org (" + refs.size + " checked)",
    refs.size > 15 && strays.length === 0, strays.join(", "));
  t("every file those pages load exists on disk",
    [...refs].filter(p => /\.(?:js|css|webp|avif|png|jpg)$/.test(p)).every(p => existsSync("." + decodeURIComponent(p))));

  // The preview server answers the same table.
  const port = 4300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, ["scripts/serve-web.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const ask = (h, path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: h + ":" + port } }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location || "", body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await ask("127.0.0.1", "/robots.txt"); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    t("the preview server starts", up);
    const badLocal = [];
    for (const [h, p, want] of table) {
      const got = await ask(h, p);
      let ok = got.status === want.status && got.location === (want.location || "");
      if (want.rewrite && want.rewrite.startsWith("/store")) ok = ok && got.body.equals(readFileSync("." + want.rewrite));
      if (want.rewrite && want.rewrite === "/index.html") ok = ok && got.body.equals(readFileSync("./index.html"));
      if (want.file) ok = ok && got.body.equals(readFileSync("." + want.file));
      if (want.rewrite === "/api/providers") ok = got.status !== 308 && got.status !== 307; // no function is run locally
      if (!ok) badLocal.push(h + p + " -> " + got.status + " " + got.location);
    }
    t("the local preview server gives the same answers as vercel.json for the table above", badLocal.length === 0, badLocal.join(" | "));
    const withCode = await ask(HOST, "/?code=AV8S-KUEW");
    const short = await ask("athlevo.org", "/athlevo-plan?code=AV8S-KUEW");
    const nested = await ask("athlevo.org", "/programs/athlevo-plan?code=AV8S-KUEW");
    const hub = await ask("athlevo.org", "/programs?code=AV8S-KUEW");
    const preview = await ask(PREVIEW, "/athlevo-plan?code=AV8S-KUEW");
    t("a ?code= link keeps its code through the preview server's redirects",
      withCode.location === "/programs?code=AV8S-KUEW" && short.location === PROGRAMS + "/athlevo-plan?code=AV8S-KUEW" &&
      nested.location === PROGRAMS + "/athlevo-plan?code=AV8S-KUEW" && hub.location === PROGRAMS + "/programs?code=AV8S-KUEW" &&
      preview.location === "/programs/athlevo-plan?code=AV8S-KUEW");
  } finally {
    server.kill();
  }

  // The switch-over: SITE_URL is the new host, so the files on disk carry it everywhere a search
  // engine or a buyer could see an address. A build from the same sources must reproduce them.
  t("the catalog has one SITE_URL, on programs.athlevo.org, and the app's address (athlevo.org) is kept separately",
    (catalogSrc.match(/var SITE_URL = "https:\/\/[a-z.]+";/g) || []).length === 1 &&
    /var SITE_URL = "https:\/\/programs\.athlevo\.org";/.test(catalogSrc) &&
    /var APP_URL = "https:\/\/athlevo\.org";/.test(catalogSrc) &&
    catalog.siteUrl === "https://" + HOST && catalog.appUrl === APP);
  const onDisk = Object.fromEntries(buildStorePages(".").map(f => [f.path, readFileSync("./" + f.path, "utf8") === f.content]));
  t("every generated page and sitemap on disk is exactly what the build writes", Object.values(onDisk).every(Boolean) && Object.keys(onDisk).length === 7,
    Object.entries(onDisk).filter(([, ok]) => !ok).map(([p]) => p).join(", "));
  const builtPages = Object.fromEntries(["store.html", ...SLUGS.map(s => "store-pages/" + s + ".html")].map(f => [f, readFileSync("./" + f, "utf8")]));
  t("every offer page is canonical at https://programs.athlevo.org/<slug> and links to its siblings as /<slug>",
    SLUGS.every(s => {
      const html = builtPages["store-pages/" + s + ".html"];
      return html.includes('<link rel="canonical" href="https://' + HOST + "/" + s + '">') &&
        html.includes('<meta property="og:url" content="https://' + HOST + "/" + s + '">') &&
        !/href="\/programs\/[a-z]/.test(html) && !html.includes("athlevo.org/programs/");
    }));
  t("the hub is canonical at https://programs.athlevo.org/programs and its cards link to /<slug>",
    builtPages["store.html"].includes('<link rel="canonical" href="https://' + HOST + '/programs">') &&
    SLUGS.every(s => builtPages["store.html"].includes('href="/' + s + '"')) && !/href="\/programs\/[a-z]/.test(builtPages["store.html"]));
  t("nothing in the built pages still points at athlevo.org/programs",
    Object.values(builtPages).every(html => !/https:\/\/athlevo\.org\/programs/.test(html)));
  t("the legal links in the footer go to athlevo.org (the program host does not serve them)",
    Object.values(builtPages).every(html => ["privacy", "terms", "support"].every(l => html.includes('<a href="https://athlevo.org/' + l + '">')) &&
      !/<a href="\/(?:privacy|terms|support)">/.test(html)));
  const ld = JSON.parse(builtPages["store.html"].match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const org = ld["@graph"].find(x => x["@type"] === "Organization");
  const person = ld["@graph"].find(x => x["@type"] === "Person");
  t("structured data: Athlevo (the organization) is on athlevo.org, Dean's entry is on the hub, and they still point at each other",
    org["@id"] === APP + "/#organization" && org.url === APP + "/" &&
    person["@id"] === PROGRAMS + "/programs#dean-castro" && org.founder["@id"] === person["@id"] && person.worksFor["@id"] === org["@id"]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
