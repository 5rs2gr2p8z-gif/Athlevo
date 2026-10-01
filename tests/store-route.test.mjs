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
  t("catalog exposes five draft programs", catalog.products.length === 5);
  const names = catalog.products.map(p => p.name).join("|");
  t("draft names match the approved list",
    names === "First 5K|Faster 5K|First 10K|Half Marathon|Marathon");
  t("durations match the approved list",
    catalog.products.map(p => p.durationWeeks).join(",") === "8,12,12,16,20");
  t("slugs are unique and URL-safe",
    catalog.products.every(p => /^[a-z0-9-]+$/.test(p.slug)) &&
    new Set(catalog.products.map(p => p.slug)).size === 5);
  t("four collections exist",
    catalog.collections.map(c => c.id).join(",") === "5k,10k,half-marathon,marathon");
  t("5K filter returns First 5K and Faster 5K",
    catalog.filterProducts("5k").map(p => p.slug).join(",") === "first-5k,faster-5k");
  t("all filter returns the full catalog",
    catalog.filterProducts("all").length === 5);
  t("purchasingAvailable is false", catalog.purchasingAvailable === false);
}

section("3. No invented commercial claims");
{
  const blob = catalogSrc + storeHtml + storefrontSrc;
  t("no prices, currency, or fake discounts",
    !/\$\d|₱\d|€\d|£\d|%\s*off|discount|was\s*₱|sale price/i.test(blob));
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
    collections: catalog.collections.map(c => ({ name: c.name, headline: c.headline })),
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
    catalog.hero.headline === "A stronger race starts here.");
  t("product pages render duration, audience, intake, and related programs",
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
