/**
 * Public Privacy Policy route contract.
 * Run: node tests/privacy-public-route.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const legalSource = readFileSync("./js/legal.js", "utf8");
const privacyPolicy = readFileSync("./legal/privacy-policy.md", "utf8");
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
  const privacyScreen = { scrollTop: -1 };
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
          "screen-privacy": privacyScreen,
          authModal
        }[id] || null;
      },
      querySelector(selector) {
        return selector === ".screen.active" ? { id: activeId } : null;
      }
    },
    fetch: async url => {
      fetched.push(url);
      return { ok: true, text: async () => privacyPolicy };
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
  return { context, privacyBody, privacyScreen, bodyClasses, shown, fetched, assigned };
}

const publicRuntime = loadLegalRuntime();
assert.equal(await publicRuntime.context.window.openPublicLegalRoute("/privacy"), true);
assert.deepEqual(publicRuntime.shown, ["screen-privacy"]);
assert.deepEqual(publicRuntime.fetched, ["/legal/privacy-policy.md"]);
assert.equal(publicRuntime.privacyScreen.scrollTop, 0);
assert.match(publicRuntime.privacyBody.innerHTML, /<h1>Privacy Policy<\/h1>/);
assert.equal(publicRuntime.bodyClasses.contains("public-legal-active"), true);
assert.equal(publicRuntime.context.document.title, "Privacy Policy — Athlevo");
publicRuntime.context.window.closeLegal();
assert.deepEqual(publicRuntime.assigned, ["/"]);

const unrelatedRuntime = loadLegalRuntime();
assert.equal(await unrelatedRuntime.context.window.openPublicLegalRoute("/terms"), false);
assert.deepEqual(unrelatedRuntime.shown, []);
assert.deepEqual(unrelatedRuntime.fetched, []);

const inAppRuntime = loadLegalRuntime("screen-you");
inAppRuntime.context.window.openLegal("privacy");
await Promise.resolve();
inAppRuntime.context.window.closeLegal();
assert.deepEqual(inAppRuntime.shown, ["screen-privacy", "screen-you"]);
assert.deepEqual(inAppRuntime.assigned, []);

assert.ok(vercel.rewrites.some(route =>
  route.source === "/privacy" && route.destination === "/index.html"
));

const initializeStart = html.indexOf("async function initializeAthlevoApp()");
const initializeEnd = html.indexOf("initializeAthlevoApp();", initializeStart);
const initializeSource = html.slice(initializeStart, initializeEnd);
assert.ok(initializeSource.indexOf("await window.openPublicLegalRoute(url.pathname)") >= 0);
assert.ok(initializeSource.indexOf("await window.openPublicLegalRoute(url.pathname)") <
  initializeSource.indexOf("await restoreSession("));
assert.match(html, /body\.public-legal-active \.device/);
assert.match(html, /id="screen-privacy"/);
assert.match(legalSource, /file: "\/legal\/privacy-policy\.md"/);

console.log("PASS — /privacy publicly renders the existing policy and preserves in-app legal navigation");
