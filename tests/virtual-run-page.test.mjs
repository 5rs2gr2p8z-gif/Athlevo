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
 *   9  registration opening soon, the priority list, and the event dates
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
  // The supplied copy had REGISTER NOW as the first button. Until registration opens the built page says "Join the
  // priority list" there (section 9), and the script puts REGISTER NOW back, from the config, when the server says open.
  t("CONTRACT: the two calls to action, REGISTER NOW (once registration is open) and HOW IT WORKS, in the hero",
    c.HERO.primary === "Register now" && config.modes.register.cta === "Register now" && config.modes.register.href === "#register" &&
    /<a class="btn btn-lg vr-btn-ghost" href="#how-it-works">How it works<\/a>/.test(html));
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
  t("the order of the sections is the priority list, how it works, results, packages, rewards, register, questions",
    ["waitlist", "how-it-works", "results", "packages", "rewards", "register", "faq"].map((id) => html.indexOf('id="' + id + '"')).every((pos, i, all) => pos > 0 && (i === 0 || pos > all[i - 1])));
  t("dates come from the config, and read 'Dates to Be Announced' until they are confirmed",
    c.EVENT.datesConfirmed === false ? /Challenge dates<\/dt><dd>Dates to Be Announced<\/dd>/.test(html) : true);
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

  // The secret registration reference comes back in the address after payment. Nothing that reads the address
  // (an analytics pixel above all) may see it, so the page's first script moves it out before any pixel runs.
  const headHtml = head(html);
  const firstScript = (headHtml.match(/<script>([\s\S]*?)<\/script>/) || [, ""])[1];
  t("a script that moves the reference out of the address runs in the head before the Meta Pixel spot",
    /ref=/.test(firstScript) && /replaceState/.test(firstScript) && headHtml.indexOf(firstScript) < headHtml.indexOf("META PIXEL"));
  const REF = "ATH-VR-0123456789ABCDEF-" + "A1B2C3D4".repeat(3);
  function arrive(search, hash = "") {
    const stored = {};
    const state = { search, hash, pathname: "/virtual-run" };
    const box = {
      location: state, sessionStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => (k in stored ? stored[k] : null) },
      history: { replaceState: (a, b, url) => { const q = String(url).indexOf("?"); const h = String(url).indexOf("#"); state.search = q < 0 ? "" : String(url).slice(q, h < 0 ? undefined : h); } }
    };
    vm.createContext(box);
    vm.runInContext(firstScript, box);
    return { search: state.search, stored };
  }
  const back = arrive("?payment=success&ref=" + REF);
  t("coming back from payment: the reference leaves the address and is kept for this tab only", !/ref=/.test(back.search) && /payment=success/.test(back.search) && back.stored["athlevo.vr.ref"] === REF);
  const mixed = arrive("?package=finisher-kit&payment=success&ref=" + REF + "&utm_source=x");
  t("other parameters are left exactly as they were", mixed.search === "?package=finisher-kit&payment=success&utm_source=x", mixed.search);
  const cancelled = arrive("?payment=cancelled&ref=" + REF);
  t("a cancelled return drops the reference and stores nothing", !/ref=/.test(cancelled.search) && Object.keys(cancelled.stored).length === 0);
  t("an ordinary visit is left alone", arrive("?package=digital").search === "?package=digital" && arrive("").search === "");
  t("the browser script reads the reference from this tab's storage when the address no longer carries it",
    /getItem\("athlevo\.vr\.ref"\)/.test(script) && /payment === "success" && !REFERENCE\.test\(ref\)/.test(script));
  const purchase = (script.match(/function trackPurchase[\s\S]*?\n  \}/) || [""])[0];
  t("the Meta Pixel purchase is identified by the public registration id, never the secret reference",
    /eventID: purchaseId/.test(purchase) && /data\.registration_id/.test(purchase) && !/eventID: ref/.test(purchase) && !/"athlevo\.vr\.pixel\." \+ ref/.test(purchase));
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
  t("the service worker does not treat /virtual-run as the app shell (it would overwrite the cached app with this page)", /!\/\^\\\/\(programs\|store\|landing-preview\|virtual-run(?:\|lessons)?\)\(\\\/\|\$\)\/\.test\(navPath\)/.test(worker));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  t("package.json has the build and test scripts", /build-virtual-run-page/.test(pkg.scripts["build:virtual-run"] || "") && /virtual-run-page\.test/.test(pkg.scripts["test:virtual-run"] || "") && /virtual-run-server\.test/.test(pkg.scripts["test:virtual-run"] || ""));
}


// ---- 9 ----------------------------------------------------------------------------------------
section("9. Registration opening soon, the priority list, and the event dates");
{
  const wl = c.WAITLIST;
  const wlSection = (html.match(/<section[^>]*id="waitlist"[\s\S]*?<\/section>/) || [""])[0];
  const registerSection = (html.match(/<section[^>]*id="register"/) || [""])[0];

  // ---- the state the page is built in
  t("the page is built in its 'opening soon' state, which is what anyone without JavaScript sees", /<body class="vr" data-mode="soon">/.test(html));
  t("the registration section is marked as registration-only and the priority list as soon-only", /vr-only-register/.test(registerSection) && /vr-only-soon/.test(wlSection));
  t("the styles hide the registration section while the page is 'soon', and the priority list once it is not",
    /\.vr\[data-mode="soon"\] \.vr-only-register \{ display: none !important; \}/.test(css) && /\.vr:not\(\[data-mode="soon"\]\) \.vr-only-soon \{ display: none !important; \}/.test(css));
  t("a leave link keeps the priority list panel on screen in any state", /\.vr\[data-leave\] #waitlist \{ display: block !important; \}/.test(css));
  t("the priority list comes straight after the hero, before 'How it works'", html.indexOf('id="waitlist"') > html.indexOf("</section>") && html.indexOf('id="waitlist"') < html.indexOf('id="how-it-works"'));
  t("the hero says registration is opening soon and its button joins the priority list",
    new RegExp('class="vr-soon-badge[^"]*"[^>]*>.*?' + c.HERO.soon.badge).test(html) &&
    new RegExp('<a class="btn btn-red btn-lg" href="#waitlist" id="vr-hero-register">' + c.HERO.soon.primary + "</a>").test(html));
  t("the header button is 'Join the list' and goes to the priority list", new RegExp('id="vr-nav-cta" href="#waitlist">' + c.HERO.soon.nav + "</a>").test(html));
  t("the built page never says 'Register now' while registration is not open", !/Register now/i.test(text));
  t("each package card offers the priority list instead of a dead button", (html.match(/class="btn btn-red vr-pkg-soon vr-only-soon" href="#waitlist"/g) || []).length === 3 &&
    (html.match(/vr-choose vr-only-register/g) || []).length === 3);
  t("the page can be found: indexable, canonical, in the sitemap, and the description holds no date",
    /index, follow/.test(meta(html, "robots")) && !/noindex/i.test(head(html)) && !/\b20(26|27)\b/.test(meta(html, "description") + meta(html, "og:description", "property")));
  t("the registration form and its payment button are in the page but start hidden", /<form class="vr-form" id="vr-form"[^>]*\bhidden\b/.test(html));

  // ---- dates
  const MONTHS = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(,\s*\d{4})?\b/;
  if (c.EVENT.datesConfirmed === false) {
    t("with dates unconfirmed, the hero and the FAQ say 'Dates to Be Announced' and no calendar date appears anywhere on the page",
      text.includes("Dates to Be Announced") && !MONTHS.test(text) && !/\b2027\b/.test(text) && /<summary>When is the challenge\?<\/summary><p>Dates to Be Announced\./.test(html));
    t("the hero's second fact is 'Registration: Opening soon', not an invented closing date", /<dt>Registration<\/dt><dd>Opening soon<\/dd>/.test(html) && !/Registration closes/.test(text));
    t("no search-engine event data is published until the dates are real", !/application\/ld\+json/.test(html) && !/startDate/.test(html));
    t("nothing on the page says 'To be announced' in its old wording", !/To be announced|to be announced/.test(text));
  }
  t("the dates live in one block of one file: no other source file holds a challenge date",
    ["scripts/build-virtual-run-page.mjs", "js/virtualRun.js", "js/virtualRunAdmin.js", "lib/server/virtualRun.js", "lib/server/virtualRunWaitlist.js", "lib/server/virtualRunPayments.js",
      "lib/server/virtualRunAdmin.js", "lib/server/paymongoWebhookEndpoint.js", "virtual-run.css", "virtual-run.html"]
      .every((f) => !/2026-12-01|2027-01-25|December 1\b|January 25\b|Dec 1\b|Jan 25\b/.test(readFileSync(f, "utf8"))));

  const event = { ...c.EVENT, datesConfirmed: true, startDate: "2026-12-01", endDate: "2027-01-25" };
  const registration = { ...c.REGISTRATION, opensAt: "2026-11-20T09:00:00+08:00", deadline: "2026-11-30T23:59:00+08:00" };
  t("confirmed dates read as a range, and an incomplete set still reads 'Dates to Be Announced'",
    c.eventDatesText(event) === "December 1, 2026 to January 25, 2027" && c.eventDatesText({ ...event, datesConfirmed: false }) === c.DATES_TBA &&
    c.eventDatesText({ ...event, endDate: null }) === c.DATES_TBA && c.DATES_TBA === "Dates to Be Announced");
  t("the deadline reads 'Date to Be Announced' until one is set", c.deadlineText({ deadline: null }) === "Date to Be Announced" && /November 30, 2026/.test(c.deadlineText(registration)));
  t("the hero's second fact turns into the closing date only when the dates are confirmed and a deadline is set",
    c.registrationFact(event, registration).label === "Registration closes" && /November 30, 2026/.test(c.registrationFact(event, registration).value) &&
    c.registrationFact({ ...event, datesConfirmed: false }, registration).value === "Opening soon" && c.registrationFact(event, { ...registration, deadline: null }).value === "Opening soon");
  t("the FAQ answer gives the dates once confirmed, and the honest answer before",
    /December 1, 2026 to January 25, 2027/.test(c.startAnswer(event)) && /^Dates to Be Announced\./.test(c.startAnswer({ ...event, datesConfirmed: false })) && /priority list/.test(c.startAnswer({ ...event, datesConfirmed: false })));
  t("nothing is checked while the dates are unconfirmed, and good dates have no problems", c.eventDateProblems({ ...event, datesConfirmed: false, startDate: "junk" }, registration).length === 0 && c.eventDateProblems(event, registration).length === 0);
  const problem = (over, reg = registration) => c.eventDateProblems({ ...event, ...over }, reg).join(" | ");
  t("dates that are not real days are refused", /startDate must be a real day/.test(problem({ startDate: "2026-02-30" })) && /endDate must be a real day/.test(problem({ endDate: "soon" })) && /startDate must be a real day/.test(problem({ startDate: null })));
  t("an end before the start, or a span that is not exactly the number of weeks, is refused", /after EVENT\.startDate/.test(problem({ endDate: "2026-11-01" })) && /cover 49 days, but the page says 8 weeks \(56 days\)/.test(problem({ endDate: "2027-01-18" })));
  t("a deadline after the challenge ends, or an opening time after the deadline, is refused",
    /before the challenge ends/.test(problem({}, { ...registration, deadline: "2027-02-01T00:00:00+08:00" })) && /opensAt must be before/.test(problem({}, { ...registration, opensAt: "2026-12-05T00:00:00+08:00" })) &&
    /not a date and time/.test(problem({}, { ...registration, deadline: "next week" })));

  // Change the dates in the one place and everything follows; change them wrongly and the page will not build.
  const keep = { event: { ...c.EVENT }, registration: { ...c.REGISTRATION } };
  try {
    Object.assign(c.EVENT, event);
    Object.assign(c.REGISTRATION, registration);
    const confirmed = buildPage(html);
    const confirmedText = visible(confirmed);
    t("confirm the dates in content/virtualRun.mjs and the hero shows them, with the closing date",
      /Challenge dates<\/dt><dd>December 1, 2026 to January 25, 2027<\/dd>/.test(confirmed) && /Registration closes<\/dt><dd>November 30, 2026/.test(confirmed) && !/Dates to Be Announced<\/dd>/.test(confirmed));
    const ld = JSON.parse(((confirmed.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [, "{}"])[1]).replace(/\\u003c/g, "<"));
    t("...and the search-engine event data appears, with the same dates", ld["@type"] === "Event" && ld.startDate === "2026-12-01" && ld.endDate === "2027-01-25");
    t("...with no leftover 'Dates to Be Announced' in the hero", !/Challenge dates<\/dt><dd>Dates to Be Announced/.test(confirmed) && /December 1, 2026/.test(confirmedText));
    c.EVENT.endDate = "2027-01-18";
    let message = "";
    try { buildPage(html); } catch (error) { message = String(error && error.message); }
    t("dates that do not add up stop the build, and the message says what to fix", /need fixing/.test(message) && /49 days/.test(message), message);
  } finally {
    Object.assign(c.EVENT, keep.event);
    Object.assign(c.REGISTRATION, keep.registration);
  }
  t("and the shipped dates are back to what they were after that check", buildPage(html) === html);

  // ---- the priority list form
  const form = (wlSection.match(/<form[\s\S]*?<\/form>/) || [""])[0];
  const names = [...form.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  t("the form asks for a name and an email, and nothing else a person could mind giving (plus the consent box and the spam trap)",
    JSON.stringify(names) === JSON.stringify(["fullName", "email", "consent", "contact_website"]), names.join(","));
  t("the form posts to the priority list API and works through the script, not through a plain page post", new RegExp('action="' + c.SITE.waitlistApi + '"').test(form) && /novalidate/.test(form) && c.SITE.waitlistApi === "/api/virtual-run/waitlist");
  t("the consent box starts unticked and says what the person agrees to, with the privacy policy linked",
    !/id="vr-wl-consent"[^>]*checked/.test(form) && form.includes("Email me about the Athlevo Sub-1 10k Challenge, including when registration opens. I can unsubscribe at any time.") &&
    new RegExp('<a href="' + c.LEGAL.privacyUrl + '"[^>]*>privacy policy</a>').test(form));
  t("the name and email fields have the right autofill and input types", /name="fullName" type="text" autocomplete="name"/.test(form) && /name="email" type="email" inputmode="email" autocomplete="email"/.test(form));
  t("the spam trap is a hidden, unlabelled-to-people field, and the form has an error line and a submit button",
    /class="hp" aria-hidden="true"/.test(form) && /id="vr-wl-form-error" role="alert"/.test(form) && /type="submit" id="vr-wl-submit">Join the priority list</.test(form));
  t("the sign-up says nothing is charged, and promises no place, price or date",
    /Nothing to pay now/.test(wlSection) && !/guarantee|spots? (is|are) limited|hurry|last chance|only \d+/i.test(wlSection));
  t("after joining, the person sees a confirmation panel and the leave panel exists for the e-mail link",
    /id="vr-wl-done"/.test(wlSection) && /id="vr-wl-leave"/.test(wlSection) && /id="vr-wl-leave-confirm"/.test(wlSection) && /id="vr-wl-leave-cancel"/.test(wlSection));
  t("without JavaScript the sign-up form says so and gives an email address", /<noscript>[^]*needs JavaScript[^]*support@athlevo\.org/.test(wlSection));
  t("the priority list's wording has no dashes and no hype", !/[–—]/.test(JSON.stringify(wl) + JSON.stringify(c.WAITLIST_EMAIL) + JSON.stringify(c.HERO)) && !/!/.test(JSON.stringify(wl.points) + wl.text + wl.heading));
  t("the page config carries the priority list's wording and the two button states",
    config.waitlist && config.waitlist.api === c.SITE.waitlistApi && config.waitlist.errors.consent === wl.errors.consent && config.modes.soon.href === "#waitlist");

  // ---- the browser script: the priority list checks, the campaign label, and the two secrets
  const sandbox9 = { window: undefined };
  vm.createContext(sandbox9);
  vm.runInContext(script, sandbox9);
  const api = sandbox9.AthlevoVirtualRun;
  const server = await import("../lib/server/virtualRunWaitlist.js");
  const cases = [
    {}, { fullName: "M" }, { fullName: "  " }, { email: "nope" }, { email: "a@b" }, { email: "a b@c.com" }, { email: "x".repeat(260) + "@e.com" },
    { consent: false }, { consent: "true" }, { consent: 1 }, { consent: undefined }, { fullName: "Maria  Santos" }
  ];
  const good = { fullName: "Maria Santos", email: "maria@example.com", consent: true };
  const mismatches = [];
  for (const over of cases) {
    const values = { ...good, ...over };
    const client = Object.keys(api.validateWaitlist(values)).sort().join(",");
    const checked = server.validateWaitlist(values);
    const serverFields = Object.keys(checked.fields).sort().join(",");
    if (client !== serverFields) mismatches.push(JSON.stringify(over) + " client " + client + " server " + serverFields);
  }
  t("the browser and the server accept and refuse the same " + cases.length + " sign-ups", mismatches.length === 0, mismatches.slice(0, 3).join(" ; "));
  t("the server also refuses a link or an address in the name box, which the browser has no reason to know about",
    server.validateWaitlist({ ...good, fullName: "http://spam.example" }).ok === false && server.validateWaitlist({ ...good, fullName: "buy@now.example" }).ok === false);
  t("a campaign label comes from ?src=, then utm_campaign, then utm_source, and only if it is a plain short label",
    api.sourceFrom("?src=Meta-Launch") === "meta-launch" && api.sourceFrom("?utm_campaign=nov_sale&utm_source=fb") === "nov_sale" && api.sourceFrom("?utm_source=facebook") === "facebook" &&
    api.sourceFrom("?src=a b%20c") === "" && api.sourceFrom("?src=" + "x".repeat(41)) === "" && api.sourceFrom("?src=%3Cscript%3E") === "" && api.sourceFrom("") === "");

  // The e-mail leave link carries a secret token. Like the payment reference, it is moved out of the address first.
  const LEAVE = "ATH-WL-" + "0123456789ABCDEF".repeat(2);
  const firstScript = (head(html).match(/<script>([\s\S]*?)<\/script>/) || [, ""])[1];
  function arrive(search) {
    const stored = {};
    const state = { search, hash: "", pathname: "/virtual-run" };
    const box = {
      location: state, sessionStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => (k in stored ? stored[k] : null) },
      history: { replaceState: (a, b, url) => { const q = String(url).indexOf("?"); state.search = q < 0 ? "" : String(url).slice(q); } }
    };
    vm.createContext(box);
    vm.runInContext(firstScript, box);
    return { search: state.search, stored };
  }
  const left = arrive("?leave=" + LEAVE);
  t("a leave link: the token leaves the address (so no pixel can read it) and is kept for this tab, with a marker in its place",
    left.search === "?leave=1" && left.stored["athlevo.vr.leave"] === LEAVE && !left.search.includes("ATH-WL"));
  t("a leave link keeps the other parameters, and a campaign label still works after it", arrive("?src=meta&leave=" + LEAVE + "&x=1").search === "?src=meta&x=1&leave=1" && arrive("?leave=" + LEAVE + "&src=meta").search === "?src=meta&leave=1");
  t("reloading a leave page does not overwrite the stored token with the marker", Object.keys(arrive("?leave=1").stored).length === 0 && arrive("?leave=1").search === "?leave=1");
  t("a leave link and a payment return can both be handled, and an ordinary visit is left alone", arrive("?payment=success&ref=" + REF_FOR_TEST() + "&leave=" + LEAVE).search === "?payment=success&leave=1" && arrive("?src=meta").search === "?src=meta");
  function REF_FOR_TEST() { return "ATH-VR-0123456789ABCDEF-" + "A1B2C3D4".repeat(3); }

  t("opening the leave link removes nobody: the removal is sent only from the button's click", (script.match(/\{ leave: leaveToken \}/g) || []).length === 1 &&
    /function confirmLeave\(\)[\s\S]*?postJson\(W\.api, \{ leave: leaveToken \}/.test(script) && /addEventListener\("click", confirmLeave\)/.test(script) && !/function startLeave[\s\S]*?postJson[\s\S]*?function confirmLeave/.test(script));
  t("the pixel hears 'Lead' only after the server saved the sign-up, once per tab, and never gets a name or an email",
    /trackLead\(\);/.test(script) && /handleWaitlistResult[\s\S]*?result\.status === 200 && data\.ok[\s\S]*?trackLead\(\)/.test(script) &&
    !/fullName|email/.test((script.match(/function trackLead[\s\S]*?\n  \}/) || [""])[0]) && /"Lead"/.test(script));
  t("the script picks the registration state only from the server's answer (open, closed or full) or a return from payment",
    /setMode\(returning \|\| confirmMode \|\| state === "open" \|\| ended \? "register" : "soon"\)/.test(script) && /var ended = state === "closed" \|\| state === "sold_out"/.test(script));
  t("an old #register link lands on the priority list while registration is not open", /mode === "soon" && global\.location\.hash === "#register"/.test(script));

  // ---- the staff page
  t("the staff page has a Registrations tab and a Priority list tab, and the export follows the tab",
    /role="tablist"/.test(adminHtml) && /id="vra-tab-waitlist"/.test(adminHtml) && /id="vra-panel-waitlist"/.test(adminHtml) && /Export priority list CSV/.test(adminScript) && /view: "waitlist"/.test(adminScript));
  t("the priority list tab is behind the same sign-in and shows the people who left as well as those who stayed",
    /id="vra-wl-status"[^>]*>[\s\S]*?Left the list/.test(adminHtml) && /Consent version/.test(adminHtml));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
