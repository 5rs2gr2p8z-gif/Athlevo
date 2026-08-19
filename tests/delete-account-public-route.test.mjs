/**
 * Public /delete-account route contract.
 * Run: node tests/delete-account-public-route.test.mjs
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
  const privacyBody = { innerHTML: "" };
  const deleteAccountBody = { innerHTML: "" };
  const privacyScreen = { scrollTop: -1 };
  const deleteAccountScreen = { scrollTop: -1 };
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
          legalBodyPrivacy: privacyBody,
          deleteAccountPublicBody: deleteAccountBody,
          "screen-privacy": privacyScreen,
          "screen-delete-account": deleteAccountScreen,
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
  return { context, deleteAccountBody, deleteAccountScreen, bodyClasses, shown, fetched, assigned };
}

/* ── 1. /delete-account opens the correct screen ── */
const rt = loadLegalRuntime();
assert.equal(await rt.context.window.openPublicLegalRoute("/delete-account"), true,
  "/delete-account should return true");
assert.deepEqual(rt.shown, ["screen-delete-account"],
  "should show screen-delete-account");
assert.equal(rt.deleteAccountScreen.scrollTop, 0,
  "screen should scroll to top");
assert.equal(rt.bodyClasses.contains("public-legal-active"), true,
  "should add public-legal-active class");
assert.equal(rt.context.document.title, "Delete Account — Athlevo",
  "page title should be set");

/* ── 2. Does NOT fetch a markdown file (content is inline HTML) ── */
assert.deepEqual(rt.fetched, [],
  "/delete-account should not fetch a markdown file");

/* ── 3. closeLegal redirects to / ── */
rt.context.window.closeLegal();
assert.deepEqual(rt.assigned, ["/"],
  "closeLegal should redirect to /");

/* ── 4. /privacy still works ── */
const privRt = loadLegalRuntime();
assert.equal(await privRt.context.window.openPublicLegalRoute("/privacy"), true,
  "/privacy should still work");
assert.deepEqual(privRt.shown, ["screen-privacy"]);

/* ── 5. Unrelated routes still return false ── */
const otherRt = loadLegalRuntime();
assert.equal(await otherRt.context.window.openPublicLegalRoute("/terms"), false);
assert.equal(await otherRt.context.window.openPublicLegalRoute("/"), false);
assert.deepEqual(otherRt.shown, []);

/* ── 6. Vercel rewrite exists for /delete-account ── */
assert.ok(vercel.rewrites.some(route =>
  route.source === "/delete-account" && route.destination === "/index.html"
), "vercel.json must have a /delete-account rewrite to /index.html");

/* ── 7. HTML contract: screen and content exist ── */
assert.match(html, /id="screen-delete-account"/,
  "screen-delete-account section must exist in index.html");
assert.match(html, /id="deleteAccountPublicBody"/,
  "deleteAccountPublicBody container must exist in index.html");

/* ── 8. Page content references in-app deletion path ── */
assert.match(html, /screen-delete-account[\s\S]*?You[\s\S]*?tab/i,
  "page should mention the You tab");
assert.match(html, /screen-delete-account[\s\S]*?Delete Account/,
  "page should mention the Delete Account button");
assert.match(html, /screen-delete-account[\s\S]*?Type[\s\S]*?DELETE/,
  "page should mention typing DELETE to confirm");

/* ── 9. Page references support email ── */
assert.match(html, /screen-delete-account[\s\S]*?support@athlevo\.org/,
  "page should include support@athlevo.org as a fallback");

/* ── 10. Page links to Privacy Policy ── */
assert.match(html, /screen-delete-account[\s\S]*?href="\/privacy"/,
  "page should link to the Privacy Policy");

/* ── 11. CSS covers delete-account screen in public mode ── */
assert.match(html, /public-legal-active[\s\S]*?screen-delete-account/,
  "public-legal-active CSS should reference screen-delete-account");

/* ── 12. initializeAthlevoApp calls openPublicLegalRoute before restoreSession ── */
const initStart = html.indexOf("async function initializeAthlevoApp()");
const initEnd = html.indexOf("initializeAthlevoApp();", initStart);
const initSource = html.slice(initStart, initEnd);
assert.ok(initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") >= 0,
  "initializeAthlevoApp must call openPublicLegalRoute");
assert.ok(
  initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") <
  initSource.indexOf("await restoreSession("),
  "openPublicLegalRoute must run before restoreSession"
);

/* ── 13. legal.js handles /delete-account path ── */
assert.match(legalSource, /\/delete-account/,
  "legal.js must reference /delete-account path");
assert.match(legalSource, /screen-delete-account/,
  "legal.js must reference screen-delete-account");

console.log("PASS — /delete-account public route renders correctly and satisfies Google Play requirements");
