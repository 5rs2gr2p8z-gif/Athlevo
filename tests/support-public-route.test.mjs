/**
 * Public /support route contract (App Store Connect Support URL).
 * Run: node tests/support-public-route.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const legalSource = readFileSync("./js/legal.js", "utf8");
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));

function classList() {
  const values = new Set();
  return {
    add(name) { values.add(name); },
    contains(name) { return values.has(name); }
  };
}

function loadLegalRuntime(activeScreen = "screen-landing") {
  const supportBody = { innerHTML: "" };
  const supportScreen = { scrollTop: -1 };
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
          supportPublicBody: supportBody,
          "screen-support": supportScreen,
          authModal
        }[id] || null;
      },
      querySelector(selector) {
        return selector === ".screen.active" ? { id: activeId } : null;
      }
    },
    fetch: async url => {
      fetched.push(url);
      return { ok: true, text: async () => "# Test" };
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
  return { context, supportBody, supportScreen, bodyClasses, shown, fetched, assigned };
}

/* ── 1. /support opens the correct screen without auth ── */
const rt = loadLegalRuntime();
assert.equal(await rt.context.window.openPublicLegalRoute("/support"), true,
  "/support should return true");
assert.deepEqual(rt.shown, ["screen-support"], "should show screen-support");
assert.equal(rt.supportScreen.scrollTop, 0, "screen should scroll to top");
assert.equal(rt.bodyClasses.contains("public-legal-active"), true,
  "should add public-legal-active class (no auth/session restore gate)");
assert.equal(rt.context.document.title, "Support — Athlevo", "page title should be set");

/* ── 2. Does NOT fetch a markdown file (content is inline HTML) ── */
assert.deepEqual(rt.fetched, [], "/support should not fetch a markdown file");

/* ── 3. closeLegal redirects to / ── */
rt.context.window.closeLegal();
assert.deepEqual(rt.assigned, ["/"], "closeLegal should redirect to /");

/* ── 4. Unrelated/other public routes still work and are unaffected ── */
const privRt = loadLegalRuntime();
assert.equal(await privRt.context.window.openPublicLegalRoute("/privacy"), true);
const otherRt = loadLegalRuntime();
assert.equal(await otherRt.context.window.openPublicLegalRoute("/terms"), false);
assert.equal(await otherRt.context.window.openPublicLegalRoute("/"), false);
assert.deepEqual(otherRt.shown, []);

/* ── 5. Vercel rewrite exists for /support ── */
assert.ok(vercel.rewrites.some(route =>
  route.source === "/support" && route.destination === "/index.html"
), "vercel.json must have a /support rewrite to /index.html");

/* ── 6. HTML contract: screen and content exist ── */
assert.match(html, /id="screen-support"/, "screen-support section must exist in index.html");
assert.match(html, /id="supportPublicBody"/, "supportPublicBody container must exist in index.html");

/* ── 7. Page contains the support email (not only a mailto — real public page exists) ── */
assert.match(html, /screen-support[\s\S]*?support@athlevo\.org/,
  "public support page must reference support@athlevo.org");

/* ── 8. CSS covers the support screen in public mode ── */
assert.match(html, /public-legal-active[\s\S]*?screen-support/,
  "public-legal-active CSS should reference screen-support");

/* ── 9. initializeAthlevoApp calls openPublicLegalRoute before restoreSession ── */
const initStart = html.indexOf("async function initializeAthlevoApp()");
const initEnd = html.indexOf("initializeAthlevoApp();", initStart);
const initSource = html.slice(initStart, initEnd);
assert.ok(initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") >= 0,
  "initializeAthlevoApp must call openPublicLegalRoute");
assert.ok(
  initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") <
  initSource.indexOf("await restoreSession("),
  "openPublicLegalRoute must run before restoreSession (no login required)"
);

/* ── 10. legal.js handles /support path ── */
assert.match(legalSource, /\/support/, "legal.js must reference /support path");
assert.match(legalSource, /screen-support/, "legal.js must reference screen-support");

console.log("PASS — /support publicly resolves to a real page with support@athlevo.org, no login required");
