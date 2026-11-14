/*
 * Sub-1 10k Challenge (/virtual-run): the page, the form markup, the browser script, the staff page
 * and the routing. The server has its own test (tests/virtual-run-server.test.mjs).
 *
 *   1  built from content/virtualRun.mjs, and up to date
 *   2  the supplied copy (CONTRACT lines), packages, prices and bullets
 *   3  shirt and medal sections, head tags, structured data
 *   4  the form: steps, labels, errors, consent, honeypot, no price field
 *   5  wording rules: honest about the result, no dashes, lowercase k
 *   6  the browser script: markup it relies on, checks, same answers as the server
 *   7  the staff page
 *   8  routing, sitemap and local preview
 *
 * The lines marked CONTRACT are the copy exactly as supplied, repeated here on purpose. To change that
 * wording deliberately, change content/virtualRun.mjs, rebuild, and update the matching CONTRACT line.
 *
 * Run: node tests/virtual-run-page.test.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildAdminPage, buildPage } from "../scripts/build-virtual-run-page.mjs";
import * as c from "../content/virtualRun.mjs";
import { validateRegistration } from "../lib/server/virtualRun.js";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const html = readFileSync("virtual-run.html", "utf8");
const adminHtml = readFileSync("virtual-run-admin.html", "utf8");
const css = readFileSync("virtual-run.css", "utf8");
const script = readFileSync("js/virtualRun.js", "utf8");
const adminScript = readFileSync("js/virtualRunAdmin.js", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const body = (page) => (page.match(/<body[\s\S]*<\/body>/) || [""])[0];
const head = (page) => (page.match(/<head>([\s\S]*?)<\/head>/) || [, ""])[1];
/** The visible text of a page: scripts, comments and tags removed, entities decoded. */
const visible = (page) => decode(body(page).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const strip = (s) => String(s).replace(/\*/g, "");
const ids = (page) => new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const meta = (page, key, attr = "name") => decode((page.match(new RegExp('<meta ' + attr + '="' + key + '" content="([^"]*)"')) || [, null])[1] || "");
const config = JSON.parse(decode((html.match(/<script type="application\/json" id="vr-config">([\s\S]*?)<\/script>/) || [, "{}"])[1]).replace(/\\u003c/g, "<"));
const text = visible(html);

// ---- 1 ----------------------------------------------------------------------------------------
section("1. Built from content/virtualRun.mjs");
{
  t("virtual-run.html is exactly what the builder writes (fix: node scripts/build-virtual-run-page.mjs)", buildPage(html) === html);
  t("virtual-run-admin.html is exactly what the builder writes", buildAdminPage() === adminHtml);
  t("the pasted Meta Pixel block survives a rebuild",
    buildPage(html.replace("<!-- /META PIXEL -->", "<script>/*pixel*/</script>\n  <!-- /META PIXEL -->")).includes("<script>/*pixel*/</script>"));
  t("the page links only the shared storefront styles, its own styles and its own script",
    /href="\/store\.css"/.test(html) && /href="\/virtual-run\.css\?v=[0-9a-f]{8}"/.test(html) && /src="\/js\/virtualRun\.js\?v=[0-9a-f]{8}" defer/.test(html));
  const stamp = (file) => createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 8);
  t("the stylesheet and scripts are addressed by their contents, so a deploy can never pair new markup with a stale cached script (the site's service worker keeps assets)",
    html.includes("/virtual-run.css?v=" + stamp("virtual-run.css")) && html.includes("/js/virtualRun.js?v=" + stamp("js/virtualRun.js")) &&
    adminHtml.includes("/virtual-run.css?v=" + stamp("virtual-run.css")) && adminHtml.includes("/js/virtualRunAdmin.js?v=" + stamp("js/virtualRunAdmin.js")));
  t("fonts are the site's two (Barlow Condensed, Inter) and nothing else", /family=Barlow\+Condensed:wght@700&family=Inter:wght@400\.\.700/.test(html) && !/font-family:[^;]*(Poppins|Roboto|Montserrat)/i.test(css));
  t("only the site's colours are used in the stylesheet",
    [...css.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => m[1].toLowerCase()).every((hex) =>
      hex === "0a0a0b" || hex === "cc0010" || (hex.slice(0, 2) === hex.slice(2, 4) && hex.slice(2, 4) === hex.slice(4, 6)))); // ink, the red (in a comment), and neutral greys
}

// ---- 2 ----------------------------------------------------------------------------------------
section("2. The supplied copy, packages, prices and bullets");
{
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ""])[1].replace(/<[^>]+>/g, "");
  t("CONTRACT: headline 8 WEEKS. ONE GOAL. YOUR FASTEST 10K. (shown in capitals by the stylesheet)", h1.toLowerCase() === "8 weeks. one goal. your fastest 10k." && /\.vr-hero h1[\s\S]*?text-transform: uppercase/.test(css), h1);
  t("CONTRACT: supporting line", text.includes("A structured virtual running challenge designed to help you chase a sub-60-minute 10k."));
  t("CONTRACT: event name ATHLEVO SUB-1 10K CHALLENGE (eyebrow and title)", /Athlevo Sub-1 10k Challenge/i.test(text) && /<title>Athlevo Sub-1 10k Challenge/.test(html));
  t("CONTRACT: the two calls to action, REGISTER NOW and HOW IT WORKS, in the hero",
    /<a class="btn btn-red btn-lg" href="#register"[^>]*>Register now<\/a>/.test(html) && /<a class="btn btn-lg vr-btn-ghost" href="#how-it-works">How it works<\/a>/.test(html));
  t("CONTRACT: the five steps, in order",
    JSON.stringify(c.HOW.steps) === JSON.stringify([
      "Register and select your package.", "Complete your running assessment.", "Follow your 8-week training program.",
      "Run and record your 10k.", "Submit your result and claim your earned rewards."]) &&
    (html.match(/<ol class="vr-steps">([\s\S]*?)<\/ol>/) || [, ""])[1].match(/<li>/g).length === 5);
  t("every step is on the page, numbered 01 to 05", c.HOW.steps.every((s, i) => html.includes('aria-hidden="true">0' + (i + 1) + "</span><p>" + s + "</p>")));

  t("CONTRACT: three packages at ₱399, ₱1,299 and ₱2,499, from the central config",
    c.PACKAGES.map((p) => p.name + "|" + p.priceCents).join(",") === "Digital Challenge|39900,Finisher Kit|129900,Performance Bundle|249900" &&
    ["₱399", "₱1,299", "₱2,499"].every((price) => html.includes('<span class="vr-price-amount">' + price + "</span>")));
  const bullets = {
    digital: ["Official challenge entry", "Standard 8-week training guide", "Digital race bib", "Digital completion certificate", "Challenge leaderboard and result submission"],
    "finisher-kit": ["Everything in Digital Challenge", "Exclusive Athlevo performance shirt", "Official finisher medal", "Shipping included within the stated delivery coverage"],
    "performance-bundle": ["Everything in Finisher Kit", "Personalized 8-week training plan", "Training tailored to fitness, goals, and availability", "Individualized running and strength recommendations"]
  };
  t("CONTRACT: each package's bullets, word for word",
    c.PACKAGES.every((p) => JSON.stringify(p.features) === JSON.stringify(bullets[p.id])) &&
    Object.values(bullets).flat().every((line) => html.includes("<li>" + line + "</li>")));
  t("the three packages are on the page as three cards, the middle one dark", (html.match(/<article class="vr-pkg/g) || []).length === 3 && /<article class="vr-pkg vr-pkg--dark" data-package="finisher-kit">/.test(html));
  const digitalCard = (html.match(/<article class="vr-pkg" data-package="digital">[\s\S]*?<\/article>/) || [""])[0];
  t("the Digital Challenge card does not promise a shirt or medal", digitalCard.length > 200 && !/shirt|medal/i.test(digitalCard));
  t("each card has a Choose button that stays disabled until the server says registration is open", (html.match(/type="button" disabled data-choose="/g) || []).length === 3);
  t("the order of the sections is how it works, results, packages, rewards, register, questions",
    ["how-it-works", "results", "packages", "rewards", "register", "faq"].map((id) => html.indexOf('id="' + id + '"')).every((pos, i, all) => pos > 0 && (i === 0 || pos > all[i - 1])));
  t("dates and the deadline come from the config, and read 'To be announced' until they are confirmed",
    c.EVENT.datesConfirmed === false ? /Challenge dates<\/dt><dd>To be announced/.test(html) && /Registration closes<\/dt><dd>To be announced/.test(html) : true);
}

// ---- 3 ----------------------------------------------------------------------------------------
section("3. Shirt and medal, head tags, structured data");
{
  t("a shirt section and a medal section exist", /id="shirt"/.test(html) && /id="medal"/.test(html) && /Official finisher shirt/i.test(text) && /Official finisher medal/i.test(text));
  t("until artwork is approved they show a labelled placeholder, not an invented product image",
    c.MERCH_ASSETS.shirt === null && c.MERCH_ASSETS.medal === null && (html.match(/vr-visual--placeholder/g) || []).length === 2 && !/<figure class="vr-visual"><img/.test(html));
  t("title, description and canonical", meta(html, "description") === c.PAGE.description && /<link rel="canonical" href="https:\/\/athlevo\.org\/virtual-run">/.test(html));
  t("title is under 70 characters and the description under 170", c.PAGE.title.length <= 70 && c.PAGE.description.length <= 170, c.PAGE.title.length + "/" + c.PAGE.description.length);
  t("Open Graph and Twitter tags", meta(html, "og:title", "property") === c.PAGE.ogTitle && meta(html, "og:url", "property") === "https://athlevo.org/virtual-run" && meta(html, "twitter:title") === c.PAGE.ogTitle);
  t("the page may be indexed", meta(html, "robots") === "index, follow");
  t("exactly one h1", (html.match(/<h1/g) || []).length === 1);
  t("the viewport tag is set, the page has lang=en, and there is a skip link", /name="viewport" content="width=device-width, initial-scale=1"/.test(html) && /<html lang="en">/.test(html) && /class="skip" href="#main"/.test(html));
  t("Event structured data is left out until the dates are confirmed (a wrong date would be worse than none)", c.EVENT.datesConfirmed ? /application\/ld\+json/.test(html) : !/application\/ld\+json/.test(html));
  t("the Meta Pixel spot is there, and the page only sends Purchase from the confirmed-payment path",
    /META PIXEL/.test(html) && !/fbq\(/.test(body(html).replace(/<script type="application\/json"[\s\S]*?<\/script>/, "")) &&
    (script.match(/trackPurchase\(data, ref\);/g) || []).length === 1);
}

// ---- 4 ----------------------------------------------------------------------------------------
section("4. The form");
{
  const form = (html.match(/<form class="vr-form"[\s\S]*?<\/form>/) || [""])[0];
  const pageIds = ids(html);
  t("four steps, with titles from the config", (form.match(/class="vr-step"/g) || []).length === 4 && c.FORM.stepTitles.every((title) => form.includes(">" + title + "<")));
  t("the form is hidden until the server says registration is open, and without JavaScript the page says so", /novalidate hidden/.test(form) && /<noscript><p[^>]*>Registration needs JavaScript/.test(html));
  const labelled = [...form.matchAll(/<(input|select)\s[^>]*id="(vr-[^"]+)"[^>]*>/g)].filter((m) => !/type="radio"|name="contact_website"|type="checkbox"/.test(m[0]));
  t("every text field and select has a visible label tied to it", labelled.length >= 14 && labelled.every((m) => form.includes('<label for="' + m[2] + '"')), labelled.map((m) => m[2]).join(","));
  t("every field has its own hidden error message, wired by id", labelled.every((m) => pageIds.has(m[2] + "-error")) && ["vr-package-error", "vr-rules-error", "vr-privacy-error"].every((id) => pageIds.has(id)));
  t("the contact, running, package and delivery fields the brief asked for are all there",
    ["fullName", "email", "mobile", "dob", "gender", "pb5k", "pb10k", "frequency", "goal", "shirtSize", "recipient", "address", "province", "city", "barangay", "postal"].every((f) => pageIds.has("vr-" + f)));
  t("the three packages are radio options named packageId, with the physical ones marked", (form.match(/name="packageId"/g) || []).length === 3 && (form.match(/data-physical="true"/g) || []).length === 2);
  t("delivery fields sit in their own group that is hidden for the Digital Challenge", /<fieldset class="vr-fieldset vr-delivery" id="vr-delivery" hidden>/.test(form));
  t("the province list has every option from the config, and the shirt sizes too", config.provinces.length === c.PROVINCES.length && config.sizes.join() === c.SHIRT_SIZES.join() && (form.match(/<option value="Pampanga">/g) || []).length === 1);
  t("the rules, waiver and privacy agreements are separate required checkboxes", /id="vr-rules" name="agreeRules"/.test(form) && /id="vr-privacy" name="agreePrivacy"/.test(form));
  t("until the rules and waiver are published their names show as plain text, not as dead links", c.LEGAL.rulesUrl === null ? !/<a [^>]*>official event rules<\/a>/.test(form) && /official event rules/.test(form) : true);
  t("the privacy policy links to the site's page", /<a href="\/privacy" target="_blank">privacy policy<\/a>/.test(form));
  t("the page never carries a price field, a total input or a hidden amount", !/<input[^>]*(name|id)="[^"]*(price|amount|total|cents)/i.test(form));
  t("the spam trap is off screen, out of the tab order and hidden from screen readers", /class="hp" aria-hidden="true"/.test(form) && /tabindex="-1" autocomplete="off"/.test(form) && /\.hp \{ position: absolute; left: -10000px/.test(css));
  t("the form-level error is an alert region and the step counter is a live region", /id="vr-form-error" role="alert"/.test(form) && /id="vr-stepcount" aria-live="polite"/.test(form));
  t("buttons: Back, Continue and the pay button, which is a submit button", /id="vr-back"/.test(form) && /id="vr-next"/.test(form) && /type="submit" id="vr-pay"/.test(form));
  t("the payment note says PayMongo and that the spot is confirmed only when payment is", /PayMongo/.test(text) && /confirmed only when your payment is/i.test(text));
  t("the form posts to the register endpoint and the script is told the same path", /action="\/api\/virtual-run\/register"/.test(form) && config.api.register === "/api/virtual-run/register" && config.api.status === "/api/virtual-run/status" && config.api.availability === "/api/virtual-run/availability");
  t("the confirmation panel exists for the return from payment", ["vr-confirm", "vr-confirm-title", "vr-confirm-facts", "vr-next-steps", "vr-confirm-links", "vr-confirm-retry"].every((id) => pageIds.has(id)));
  t("form controls are at least 16px, so iPhones do not zoom when one is focused", /font: 400 16px\/1\.4 var\(--sans\)/.test(css));
  t("focus is always visible", /focus-visible \{ outline: 2px solid var\(--red\)/.test(css) || (css.match(/focus-visible/g) || []).length >= 6);
  t("motion is short, and it is switched off for people who ask for reduced motion", /@media \(prefers-reduced-motion: reduce\)/.test(css));
}

// ---- 5 ----------------------------------------------------------------------------------------
section("5. Wording rules");
{
  const everything = { "content": readFileSync("content/virtualRun.mjs", "utf8"), "page": html, "admin page": adminHtml, "css": css, "script": script, "admin script": adminScript };
  for (const [name, source] of Object.entries(everything)) {
    t("no em or en dashes in the " + name, !/[–—]/.test(source));
  }
  t("a 10k is written with a lowercase k wherever it is read (the headline is capitalised by CSS only)", !/10K/.test(text.replace(/8 WEEKS\. ONE GOAL\. YOUR FASTEST 10K\./, "")) && !/10K/.test(JSON.stringify(c.HERO) + JSON.stringify(c.HOW) + JSON.stringify(c.RESULTS) + JSON.stringify(c.FAQ)));
  const claims = /(guaranteed (to|sub|finish)|guarantees? (you|a sub)|you will (run|finish|break|hit) (under|sub|sub-)|will get you (under|sub|to)|sure to|no limits|unlock|revolutionary|crush it|last chance|only \d+ spots?|selling fast|hurry)/i;
  t("no guarantee, urgency or hype language anywhere on the page", !claims.test(text), (text.match(claims) || [])[0]);
  t("the page says plainly that a sub-60 time is not promised", /cannot promise a sub-60 time/i.test(text) && /does not promise it/i.test(text));
  t("finishing a 10k and a verified sub-60 result are separate things", /Finisher/.test(text) && /Run a 10k in under 60:00/.test(text) && /verified against the official event rules/i.test(text) && /Verified Sub-1 finishers also earn a Sub-1 certificate/.test(text));
  t("the FAQ answers 'Is a sub-60 10k guaranteed?' with a no", /Is a sub-60 10k guaranteed\?<\/summary><p>No/.test(html));
  t("red is for the one key word or the button: the stylesheet uses var(--red) and var(--red-on-dark), never a second red", !/#(c0|d0|e0|ff)[0-9a-f]{4}/i.test(css));
  t("the confirmation wording never says 'confirmed' before the server has said so", !/confirmed/i.test(JSON.stringify(c.CONFIRMATION.checking)) && !/confirmed/i.test(JSON.stringify(c.CONFIRMATION.pending.heading)));
}

// ---- 6 ----------------------------------------------------------------------------------------
section("6. The browser script");
{
  const pageIds = ids(html);
  const wanted = [...script.matchAll(/(?:byId|doc\.getElementById)\("([^"]+)"\)/g)].map((m) => m[1]);
  const dynamic = new Set(["vr-package-", "vr-step-"]); // built from an id or a step number
  const missing = [...new Set(wanted)].filter((id) => !pageIds.has(id) && !dynamic.has(id));
  t("every element id the script looks up exists on the page", missing.length === 0, missing.join(","));
  t("the script builds markup only with textContent and createElement, never innerHTML or eval", !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(script + adminScript));
  t("the script holds none of the page's wording (it comes from the embedded config)", !/Register now|Pay and register|Choose a package|Enter your full name/.test(script));
  t("the checkout redirect only follows an https URL from the server", /\/\^https:\\\/\\\/\/i\.test\(data\.checkout_url\)/.test(script));
  t("the confirmation is built from the status call only: there is no path to 'paid' from the URL alone", /showPaid\(data, ref\)/.test(script) && !/payment=success[^;]*showPaid/.test(script) && (script.match(/showPaid\(/g) || []).length === 2);

  const sandbox = { window: undefined };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const api = sandbox.AthlevoVirtualRun;
  t("the script exposes its checks for testing without touching a page", api && typeof api.validate === "function" && typeof api.parseRaceTime === "function");
  const now = new Date("2026-11-14T04:00:00Z");
  t("race times: 24:30, 1:05:00 and 9:59 parse; 9:99, 24 and text do not",
    api.parseRaceTime("24:30") === 1470 && api.parseRaceTime("1:05:00") === 3900 && api.parseRaceTime("9:59") === 599 && api.parseRaceTime("9:99") === null && api.parseRaceTime("24") === null && api.parseRaceTime("fast") === null);
  t("age is counted on the Manila calendar", api.ageOn("2008-11-14", now) === 18 && api.ageOn("2008-11-15", now) === 17 && api.ageOn("2026-02-30", now) === null);
  t("the 10k and 5k personal-best bounds match the server",
    api.validate(base({ pb10k: "20:00" }), config, now).pb10k && !api.validate(base({ pb10k: "25:00" }), config, now).pb10k && api.validate(base({ pb5k: "11:59" }), config, now).pb5k && !api.validate(base({ pb5k: "12:00" }), config, now).pb5k);

  // The same answers as the server, field by field.
  function base(over = {}) {
    return {
      fullName: "Maria Santos", email: "maria@example.com", mobile: "0917 123 4567", dob: "1990-05-20", gender: "female",
      pb5k: "29:30", pb10k: "1:05:00", frequency: "3", goal: "sub-60", packageId: "finisher-kit",
      shirtSize: "M", recipient: "Maria Santos", address: "123 Rizal Street", province: "Pampanga", city: "Floridablanca", barangay: "San Jose", postal: "2006",
      agreeRules: true, agreePrivacy: true, ...over
    };
  }
  const cases = [
    {}, { fullName: "M" }, { fullName: "  " }, { email: "nope" }, { email: "a@b" }, { email: "a b@c.com" }, { email: "x".repeat(260) + "@e.com" },
    { mobile: "123" }, { mobile: "+63 917 123 4567" }, { mobile: "09171234567890123" }, { dob: "" }, { dob: "2008-11-14" }, { dob: "2008-11-15" }, { dob: "2026-02-30" }, { dob: "1900-01-01" }, { dob: "2030-01-01" },
    { gender: "robot" }, { gender: "" }, { pb5k: "" }, { pb5k: "5:00" }, { pb5k: "95:00" }, { pb5k: "abc" }, { pb10k: "" }, { pb10k: "24:59" }, { pb10k: "3:00:01" },
    { frequency: "9" }, { frequency: "" }, { goal: "win" }, { packageId: "" }, { packageId: "gold" }, { packageId: "digital", shirtSize: "", address: "", city: "", postal: "" },
    { shirtSize: "XXL" }, { recipient: "" }, { address: "12" }, { province: "Atlantis" }, { province: "" }, { city: "x" }, { barangay: "" }, { postal: "200" }, { postal: "20x6" },
    { agreeRules: false }, { agreePrivacy: false }, { agreeRules: "true" }, { agreeRules: 1 }
  ];
  const mismatches = [];
  for (const over of cases) {
    const values = base(over);
    const client = api.validate(values, config, now);
    const server = validateRegistration(values, { now });
    const serverFields = server.ok ? {} : server.fields;
    const a = JSON.stringify(Object.keys(client).sort());
    const b = JSON.stringify(Object.keys(serverFields).sort());
    if (a !== b) mismatches.push(JSON.stringify(over) + " client " + a + " server " + b);
    else if (Object.keys(client).some((k) => client[k] !== serverFields[k])) mismatches.push(JSON.stringify(over) + " codes differ");
  }
  t("the browser checks and the server checks accept and refuse the same " + cases.length + " submissions, with the same messages", mismatches.length === 0, mismatches.slice(0, 3).join(" ; "));
  t("the payload code sends no price, total or amount", !/priceCents|amountCents|total:|amount:/.test((script.match(/function payload[\s\S]*?\n  \}/) || [""])[0]));
}

// ---- 7 ----------------------------------------------------------------------------------------
section("7. The staff page");
{
  t("the staff page is not indexed and sends no referrer", /<meta name="robots" content="noindex, nofollow, noarchive">/.test(adminHtml) && /<meta name="referrer" content="no-referrer">/.test(adminHtml));
  t("it holds no registration data and no secret: only the public sign-in values the app already ships",
    /data-supabase-key="sb_publishable_/.test(adminHtml) && !/service_role|SERVICE_ROLE|sk_(live|test)|whsec_/.test(adminHtml + adminScript) && readFileSync("index.html", "utf8").includes("sb_publishable_KxbACTdnsHG_uFNAV01bfA_NGkW-PCt"));
  t("the sign-in values are the ones the app uses (same project and storage key)", /hqwdehqsllyvrcnlcytj\.supabase\.co/.test(adminHtml) && /sb-hqwdehqsllyvrcnlcytj-auth-token/.test(adminHtml));
  t("filters cover package, payment status, search and 'to ship'", ["vra-package", "vra-state", "vra-search", "vra-fulfillment"].every((id) => ids(adminHtml).has(id)));
  t("package options come from the config", c.PACKAGES.every((p) => adminHtml.includes('<option value="' + p.id + '">' + p.name + "</option>")));
  t("there is an Export CSV button and a Refresh button", /id="vra-export"/.test(adminHtml) && /id="vra-refresh"/.test(adminHtml));
  const wanted = [...adminScript.matchAll(/doc\.getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  t("every element id the staff script looks up exists", wanted.every((id) => ids(adminHtml).has(id)), wanted.filter((id) => !ids(adminHtml).has(id)).join(","));
  t("the staff script never writes to the app's stored session", !/localStorage\.(setItem|removeItem)/.test(adminScript) && /sessionStorage\.setItem/.test(adminScript));

  const sandbox = { window: undefined };
  vm.createContext(sandbox);
  vm.runInContext(adminScript, sandbox);
  const admin = sandbox.AthlevoVirtualRunAdmin;
  t("staff helpers: pesos, Manila time and the filter query string",
    admin.formatPeso(129900) === "₱1,299" && /Nov 2026|2026/.test(admin.formatMoment("2026-11-20T03:00:00Z")) && /1[01]:00/.test(admin.formatMoment("2026-11-20T03:00:00Z")) &&
    admin.queryString({ package: "digital", status: "paid", q: "ma", fulfillment: true }, { format: "csv" }) === "?package=digital&status=paid&q=ma&fulfillment=1&format=csv" &&
    admin.queryString({ package: "all", status: "all", q: "m", fulfillment: false }) === "");
}

// ---- 8 ----------------------------------------------------------------------------------------
section("8. Routing, sitemap and the local preview");
{
  const rewrite = (source) => vercel.rewrites.find((r) => r.source === source);
  t("/virtual-run and /virtual-run/ serve the page, on every host (so previews work)", ["/virtual-run", "/virtual-run/"].every((s) => rewrite(s) && rewrite(s).destination === "/virtual-run.html" && !rewrite(s).has));
  t("/virtual-run/admin (with or without the slash) serves the staff page", ["/virtual-run/admin", "/virtual-run/admin/"].every((s) => rewrite(s) && rewrite(s).destination === "/virtual-run-admin.html"));
  t("the four API paths go to the one gateway function (the host plan allows 12 functions)",
    ["register", "status", "availability", "admin"].every((a) => rewrite("/api/virtual-run/" + a) && rewrite("/api/virtual-run/" + a).destination === "/api/providers?action=virtual_run_" + a));
  const catchAll = vercel.redirects.find((r) => /^\/:path\(/.test(r.source) && r.has && r.has.some((h) => h.value === "programs.athlevo.org"));
  t("the programs site does not keep /virtual-run: it sends it to athlevo.org, where the page lives", catchAll && !/virtual-run/.test(catchAll.source) && catchAll.destination === "https://athlevo.org/:path");
  t("no redirect sends /virtual-run away from athlevo.org", !vercel.redirects.some((r) => /^\/virtual-run/.test(r.source) && r.has && r.has.some((h) => h.value === "athlevo.org")));
  const sitemap = readFileSync("sitemap.xml", "utf8");
  t("the sitemap lists the page", sitemap.includes("<loc>https://athlevo.org/virtual-run</loc>"));
  const serve = readFileSync("scripts/serve-web.mjs", "utf8");
  t("the local preview server serves the page and the staff page", /\/virtual-run-admin\.html/.test(serve) && /"\/virtual-run\.html"/.test(serve));
  const gateway = readFileSync("api/providers/index.js", "utf8");
  t("the gateway handles all four actions", ["register", "status", "availability", "admin"].every((a) => gateway.includes("virtual_run_" + a)));
  const worker = readFileSync("service-worker.js", "utf8");
  t("the service worker does not treat /virtual-run as the app shell (it would overwrite the cached app with this page)", /!\/\^\\\/\(programs\|store\|landing-preview\|virtual-run\)\(\\\/\|\$\)\/\.test\(navPath\)/.test(worker));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  t("package.json has the build and test scripts", /build-virtual-run-page/.test(pkg.scripts["build:virtual-run"] || "") && /virtual-run-page\.test/.test(pkg.scripts["test:virtual-run"] || "") && /virtual-run-server\.test/.test(pkg.scripts["test:virtual-run"] || ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
