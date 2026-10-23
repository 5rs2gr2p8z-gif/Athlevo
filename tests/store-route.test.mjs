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
  const ORDER = ["Athlevo Plan", "Athlevo Coaching", "Hybrid Programming", "Elite Coaching"];
  t("catalog exposes four draft programs", catalog.products.length === 4);
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
    catalog.products.map(p => p.slug).join(",") === "athlevo-plan,athlevo-coaching,hybrid-programming,elite-coaching");
  t("each card uses its assigned photo",
    [["athlevo-plan", "/assets/store/track-1280.webp"],
     ["athlevo-coaching", "/assets/store/road-1280.webp"],
     ["hybrid-programming", "/assets/store/hybrid-1023.webp"],
     ["elite-coaching", "/assets/store/pack-1206.webp"]]
      .every(([slug, src]) => catalog.getProduct(slug).hero.src === src));
  t("offers carry no old race-specific copy or durations",
    catalog.products.every(p =>
      ["durationWeeks", "durationLabel", "intendedRunner", "summary", "description",
       "whoFor", "startingFitness", "receives", "intakeAndDelivery", "collection"]
        .every(k => !(k in p))));
  t("offer data mentions no race distances or week counts (approved athlete quotes excepted)",
    !/\b(5k|10k|half[- ]marathon|marathon|\d+[- ]weeks?)\b/i.test(
      JSON.stringify(catalog.products.map(({ coachSupport, hero, page, ...rest }) =>
        ({ ...rest, page: page && { ...page, athleteFeedback: undefined } })))));
  t("Athlevo Plan, Athlevo Coaching and Elite Coaching have built pages; Hybrid Programming stays bare",
    !!catalog.getProduct("athlevo-plan").page && !!catalog.getProduct("athlevo-coaching").page && !!catalog.getProduct("elite-coaching").page &&
    catalog.products.filter(p => !["athlevo-plan", "athlevo-coaching", "elite-coaching"].includes(p.slug)).every(p =>
      !("page" in p) && Object.keys(p).sort().join(",") === "coachSupport,hero,name,related,slug"));
  t("race-based collections are gone",
    !("collections" in catalog) && !("getCollection" in catalog) && !("filterProducts" in catalog));
  t("old race URLs resolve to the renamed offers",
    catalog.resolveSlug("first-5k") === "athlevo-plan" &&
    catalog.resolveSlug("faster-5k") === "athlevo-coaching" &&
    catalog.resolveSlug("half-marathon") === "hybrid-programming" &&
    catalog.resolveSlug("marathon") === "elite-coaching");
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
  const withoutConfirmedPrice = blob.split("₱1,998").join("").split("₱4,998").join("").split("₱7,998").join("");
  t("no prices, currency, or fake discounts beyond the confirmed ₱1,998, ₱4,998 and ₱7,998",
    !/\$\d|₱\d|€\d|£\d|was\s*₱|sale price|\bfees?\b|free trial/i.test(withoutConfirmedPrice) &&
    !/%\s*off|discount|coupon/i.test(catalogSrc + storeHtml));
  t("the only discount wording is the code box: the storefront hard-codes no percentage and no amount",
    !/\d\s*%\s*(off|discount)/i.test(storefrontSrc) && !/₱\s*\d/.test(storefrontSrc) && !/\b(jcir|partner)\b/i.test(catalogSrc + storeHtml + storefrontSrc));
  t("each confirmed price lives only in its own offer's page data",
    catalogSrc.split("₱1,998").length - 1 === 1 && catalogSrc.split("₱4,998").length - 1 === 1 && catalogSrc.split("₱7,998").length - 1 === 1 &&
    !storeHtml.includes("₱") && !storefrontSrc.includes("₱") &&
    catalog.getProduct("athlevo-plan").page.price.amount === "₱1,998" &&
    catalog.getProduct("athlevo-coaching").page.price.amount === "₱4,998" &&
    catalog.getProduct("elite-coaching").page.price.amount === "₱7,998" &&
    !JSON.stringify(catalog.getProduct("athlevo-plan")).includes("₱4,998") &&
    !JSON.stringify(catalog.getProduct("athlevo-plan")).includes("₱7,998") &&
    !JSON.stringify(catalog.getProduct("athlevo-coaching")).includes("₱1,998") &&
    !JSON.stringify(catalog.getProduct("athlevo-coaching")).includes("₱7,998") &&
    !JSON.stringify(catalog.getProduct("elite-coaching")).includes("₱1,998") &&
    !JSON.stringify(catalog.getProduct("elite-coaching")).includes("₱4,998") &&
    catalog.products.filter(p => !["athlevo-plan", "athlevo-coaching", "elite-coaching"].includes(p.slug)).every(p => !JSON.stringify(p).includes("₱")));
  t("the Elite price is published only on the Elite page, and nothing is shown for Hybrid Programming",
    /7,998/.test(JSON.stringify(catalog.getProduct("elite-coaching"))) && !/7,998/.test(storeHtml) &&
    !/7,998/.test(JSON.stringify(catalog.getProduct("hybrid-programming"))));
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
    catalog.coaches[0] === catalog.getProduct("athlevo-plan").page.coach &&
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
    catalog.getProduct("athlevo-plan").page.coach === catalog.coaches[0]);
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
  const sitemap = readFileSync("./sitemap.xml", "utf8");
  t("robots.txt lets every crawler in (search and AI) and names the sitemap, which lists /programs",
    /^User-agent:\s*\*/m.test(robots) && /^Allow:\s*\/\s*$/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
    /^Sitemap:\s*https:\/\/athlevo\.org\/sitemap\.xml/m.test(robots) && sitemap.includes("<loc>https://athlevo.org/programs</loc>"));
}

section("4d. Athlevo Plan page");
{
  const plan = catalog.getProduct("athlevo-plan");
  const page = plan.page;
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel) => {
    const m = flat.match(new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };
  const tabletCss = (flat.match(/@media \(max-width: 980px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  const mobileCss = (flat.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  const landingSrc = readFileSync("./js/landingContent.js", "utf8");
  const pageJson = JSON.stringify({ ...page, athleteFeedback: undefined });

  t("first screen: title, headline, description, supporting text",
    plan.name === "Athlevo Plan" &&
    page.headline === "A clear plan for your next goal." &&
    page.description === "Personalized running and strength training built around your fitness, schedule, and goals." &&
    page.supporting === "Monthly coaching plan. No lock-in.");
  t("price is ₱1,998/month", page.price.amount + page.price.period === "₱1,998/month");
  t("Sign Up is an in-page link to How to Get Started, not a purchase",
    page.cta.label === "Sign Up" && page.cta.target === "how-to-get-started" &&
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

  t("overview explains who it suits and lists the confirmed inclusions",
    /train independently/.test(page.overview.intro) && /clear, personalized structure/.test(page.overview.intro) &&
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "A personalized running plan.",
      "Strength training matched to your schedule and equipment.",
      "Planning around your current fitness, goals, race calendar, and other training.",
      "Basic coach support.",
      "A monthly coach review and plan adjustment."
    ]));
  t("monthly reviews belong to Plan; more frequent reviews belong to Athlevo Coaching, and nothing says 'weekly'",
    /includes a monthly review/.test(page.overview.note) &&
    /More frequent reviews are part of Athlevo Coaching/.test(page.overview.note) &&
    !/weekly|every week/i.test(JSON.stringify(page)));

  const fb = page.athleteFeedback;
  t("athlete feedback is labelled 'From Athlevo athletes.' and never attributed to Plan customers",
    fb.label === "From Athlevo athletes." && !/plan (customer|member|client|athlete)/i.test(JSON.stringify(fb)));
  t("every quote, name, and context is verbatim from the approved landing content",
    fb.items.length > 0 && fb.items.every(i => i.source === "js/landingContent.js" &&
      landingSrc.includes('name: "' + i.name + '"') &&
      landingSrc.includes('context: "' + i.context + '"') &&
      landingSrc.includes('quote: "' + i.quote + '"')));
  t("feedback has no star ratings or scores", !/[★⭐]|\d\s*\/\s*5|\bstars?\b/i.test(JSON.stringify(fb)));
  t("the feedback section is omitted when no approved items exist",
    /feedback && feedback\.items && feedback\.items\.length/.test(storefrontSrc));

  t("pricing: confirmed inclusions, month-to-month, no lock-in",
    page.pricing.terms === "Month-to-month, no lock-in." &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Personalized running plan",
      "Strength training matched to your schedule and equipment",
      "Basic coach support",
      "Monthly coach review and plan adjustment"
    ]));
  t("page data has no discounts, fees, or promotions",
    !/\b(discounts?|fees?|free|trial|coupons?|promos?|refunds?)\b|% off/i.test(pageJson));

  t("coach: name, role, and an existing optimized photo of Dean",
    page.coach.name === "Dean Vincent Castro" &&
    page.coach.role === "Founder & Head Coach, Athlevo" &&
    page.coach.photo.src === "/assets/store/founder-1145.webp" &&
    page.coach.photo.original === "/assets/landing/dean-founder.png" &&
    existsSync("." + page.coach.photo.original) &&
    page.coach.photo.webp.length === 2 && page.coach.photo.avif.length === 2);
  t("coach intro invents no credentials and does not promise Dean coaches every customer",
    /structured running and strength training/.test(page.coach.intro) &&
    !/\b(certif\w*|usatf|licen[sc]\w*|degree|champion\w*|records?|awards?|years|olympi\w*|podium|winner|won)\b/i.test(page.coach.intro) &&
    !/personally|every (plan )?(customer|athlete|client|member)|each (customer|athlete|client)/i.test(page.coach.intro));

  t("how to get started: payment, questionnaire, call, plan, monthly review; registration-opening-soon notice",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "Schedule a call with the Athlevo team.",
      "Receive your personalized plan and coach contact instructions.",
      "Follow the plan, with a monthly review and adjustment."
    ]) && page.getStarted.notice === "Registration opening soon");
  t("the only registration notice is 'Registration opening soon' (no extra sentence)",
    !("noticeDetail" in page.getStarted) &&
    !/not available yet/i.test(JSON.stringify(page)) &&
    !/noticeDetail/.test(storefrontSrc));
  t("no invented delivery timelines, support channels, or response times",
    !/\b(messenger|whatsapp|facebook|email|viber|telegram|within|hours?|business days?|24\/7|response|reply|replies)\b/i.test(pageJson) &&
    !/\d+\s*(minutes?|hours?|days?|weeks?)/i.test(pageJson));

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

section("4e. Athlevo Coaching page");
{
  const coaching = catalog.getProduct("athlevo-coaching");
  const plan = catalog.getProduct("athlevo-plan");
  const page = coaching.page;
  const landingSrc = readFileSync("./js/landingContent.js", "utf8");
  const pageJson = JSON.stringify({ ...page, athleteFeedback: undefined });

  t("first screen: title, headline, description, supporting text",
    coaching.name === "Athlevo Coaching" &&
    page.headline === "Your training, reviewed and adjusted regularly." &&
    page.description === "Personalized online running coaching with regular reviews and direct coach communication." &&
    page.supporting === "Month-to-month coaching. No lock-in.");
  t("price is ₱4,998/month", page.price.amount + page.price.period === "₱4,998/month");
  t("Coaching sign-up wiring: Sign Up falls back to an in-page link while its switch is off, and the endpoints are Coaching's",
    page.signUp && typeof page.signUp.open === "boolean" && page.cta.label === "Sign Up" && page.cta.target === "how-to-get-started" &&
    page.getStarted.notice === "Registration opening soon" &&
    page.signUp.checkoutEndpoint === "/api/coaching-signup/checkout" && page.signUp.statusEndpoint === "/api/coaching-signup/status");
  t("reviews are described as regular and frequent, never as weekly or on a fixed schedule",
    !/weekly|every week|daily|biweekly|fortnight/i.test(JSON.stringify(page) + coaching.name) &&
    /reviews and adjusts your training regularly/.test(page.overview.intro) &&
    /communicate with your coach directly/.test(page.overview.intro) &&
    /more frequent reviews than Athlevo Plan, which includes a monthly review/.test(page.overview.note));
  t("Coaching checkout copy is the Plan's: same methods, renewal and no-refund wording",
    page.signUp.payment === plan.page.signUp.payment && page.signUp.renewal === plan.page.signUp.renewal &&
    page.signUp.terms === plan.page.signUp.terms);
  t("what is included is exactly what the agreement promises for this plan",
    JSON.stringify(page.overview.includes) === JSON.stringify([
      "An onboarding call to understand your training history, current fitness, schedule, equipment, limitations, and goals.",
      "A personalized running plan.",
      "Strength and conditioning guidance where appropriate.",
      "Regular coach reviews and assessments of your progress.",
      "Direct coach communication.",
      "Frequent adjustments based on how training is actually going."
    ]));
  t("pricing: confirmed inclusions, month-to-month, no lock-in",
    page.pricing.terms === "Month-to-month, no lock-in." &&
    JSON.stringify(page.pricing.includes) === JSON.stringify([
      "Personalized running plan",
      "Strength and conditioning guidance where appropriate",
      "Regular coach reviews and assessments",
      "Direct coach communication"
    ]));
  t("how to get started follows the Plan's flow: payment, questionnaire, onboarding call, plan, regular reviews",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
      "Schedule your onboarding call.",
      "Receive your personalized running plan, with strength and conditioning guidance where appropriate.",
      "Train with regular coach reviews, frequent adjustments, and direct coach communication."
    ]));
  t("athlete feedback is the same approved set the Plan page uses, verbatim from the landing content",
    page.athleteFeedback === plan.page.athleteFeedback &&
    page.athleteFeedback.label === "From Athlevo athletes." &&
    page.athleteFeedback.items.length > 0 && page.athleteFeedback.items.every(i => i.source === "js/landingContent.js" &&
      landingSrc.includes('name: "' + i.name + '"') &&
      landingSrc.includes('context: "' + i.context + '"') &&
      landingSrc.includes('quote: "' + i.quote + '"')));
  t("no coach is named or implied: no coach profile, and no 'Meet the Coach' section on the page",
    !("coach" in page) && !/\b(Dean|Castro|Louie|Christian|Francia|founder|head coach)\b/i.test(pageJson) &&
    /if \(data\.coach\)/.test(storefrontSrc) &&
    !/id="coach"/.test(readFileSync("./store-pages/athlevo-coaching.html", "utf8")) &&
    /id="coach"/.test(readFileSync("./store-pages/athlevo-plan.html", "utf8")));
  t("no invented response times, support channels, timelines, discounts, fees, or outcomes",
    !/\b(messenger|whatsapp|facebook|email|viber|telegram|within|hours?|business days?|24\/7|response|respond|reply|replies|priority|guarantee\w*|free|trial|discounts?|fees?|refunds?|promos?|coupons?)\b|% off/i.test(pageJson) &&
    !/\d+\s*(minutes?|hours?|days?|weeks?)/i.test(pageJson));
  t("the page says nothing about face-to-face sessions, medical care, or a named platform",
    !/\b(face-to-face|in-person|gym|medical|nutrition|physio\w*|trainingpeaks|strava|garmin|google|calendar|spreadsheet)\b/i.test(pageJson));
  t("coach-support terms stay in internal data, not on the page",
    coaching.coachSupport.status === "pending" && !/coachSupport/.test(pageJson));

  // The prerendered page carries the same text for crawlers.
  const html = readFileSync("./store-pages/athlevo-coaching.html", "utf8");
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  t("the prerendered Coaching page holds the price, inclusions, steps and quotes (and the opening-soon notice only while closed)",
    text.includes("₱4,998") && text.includes("/month") &&
    text.includes(page.getStarted.notice) === !page.signUp.open &&
    page.overview.includes.every(i => text.includes(i)) &&
    page.getStarted.steps.every(i => text.includes(i)) &&
    page.athleteFeedback.items.every(i => text.includes(i.quote) && text.includes(i.name)) &&
    !text.includes("Meet the Coach") && !text.includes("Purchasing not available"));
  t("the prerendered Coaching page has Sign Up buttons exactly when its switch is on, and never a form field or card input",
    (html.match(/<button class="btn btn-red btn-lg" type="button">Sign Up<\/button>/g) || []).length === (page.signUp.open ? 2 : 0) &&
    !/<(form|textarea|select)\b/i.test(html) &&
    (page.signUp.open || !/checkout|paymongo|payment=/i.test(html.replace(/<script[\s\S]*?<\/script>/g, ""))));
  t("the prerendered Coaching page has the discount code box exactly when sign-up is open, and no card field",
    (html.match(/<input\b[^>]*name="discount-code"[^>]*>/g) || []).length === (page.signUp.open ? 2 : 0) &&
    (html.match(/<input\b/g) || []).length === (page.signUp.open ? 2 : 0) && !/cc-|cvv|cvc|card-?number/i.test(html) &&
    (html.includes("Have a discount code?") === page.signUp.open));
}

section("5. Client routing");
{
  t("storefront reads /programs and /programs/:slug, and still accepts the old /store paths",
    storefrontSrc.includes('var BASE = "/programs"') &&
    storefrontSrc.includes('path === BASE || path === "/store"') &&
    /\^\\\/\(\?:programs\|store\)\\\/\(\[\^\/\]\+\)\$/.test(storefrontSrc) &&
    storefrontSrc.includes("BASE + \"/\" + encodeURIComponent(slug)"));
  t("a stale /store address is rewritten to /programs in the address bar, keeping the query and hash",
    /function canonicalizeLegacyPath\(\)/.test(storefrontSrc) &&
    /history\.replaceState\([^)]*BASE \+ rest \+ \(loc\.search \|\| ""\) \+ \(loc\.hash \|\| ""\)\)/.test(storefrontSrc) &&
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
    existsSync("./assets/landing/dean-founder.png"));
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
  const hybrid = catalog.getProduct("hybrid-programming").hero;
  t("Hybrid Programming uses the supplied athlete photo, cropped 4:5, with the original kept",
    hybrid.original === "/assets/landing/hybrid-programming-athlete.png" &&
    existsSync("./assets/landing/hybrid-programming-athlete.png") &&
    hybrid.width === 1023 && hybrid.height === 1279 &&
    ["640", "1023"].every(w => ["webp", "avif"].every(ext => existsSync("./assets/store/hybrid-" + w + "." + ext))));
  t("Hybrid Programming no longer uses the founder photo, which stays on Dean's coach card only",
    hybrid.src !== catalog.coaches[0].photo.src &&
    catalog.coaches[0].photo.src === "/assets/store/founder-1145.webp" &&
    catalog.products.filter(p => p.hero.src === catalog.coaches[0].photo.src).length === 0);
  t("Hybrid photo alt text describes the scene without naming a person or race number",
    hybrid.alt.length > 20 && !/dean|castro|founder|christian|francia|\d{4,}/i.test(hybrid.alt));
  t("Hybrid photo has a top-anchored focus so the head stays in the square mobile card",
    hybrid.focus === "50% 0%" &&
    /if \(photo\.focus\) node\.style\.objectPosition = photo\.focus/.test(storefrontSrc) &&
    catalog.products.filter(p => p.hero.focus).length === 1);
  t("Hybrid WebP is under 500KB", hybridWebp < 500 * 1024, String(hybridWebp));
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
    pages.length === 5 && pages.every(p => p.meta && p.meta.url === "https://athlevo.org" + (p.slug ? "/programs/" + p.slug : "/programs")) &&
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
    catalog.products.every(p => home.includes(p.name) && bySlug(null).html.includes('href="/programs/' + p.slug + '"')) &&
    catalog.coaches.every(c => home.includes(c.name) && home.includes(c.role)) &&
    home.includes("Meet the coaches") &&
    catalog.getHubFaqs().every(f => home.includes(f.question) && home.includes(f.answer)));
  t("every coach's certifications are in the /programs HTML exactly as supplied, with the supplied role lines",
    catalog.coaches.every(c => c.certifications.every(x => bySlug(null).html.includes("<li>" + x + "</li>"))) &&
    catalog.coaches.every(c => home.includes(c.role)) &&
    home.includes("Strength & Conditioning Coach, Assistant Running Coach, Athlevo") &&
    home.includes("Running Coach, Athlevo"));
  t("the Plan page's Meet the Coach block shows Dean's credentials too; the Coaching page names no coach",
    catalog.coaches[0].certifications.every(x => bySlug("athlevo-plan").html.includes("<li>" + x + "</li>")) &&
    /<p class="coach-card-creds-label">Credentials<\/p>/.test(bySlug("athlevo-plan").html) &&
    !/id="coach"|USATF|STRYD/.test(bySlug("athlevo-coaching").html));

  const plan = visible(bySlug("athlevo-plan").html);
  const planData = catalog.getProduct("athlevo-plan").page;
  t("Athlevo Plan text is in the HTML: price, what is included, athlete quotes and how to get started (opening-soon notice only while closed)",
    plan.includes("₱1,998") && plan.includes("/month") &&
    plan.includes(planData.getStarted.notice) === !planData.signUp.open &&
    planData.overview.includes.every(i => plan.includes(i)) &&
    planData.getStarted.steps.every(i => plan.includes(i)) &&
    planData.athleteFeedback.items.every(i => plan.includes(i.quote) && plan.includes(i.name)) &&
    plan.includes(planData.coach.name));
  t("offers without confirmed details show no price and no invented copy",
    ["hybrid-programming"].every(slug => {
      const v = visible(bySlug(slug).html);
      return !/₱|\bper month\b|\/month/i.test(v) && v.includes(catalog.getProduct(slug).name) && v.includes("Purchasing not available");
    }));

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
  t("pre-rename offer URLs redirect permanently, in one hop, to the new /programs page; removed offers have no redirect",
    legacy.length === 4 &&
    legacy.every(([from, to]) => vercel.redirects.some(r => r.source === "/store/" + from && r.destination === "/programs/" + to && r.permanent === true) &&
      catalog.getProduct(to)) &&
    !vercel.redirects.some(r => r.source === "/store/first-10k"));
  const redirectSources = vercel.redirects.map(r => r.source);
  const SHORT = ["athlevo-plan", "athlevo-coaching", "hybrid-programming", "elite-coaching"];
  t("short links (athlevo.org/athlevo-plan and the other three) redirect, temporarily and in one hop, to the offer page",
    SHORT.every(slug => catalog.getProduct(slug) &&
      vercel.redirects.filter(r => r.source === "/" + slug).length === 1 &&
      vercel.redirects.some(r => r.source === "/" + slug && r.destination === "/programs/" + slug && r.permanent === false) &&
      vercel.rewrites.some(r => r.source === "/programs/" + slug)));
  t("short links collide with nothing: no rewrite, root file or folder uses those paths",
    SHORT.every(slug => !vercel.rewrites.some(r => r.source === "/" + slug || r.source === "/" + slug + "/:path*") &&
      !existsSync("./" + slug) && !existsSync("./" + slug + ".html")));
  t("the local preview server mirrors the short links and keeps the query string (a ?code= link survives)",
    /const SHORT_LINKS = new Set\(\["athlevo-plan", "athlevo-coaching", "hybrid-programming", "elite-coaching"\]\)/.test(readFileSync("./scripts/serve-web.mjs", "utf8")) &&
    /res\.writeHead\(307, \{ location: shortLink \+ url\.search \}\)/.test(readFileSync("./scripts/serve-web.mjs", "utf8")));
  t("the old /store and /store/:slug paths redirect permanently to /programs, after the specific legacy-slug rules",
    vercel.redirects.some(r => r.source === "/store" && r.destination === "/programs" && r.permanent === true) &&
    vercel.redirects.some(r => r.source === "/store/:slug" && r.destination === "/programs/:slug" && r.permanent === true) &&
    legacy.every(([from]) => redirectSources.indexOf("/store/" + from) > -1 && redirectSources.indexOf("/store/" + from) < redirectSources.indexOf("/store/:slug")) &&
    vercel.redirects.filter(r => r.source.startsWith("/store")).every(r => r.permanent === true && r.destination.startsWith("/programs")));

  const sitemap = read("sitemap.xml");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  t("sitemap lists the home page, /programs and each offer, and no old /store URLs",
    locs.join("|") === ["https://athlevo.org/", "https://athlevo.org/programs"].concat(catalog.products.map(p => "https://athlevo.org/programs/" + p.slug)).join("|") &&
    !/athlevo\.org\/store/.test(sitemap) &&
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(sitemap) && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap));
  const robots = read("robots.txt");
  t("robots.txt allows crawling and points to the sitemap",
    /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
    /^Sitemap: https:\/\/athlevo\.org\/sitemap\.xml$/m.test(robots));

  t("the browser keeps title, description, canonical and share tags in step with the route",
    /catalog\.seo\(\)/.test(storefrontSrc) && /catalog\.seo\(product\.slug\)/.test(storefrontSrc) &&
    /meta\[name="description"\]/.test(storefrontSrc) && /link\[rel="canonical"\]/.test(storefrontSrc) &&
    /meta\[property="og:url"\]/.test(storefrontSrc));
  const serveSrc = readFileSync("./scripts/serve-web.mjs", "utf8");
  t("the local preview server serves the same per-offer pages and mirrors the /store redirects",
    /store-pages/.test(serveSrc) && /\.xml/.test(serveSrc) &&
    /pathname === "\/programs"/.test(serveSrc) && /function redirectFor/.test(serveSrc) && /res\.writeHead\(308/.test(serveSrc));
}

section("10. Sign-up on Athlevo Plan, Athlevo Coaching and Elite Coaching (client)");
{
  const signUp = catalog.getProduct("athlevo-plan").page.signUp;
  const { DEFAULT_PAYMONGO_PAYMENT_METHODS } = await import("../lib/server/paymongoClient.js");
  const { SIGNUP_REFERENCE_PATTERN, PLAN_PAGE_PATH, COACHING_PAGE_PATH, ELITE_PAGE_PATH } = await import("../lib/server/planSignup.js");
  const coSignUp = catalog.getProduct("athlevo-coaching").page.signUp;
  const elSignUp = catalog.getProduct("elite-coaching").page.signUp;

  t("each offer has a boolean sign-up switch, and the store-wide purchasing flag stays false (offers open one by one)",
    typeof signUp.open === "boolean" && typeof coSignUp.open === "boolean" && typeof elSignUp.open === "boolean" && catalog.purchasingAvailable === false);
  t("only the three built offers have a sign-up object",
    catalog.products.filter(p => p.page && p.page.signUp).map(p => p.slug).join(",") === "athlevo-plan,athlevo-coaching,elite-coaching");
  t("the store notice and FAQ agree with the switch (the banner is written by the build)",
    (signUp.open || coSignUp.open || elSignUp.open) === !/Purchasing is not yet available/.test(storeHtml) &&
    storeHtml.includes('<div class="notice">' + catalog.notice() + "</div>") &&
    storeHtml.includes(catalog.getFaqs()[0].answer) &&
    ((signUp.open || coSignUp.open || elSignUp.open) ? !/Not yet\. Purchasing is not open/.test(catalog.getFaqs()[0].answer) : catalog.getFaqs()[0].answer === catalog.faqs[0].answer));
  t("the page endpoints are the rewrites the server answers, one pair per offer",
    [signUp, coSignUp, elSignUp].every(su => ["checkoutEndpoint", "statusEndpoint"].every(k => vercel.rewrites.some(r => r.source === su[k]))) &&
    new Set([signUp, coSignUp, elSignUp].map(su => su.checkoutEndpoint)).size === 3 &&
    new Set([signUp, coSignUp, elSignUp].map(su => su.statusEndpoint)).size === 3);
  t("payment copy names exactly the methods the server offers, and never GCash",
    (() => {
      const label = { qrph: "QRPh", grab_pay: "GrabPay", maya: "Maya" };
      return [signUp, coSignUp, elSignUp].every(su =>
        DEFAULT_PAYMONGO_PAYMENT_METHODS.every(m => label[m] && su.payment.includes(label[m])) &&
        DEFAULT_PAYMONGO_PAYMENT_METHODS.length === 3 && !/gcash/i.test(su.payment));
    })());
  t("renewal copy states there is no automatic renewal and promises a reminder",
    [signUp, coSignUp, elSignUp].every(su => /no automatic renewal/.test(su.renewal) && /remind you/.test(su.renewal)));
  t("the no-refund line is the agreement's Section 6 wording, shown before payment",
    [signUp, coSignUp, elSignUp].every(su => su.terms === "All payments to Athlevo are final and non-refundable, to the fullest extent allowed under Philippine law.") &&
    /\[data\.signUp\.payment, data\.signUp\.renewal, data\.signUp\.terms\]/.test(storefrontSrc));
  t("the browser and the server agree on the reference format and the return pages",
    new RegExp(storefrontSrc.match(/var SIGNUP_REF = \/(.+)\/i;/)[1]).source === SIGNUP_REFERENCE_PATTERN.source &&
    PLAN_PAGE_PATH === "/programs/athlevo-plan" && catalog.getProduct("athlevo-plan").slug === "athlevo-plan" &&
    COACHING_PAGE_PATH === "/programs/athlevo-coaching" && catalog.getProduct("athlevo-coaching").slug === "athlevo-coaching" &&
    ELITE_PAGE_PATH === "/programs/elite-coaching" && catalog.getProduct("elite-coaching").slug === "elite-coaching");
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
    // The catalog has exactly one switch per built offer; the fixtures set them explicitly so these
    // tests hold whichever way the shipped catalog has them.
    const SWITCH = /\bopen: (?:true|false),/g;
    t("the catalog has exactly one switch per built offer", (catalogSrc.match(SWITCH) || []).length === 3);
    const setSwitches = (src, planOpen, coachingOpen, eliteOpen = false) => {
      const want = [planOpen, coachingOpen, eliteOpen]; let i = 0;
      return src.replace(SWITCH, () => "open: " + want[i++] + ",");
    };

    // Closed: nothing can be bought, and Sign Up is only an in-page link.
    writeFileSync(join(tmp, "js/storeCatalog.js"), setSwitches(catalogSrc, false, false));
    const closed = Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    t("closed (neither): every page's banner says purchasing is not yet available",
      Object.values(closed).filter(c => c.startsWith("<!DOCTYPE")).every(c =>
        c.includes('<div class="notice">Purchasing is not yet available</div>')));
    t("closed (neither): Plan and Coaching show the registration notice and an in-page Sign Up link, with no buttons",
      ["athlevo-plan", "athlevo-coaching"].every(slug => {
        const html = closed["store-pages/" + slug + ".html"];
        return !/<button class="btn/.test(html) && /Registration opening soon/.test(html) && /href="#how-to-get-started"/.test(html);
      }));
    t("closed (neither): the FAQ still says purchasing is not open", /Not yet\. Purchasing is not open/.test(closed["store-pages/athlevo-plan.html"]));

    const openSrc = setSwitches(catalogSrc, true, false);
    t("the Plan-only fixture opens exactly one switch", (openSrc.match(/\bopen: true,/g) || []).length === 1);
    writeFileSync(join(tmp, "js/storeCatalog.js"), openSrc);
    const files = Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    const plan = files["store-pages/athlevo-plan.html"];
    const buttons = plan.match(/<button class="btn btn-red btn-lg" type="button">Sign Up<\/button>/g) || [];
    t("open: the Plan page has a Sign Up button in the hero and in the pricing card, and no in-page link",
      buttons.length === 2 && !/href="#how-to-get-started"/.test(plan));
    t("open: every page's banner announces the Plan instead of 'purchasing is not yet available'",
      Object.values(files).filter(c => c.startsWith("<!DOCTYPE")).every(c =>
        c.includes('<div class="notice">Athlevo Plan is open for sign-up</div>') && !c.includes('<div class="notice">Purchasing is not yet available</div>')));
    t("open: the registration-opening-soon notice is gone and the payment and renewal note is shown once",
      !/Registration opening soon/.test(plan) && (plan.match(/class="signup-note"/g) || []).length === 1 &&
      plan.includes(signUp.payment) && plan.includes(signUp.renewal) && plan.includes(signUp.terms));
    t("open: the FAQ no longer says purchasing is closed, and other offers are unchanged",
      !/Not yet\. Purchasing is not open/.test(plan) && /Athlevo Plan is open for sign-up/.test(plan) &&
      !/<button class="btn/.test(files["store-pages/athlevo-coaching.html"]) &&
      /Registration opening soon/.test(files["store-pages/athlevo-coaching.html"]) &&
      /href="#how-to-get-started"/.test(files["store-pages/athlevo-coaching.html"]) &&
      /Purchasing not available/.test(files["store-pages/hybrid-programming.html"]));
    t("open: the live regions are in place for progress and errors",
      (plan.match(/class="signup-status" role="status" aria-live="polite"/g) || []).length === 2);
    t("open (Plan only): the Coaching page stays closed and says why",
      !/<button class="btn/.test(files["store-pages/athlevo-coaching.html"]) && !/signup-note/.test(files["store-pages/athlevo-coaching.html"]));

    // Coaching open as well: both pages take sign-ups, the banner names both.
    const bothSrc = setSwitches(catalogSrc, true, true);
    writeFileSync(join(tmp, "js/storeCatalog.js"), bothSrc);
    const both = Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    const coaching = both["store-pages/athlevo-coaching.html"];
    const coButtons = coaching.match(/<button class="btn btn-red btn-lg" type="button">Sign Up<\/button>/g) || [];
    t("open (both): the Coaching page has a Sign Up button in the hero and in the pricing card, and no in-page link",
      coButtons.length === 2 && !/href="#how-to-get-started"/.test(coaching) &&
      (coaching.match(/class="signup-status" role="status" aria-live="polite"/g) || []).length === 2);
    t("open (both): the registration-opening-soon notice is gone and the payment note is shown once, with the no-refund line",
      !/Registration opening soon/.test(coaching) && (coaching.match(/class="signup-note"/g) || []).length === 1 &&
      coaching.includes(coSignUp.payment) && coaching.includes(coSignUp.renewal) && coaching.includes(coSignUp.terms));
    t("open (both): every page's banner names both offers",
      Object.values(both).filter(c => c.startsWith("<!DOCTYPE")).every(c =>
        c.includes('<div class="notice">Athlevo Plan and Athlevo Coaching are open for sign-up</div>') &&
        !c.includes("Purchasing is not yet available</div>")));
    t("open (both): the FAQ names both, and Hybrid Programming and Elite Coaching (switch off) stay closed",
      /Athlevo Plan and Athlevo Coaching are open for sign-up\. The other programs are not available to buy yet\./.test(coaching) &&
      !/<button class="btn/.test(both["store-pages/hybrid-programming.html"]) &&
      !/<button class="btn/.test(both["store-pages/elite-coaching.html"]) &&
      /Purchasing not available/.test(both["store-pages/hybrid-programming.html"]) &&
      /Registration opening soon/.test(both["store-pages/elite-coaching.html"]));
    t("open (both): still no coach named on the Coaching page", !/id="coach"|Meet the Coach/.test(coaching));

    // All three open: the banner and FAQ name all three; Elite takes sign-ups but no code box.
    writeFileSync(join(tmp, "js/storeCatalog.js"), setSwitches(catalogSrc, true, true, true));
    const all3 = Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    const elite = all3["store-pages/elite-coaching.html"];
    t("open (all three): every page's banner names the three offers",
      Object.values(all3).filter(c => c.startsWith("<!DOCTYPE")).every(c =>
        c.includes('<div class="notice">Athlevo Plan, Athlevo Coaching and Elite Coaching are open for sign-up</div>')));
    t("open (all three): the FAQ names the three and says the other program is not available",
      /Athlevo Plan, Athlevo Coaching and Elite Coaching are open for sign-up\. The other program is not available to buy yet\./.test(elite));
    t("open (all three): the Elite page has Sign Up in the hero and the pricing card, shows the price, and has no code box",
      (elite.match(/<button class="btn btn-red btn-lg" type="button">Sign Up<\/button>/g) || []).length === 2 &&
      /₱7,998/.test(elite) && !/name="discount-code"/.test(elite) && !/Have a discount code\?/.test(elite) && !/Registration opening soon/.test(elite) &&
      (elite.match(/class="signup-note"/g) || []).length === 1);
    t("open (all three): Plan and Coaching keep their code box, once per Sign Up button",
      ["athlevo-plan", "athlevo-coaching"].every(slug => (all3["store-pages/" + slug + ".html"].match(/name="discount-code"/g) || []).length === 2));
    t("open (all three): the Elite page names Dean as the coach, with his credentials, and no other price appears on it",
      /Meet the Coach/.test(elite) && elite.includes("Dean Vincent Castro") &&
      catalog.coaches[0].certifications.every(x => elite.includes("<li>" + x + "</li>")) &&
      !/₱1,998|₱4,998/.test(elite.replace(/<[^>]+>/g, " ")));
    t("open (all three): Hybrid Programming is still closed",
      !/<button class="btn/.test(all3["store-pages/hybrid-programming.html"]) && /Purchasing not available/.test(all3["store-pages/hybrid-programming.html"]));

    // Coaching alone (Plan closed): the banner and FAQ name only Coaching.
    const coOnlySrc = setSwitches(catalogSrc, false, true);
    writeFileSync(join(tmp, "js/storeCatalog.js"), coOnlySrc);
    const coOnly = Object.fromEntries(buildStorePages(tmp).map(f => [f.path, f.content]));
    t("open (Coaching only): banner and FAQ name only Coaching, and the Plan page stays closed",
      coOnly["store.html"].includes('<div class="notice">Athlevo Coaching is open for sign-up</div>') &&
      /Athlevo Coaching is open for sign-up\. The other programs/.test(coOnly["store-pages/athlevo-coaching.html"]) &&
      !/<button class="btn/.test(coOnly["store-pages/athlevo-plan.html"]) &&
      /Registration opening soon/.test(coOnly["store-pages/athlevo-plan.html"]) &&
      /<button class="btn btn-red btn-lg"/.test(coOnly["store-pages/athlevo-coaching.html"]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
