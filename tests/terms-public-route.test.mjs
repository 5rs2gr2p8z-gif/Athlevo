/**
 * Public /terms route contract.
 *
 * Verifies /terms is a real, public, no-login Terms of Service route,
 * added the same way /privacy and /support already work: a vercel.json
 * rewrite to /index.html, handled by openPublicLegalRoute() in
 * js/legal.js before any session restore, rendering the SAME canonical
 * legal/terms-of-service.md source (via LEGAL_DOCS.terms / loadLegalDoc)
 * that the in-app "screen-terms" view already uses. No forked copy of
 * the legal text is introduced by this route.
 *
 * Also confirms /privacy and /support remain wired, index.html is
 * byte-for-byte unchanged, /ai routing is untouched, and the
 * landing-preview.html footer's Terms link now points at /terms.
 *
 * Run: node tests/terms-public-route.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const legalSource = readFileSync("./js/legal.js", "utf8");
const termsOfService = readFileSync("./legal/terms-of-service.md", "utf8");
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const preview = readFileSync("./landing-preview.html", "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

function classList() {
  const values = new Set();
  return {
    add(name) { values.add(name); },
    contains(name) { return values.has(name); }
  };
}

function loadLegalRuntime(activeScreen = "screen-landing") {
  const termsBody = { innerHTML: "" };
  const termsScreen = { scrollTop: -1 };
  const authModal = { style: { display: "none" } };
  const bodyClasses = classList();
  const shown = [];
  const fetched = [];
  const assigned = [];
  let activeId = activeScreen;

  const context = {
    console,
    document: {
      title: "Athlevo",
      body: { classList: bodyClasses },
      getElementById(id) {
        return {
          legalBodyTerms: termsBody,
          "screen-terms": termsScreen,
          authModal
        }[id] || null;
      },
      querySelector(selector) {
        return selector === ".screen.active" ? { id: activeId } : null;
      }
    },
    fetch: async url => {
      fetched.push(url);
      return { ok: true, text: async () => termsOfService };
    },
    showScreen(id) {
      activeId = id;
      shown.push(id);
    },
    window: {
      location: { assign(path) { assigned.push(path); } }
    }
  };

  vm.runInNewContext(legalSource, context);
  return { context, termsBody, termsScreen, bodyClasses, shown, fetched, assigned };
}

/* ── 1 & 2. /terms is a public, no-auth route wired in vercel.json ──── */
section("1-2. /terms exists, is wired, and requires no auth");
{
  t("vercel.json rewrites /terms to /index.html (same pattern as /privacy, /support)",
    vercel.rewrites.some(r => r.source === "/terms" && r.destination === "/index.html"));

  const rt = loadLegalRuntime();
  t("openPublicLegalRoute('/terms') returns true", await rt.context.window.openPublicLegalRoute("/terms") === true);
  t("shows screen-terms", JSON.stringify(rt.shown) === JSON.stringify(["screen-terms"]));
  t("scrolls the screen to top", rt.termsScreen.scrollTop === 0);
  t("adds public-legal-active (no auth/session-restore gate)",
    rt.bodyClasses.contains("public-legal-active"));
  t("sets a Terms-specific page title", rt.context.document.title === "Terms of Service — Athlevo");

  rt.context.window.closeLegal();
  t("closeLegal() redirects to / (never back into a login flow)",
    JSON.stringify(rt.assigned) === JSON.stringify(["/"]));

  const initStart = html.indexOf("async function initializeAthlevoApp()");
  const initEnd = html.indexOf("initializeAthlevoApp();", initStart);
  const initSource = html.slice(initStart, initEnd);
  t("initializeAthlevoApp calls openPublicLegalRoute", initSource.includes("await window.openPublicLegalRoute(url.pathname)"));
  t("openPublicLegalRoute runs BEFORE restoreSession (no login required to view /terms)",
    initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") <
    initSource.indexOf("await restoreSession("));
  t("legal.js has no app-shell/SPA-bootstrap dependency added for /terms beyond the shared showScreen helper already used by /privacy and /support",
    !/openLogin\(|requireAuth\(|redirectToLogin/i.test(legalSource));
}

/* ── 3. Renders the REAL canonical Terms content (no forked copy) ──── */
section("3. Renders real, canonical Terms of Service content");
{
  const rt = loadLegalRuntime();
  await rt.context.window.openPublicLegalRoute("/terms");
  t("fetches the canonical markdown source (legal/terms-of-service.md), nothing else",
    JSON.stringify(rt.fetched) === JSON.stringify(["legal/terms-of-service.md"]));
  t("rendered body contains the canonical H1", /<h1>Terms of Service<\/h1>/.test(rt.termsBody.innerHTML));
  t("rendered body contains the Acceptance section", /<h2>1\. Acceptance<\/h2>/.test(rt.termsBody.innerHTML));
  t("rendered body contains the Medical Disclaimer section", /<h2>3\. Medical Disclaimer<\/h2>/.test(rt.termsBody.innerHTML));
  t("rendered body reproduces canonical wording verbatim (medical-emergency sentence)",
    rt.termsBody.innerHTML.includes(
      "If you experience severe pain, chest pain, loss of consciousness, difficulty breathing, or another medical emergency, immediately seek emergency medical care."
    ));
  t("LEGAL_DOCS.terms points at the same markdown file used by the in-app screen-terms view (single source of truth, no divergent copy)",
    /terms:\s*\{\s*file:\s*"legal\/terms-of-service\.md"/.test(legalSource));
  t("index.html's public /terms screen reuses the existing legalBodyTerms container (not a new/duplicate markup block)",
    /id="screen-terms"[\s\S]{0,300}id="legalBodyTerms"/.test(html));
}

/* ── 4 & 5. /privacy and /support remain wired and unaffected ───────── */
section("4-5. /privacy and /support still work");
{
  const privRt = loadLegalRuntime();
  t("/privacy still returns true", await privRt.context.window.openPublicLegalRoute("/privacy") === true);
  t("/privacy still shows screen-privacy", JSON.stringify(privRt.shown) === JSON.stringify(["screen-privacy"]));
  t("/privacy still wired in vercel.json",
    vercel.rewrites.some(r => r.source === "/privacy" && r.destination === "/index.html"));

  const suppRt = loadLegalRuntime();
  t("/support still returns true", await suppRt.context.window.openPublicLegalRoute("/support") === true);
  t("/support still shows screen-support", JSON.stringify(suppRt.shown) === JSON.stringify(["screen-support"]));
  t("/support still wired in vercel.json",
    vercel.rewrites.some(r => r.source === "/support" && r.destination === "/index.html"));
}

/* ── 6. landing-preview.html footer Terms link now points at /terms ─── */
section("6. landing-preview.html footer Terms link");
{
  t('footer has an active <a href="/terms">Terms of Service</a> link',
    /<a href="\/terms">Terms of Service<\/a>/.test(preview));
  t("no leftover inactive Terms placeholder remains in the footer",
    !/class="inactive">Terms/.test(preview));
  t("landing-preview.html was not otherwise changed in a way that activates it as the live landing page",
    !/id="app"|initializeAthlevoApp/.test(preview));
}

/* ── 7. Live "/" (index.html) is byte-for-byte unchanged ────────────── */
section("7. index.html untouched");
{
  const LIVE_INDEX_SHA256 =
    "70e390e9d7bae93383bf69b65e12208564131dfabd3fdbb9e5ed92864af17e11";
  const actualHash = createHash("sha256").update(html).digest("hex");
  t("index.html sha256 matches the pre-work baseline recorded by the landing-preview task",
    actualHash === LIVE_INDEX_SHA256, `got ${actualHash}`);
}

/* ── 8. /ai routing/behavior unchanged ───────────────────────────────── */
section("8. /ai routing unchanged");
{
  t("index.html still routes /ai (and root) to the anonymous Coach entry",
    /aiPath === "\/ai" \|\| aiPath === "" \|\| aiPath === "\/signup" \|\| aiPath === "\/ai-signup"/.test(html));
  const unrelatedRt = loadLegalRuntime();
  t("openPublicLegalRoute('/ai') is not intercepted as a legal route (still falls through to /ai's own handling)",
    await unrelatedRt.context.window.openPublicLegalRoute("/ai") === false);
}

/* ── 9. No signup/payment/wearable behavior touched ──────────────────── */
section("9. No signup/payment/wearable behavior touched by this change");
{
  t("legal.js has no NEW payment/wearable references introduced by the /terms branch",
    !/paymongo|whop|connectGarmin|connectStrava|connectIntervals/i.test(legalSource));
  t("the /terms branch itself does not call any signup/payment/wearable function",
    (() => {
      const start = legalSource.indexOf('if (normalizedPath === "/terms")');
      const end = legalSource.indexOf("\n  }\n", start);
      const block = legalSource.slice(start, end);
      return !/openSignup|openAiSignup|paymongo|whop|connect(Garmin|Strava|Intervals)/i.test(block);
    })());
  t("vercel.json's payment/AI provider rewrites are untouched",
    vercel.rewrites.some(r => r.source === "/api/paymongo/checkout") &&
    vercel.rewrites.some(r => r.source === "/api/diagnostic-chat") &&
    vercel.rewrites.some(r => r.source === "/api/coach-anonymous"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
