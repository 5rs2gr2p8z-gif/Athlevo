/**
 * Athlevo /store program storefront contract.
 *
 * Run: node tests/store-route.test.mjs
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import vm from "node:vm";

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
  t("vercel rewrites /store to store.html",
    vercel.rewrites.some(r => r.source === "/store" && r.destination === "/store.html"));
  t("vercel rewrites /store/:slug to store.html",
    vercel.rewrites.some(r => r.source === "/store/:slug" && r.destination === "/store.html"));
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
  t("each card keeps its current photo",
    [["athlevo-plan", "/assets/store/track-1280.webp"],
     ["athlevo-coaching", "/assets/store/road-1280.webp"],
     ["hybrid-programming", "/assets/store/founder-1145.webp"],
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
  t("only Athlevo Plan has a built page; the other offers stay bare",
    !!catalog.getProduct("athlevo-plan").page &&
    catalog.products.filter(p => p.slug !== "athlevo-plan").every(p =>
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
  const withoutConfirmedPrice = blob.split("₱1,998").join("");
  t("no prices, currency, or fake discounts beyond the confirmed ₱1,998",
    !/\$\d|₱\d|€\d|£\d|%\s*off|discount|was\s*₱|sale price|\bfees?\b|free trial|coupon/i.test(withoutConfirmedPrice));
  t("the confirmed ₱1,998 price lives only in the Athlevo Plan page data",
    catalogSrc.split("₱1,998").length - 1 === 1 &&
    !storeHtml.includes("₱") && !storefrontSrc.includes("₱") &&
    catalog.getProduct("athlevo-plan").page.price.amount === "₱1,998" &&
    catalog.products.filter(p => p.slug !== "athlevo-plan").every(p => !JSON.stringify(p).includes("₱")));
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
  t("notice states purchasing is not yet available",
    /Purchasing is not yet available/.test(storeHtml));
  t("nav includes Athlevo, Programs, FAQ",
    /wordmark[\s\S]*Athlevo/.test(storeHtml) &&
    /href="\/store#programs">Programs</.test(storeHtml) &&
    /href="\/store#faq">FAQ</.test(storeHtml) &&
    !/How It Works/.test(storeHtml));
  t("skip link is present", /Skip to main content/.test(storeHtml));
  t("hero headline is in the catalog source",
    catalog.hero.headline === "Training built around you.");
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
  t("no checkout, payment, or signup activation",
    !/<form/i.test(bodyOnly) &&
    !/openSignup|openLogin|checkout|paymongo|whop|storekit/i.test(storeHtml + storefrontSrc));
}

section("4b. Catalog page structure");
{
  t("catalog page has a short intro", typeof catalog.intro === "string" && catalog.intro.length > 20 && catalog.intro.length < 240);
  t("hero is a clean photo with no overlaid text",
    !/hero-copy/.test(storefrontSrc + css));
  t("mobile nav uses a hamburger icon button",
    /class="nav-toggle"[^>]*aria-label="Menu"[\s\S]*class="bars"/.test(storeHtml));
  t("catalog page renders hero, intro, program cards, and FAQ",
    /\$\("section", "hero"\)/.test(storefrontSrc) &&
    /\$\("section", "intro"\)/.test(storefrontSrc) &&
    /program-grid/.test(storefrontSrc) &&
    /id = "faq"/.test(storefrontSrc));
  t("program cards link to /store/:slug and show only the name",
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
  const INTRO = "Personalized running and strength programming built around your goals, schedule, and current fitness.";
  const META = "Explore Athlevo Plan, Athlevo Coaching, Hybrid Programming, and Elite Coaching. Find training support that fits your goals.";
  const metaMatch = storeHtml.match(/<meta name="description" content="([^"]*)">/);
  t("headline matches the approved copy", catalog.hero.headline === "Training built around you.");
  t("intro matches the approved copy", catalog.intro === INTRO, catalog.intro);
  t("meta description matches the approved copy", !!metaMatch && metaMatch[1] === META, metaMatch && metaMatch[1]);
  t("unused hero lede (old coach-review claim) is gone", !("lede" in catalog.hero));
  const sharedCopy = [catalog.hero.headline, catalog.intro, metaMatch ? metaMatch[1] : "",
    ...catalog.faqs.flatMap(f => [f.question, f.answer])].join("\n");
  t("shared copy has no distance choice, race ladder, or former-product wording",
    !/\b(5k|10k|half[- ]marathon|marathon|distances?|choose your|first 5k|faster 5k|ladder)\b/i.test(sharedCopy + "\n" + bodyOnly + "\n" + storefrontSrc),
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
  t("monthly reviews belong to Plan; weekly reviews belong to Athlevo Coaching",
    /includes a monthly review/.test(page.overview.note) &&
    /Weekly reviews are part of Athlevo Coaching/.test(page.overview.note) &&
    !/weekly/i.test(JSON.stringify(page.overview.includes) + JSON.stringify(page.pricing)));

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

  t("how to get started: four steps, registration-opening-soon notice",
    JSON.stringify(page.getStarted.steps) === JSON.stringify([
      "Sign up and complete payment.",
      "Fill out the intake form with your fitness, goals, schedule, and equipment.",
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
  t("offer page collects no input and has no checkout",
    !/\$\("(form|input|textarea|select|button)"|createElement\("(form|input|textarea|select)"\)/.test(storefrontSrc));
  t("other offers still use the shared bare product layout",
    /if \(product\.page\) \{\s*root\.appendChild\(renderOfferPage\(product\)\);\s*return;\s*\}/.test(storefrontSrc) &&
    /function appendFaqAndRelated/.test(storefrontSrc));
}

section("5. Client routing");
{
  t("storefront reads /store and /store/:slug",
    storefrontSrc.includes('path === "/store"') &&
    storefrontSrc.includes("/store/") &&
    storefrontSrc.includes("([^/]+)"));
  t("history API is used for in-store navigation",
    /history\.pushState/.test(storefrontSrc) && /popstate/.test(storefrontSrc));
}

section("6. App shell and service worker isolation");
{
  t("initializeAthlevoApp still treats /ai and root as Coach entry",
    /aiPath === "\/ai" \|\| aiPath === "" \|\| aiPath === "\/signup" \|\| aiPath === "\/ai-signup"/.test(indexHtml));
  t("store navigations are not written into the app-shell cache",
    /isAppShellNav/.test(sw) &&
    /\/\(store\|landing-preview\)/.test(sw));
  t("storefront uses Space Grotesk display type and the Athlevo red accent",
    /Space\+Grotesk/.test(storeHtml) && /--display:\s*"Space Grotesk"/.test(css) && /--red: #c0272d/.test(css));
}

section("7. Responsive storefront images");
{
  const heroWebp = statSync("./assets/store/training-1206.webp").size;
  t("catalog photos keep original sources on disk",
    existsSync("./assets/landing/athlete-philosophy-training.png") &&
    existsSync("./assets/landing/hero-athlevo.png") &&
    existsSync("./assets/landing/dean-founder.png"));
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

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
