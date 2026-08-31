/*
 * Anonymous /ai early-start: diagnostic paints and is usable before
 * restoreSession/getSession resolves. Run: node tests/ai-early-start.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");

section("Source — initializeAthlevoApp / eligibility");
{
  const initStart = html.indexOf("async function initializeAthlevoApp()");
  const initEnd = html.indexOf("initializeAthlevoApp();", initStart);
  const initSource = html.slice(initStart, initEnd);
  t("early start is invoked before await restoreSession",
    initSource.indexOf("earlyStartAnonymousAiDiagnosticIfEligible()") <
      initSource.indexOf("await restoreSession("));
  t("openPublicLegalRoute still precedes early start and restoreSession",
    initSource.indexOf("await window.openPublicLegalRoute(url.pathname)") <
      initSource.indexOf("earlyStartAnonymousAiDiagnosticIfEligible()") &&
    initSource.indexOf("earlyStartAnonymousAiDiagnosticIfEligible()") <
      initSource.indexOf("await restoreSession("));
  t("restoreSession finally still lifts the boot gate",
    /\} finally \{[\s\S]{0,400}endBootGate\(\);/.test(initSource));
  t("eligibility reuses returning-account, OAuth, and checkout markers",
    /function canEarlyStartAnonymousAiDiagnostic/.test(html) &&
    /hasReturningAthlevoAccountMarker/.test(html.slice(
      html.indexOf("function canEarlyStartAnonymousAiDiagnostic"),
      html.indexOf("function earlyStartAnonymousAiDiagnosticIfEligible")
    )) &&
    /hasLiveAthlevoOAuthReturn/.test(html) &&
    /checkout_return/.test(html.slice(
      html.indexOf("function canEarlyStartAnonymousAiDiagnostic"),
      html.indexOf("function earlyStartAnonymousAiDiagnosticIfEligible")
    )));
  t("startDiagnostic is idempotent for an already-active acquisition chat",
    /if \(diagnosticAcquisitionActive\)/.test(uiSrc) &&
    /screen-diagnostic/.test(uiSrc.slice(
      uiSrc.indexOf("if (diagnosticAcquisitionActive)"),
      uiSrc.indexOf("var pending = root.AthlevoDiagnostic")
    )));
}

function makeNode(tag, registry) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    style: {},
    children: [],
    attributes: {},
    disabled: false,
    value: "",
    innerHTML: "",
    textContent: "",
    parentNode: null,
    content: { firstElementChild: null },
    classList: {
      add(name) {
        const parts = node.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        node.className = parts.join(" ");
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter(c => c && c !== name).join(" ");
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      }
    },
    setAttribute(k, v) {
      node.attributes[k] = String(v);
      if (k === "id") {
        node.id = String(v);
        registry.set(node.id, node);
      }
    },
    getAttribute(k) { return node.attributes[k]; },
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      if (child.id) registry.set(child.id, child);
      return child;
    },
    querySelector(sel) {
      if (sel === ".chat-thread") return registry.get("chatThread") || null;
      if (sel && sel.startsWith("#")) return registry.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    scrollTo() {},
    remove() {
      if (node.id) registry.delete(node.id);
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter(c => c !== node);
      }
    },
    animate() {}
  };
  Object.defineProperty(node, "firstElementChild", {
    get() { return node.children[0] || node.content.firstElementChild || null; }
  });
  return node;
}

function parseHtml(htmlFrag, registry) {
  const node = makeNode("div", registry);
  const id = (htmlFrag.match(/\sid="([^"]+)"/) || [])[1];
  const cls = (htmlFrag.match(/\sclass="([^"]*)"/) || [])[1];
  if (id) {
    node.id = id;
    registry.set(id, node);
  }
  if (cls) node.className = cls;
  node.innerHTML = htmlFrag;
  node.textContent = htmlFrag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return node;
}

function loadUi() {
  const registry = new Map();
  const storage = new Map();
  const events = [];
  const document = {
    readyState: "complete",
    body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    getElementById: id => registry.get(id) || null,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) {
      const el = makeNode(tag, registry);
      if (String(tag).toLowerCase() === "template") {
        Object.defineProperty(el, "innerHTML", {
          set(htmlFrag) {
            el._html = htmlFrag;
            el.content = { firstElementChild: parseHtml(htmlFrag, registry) };
          },
          get() { return el._html; }
        });
      } else {
        Object.defineProperty(el, "textContent", {
          set(v) {
            el._text = String(v);
            el.innerHTML = String(v);
          },
          get() { return el._text || ""; }
        });
      }
      return el;
    }
  };

  const screen = makeNode("section", registry);
  screen.id = "screen-diagnostic";
  registry.set("screen-diagnostic", screen);

  const body = makeNode("div", registry);
  body.id = "diagBody";
  registry.set("diagBody", body);

  ["chatQuickReplies", "chatComposer", "chatInput", "chatSend", "tabbar"].forEach(id => {
    const el = makeNode(id === "chatInput" ? "input" : "div", registry);
    el.id = id;
    registry.set(id, el);
  });

  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array, Promise,
    crypto: globalThis.crypto,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document,
    location: { pathname: "/ai" },
    athlevoSessionUserId: null,
    routeAfterAuthCalls: 0,
    routeAfterAuth(userId) { context.routeAfterAuthCalls += 1; context.routedUserId = userId; }
  };
  context.window = context;
  context.globalThis = context;
  context.AthlevoProductAnalytics = {
    trackAthlevoEvent(name, props) { events.push({ name, props }); },
    attributionProps() { return {}; },
    landingProps() { return {}; }
  };
  context.AthlevoAnalytics = { track() {} };
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context, { filename: "diagnostic.js" });
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, { filename: "diagnosticSalesEngine.js" });
  vm.runInContext(readFileSync("./js/diagnosticUI.js", "utf8"), context, { filename: "diagnosticUI.js" });
  return { ctx: context, UI: context.AthlevoDiagnosticUI, events, registry, storage };
}

section("K/L — analytics duplication and diagnostic_started semantics");
{
  const { UI, events, registry, ctx } = loadUi();
  ctx.athlevoSessionUserId = null;
  UI.start();
  UI.start();
  const landing = events.filter(e => e.name === "ai_landing_viewed");
  const viewed = events.filter(e => e.name === "diagnostic_viewed");
  const started = events.filter(e => e.name === "diagnostic_started");
  t("K. second start() does not double-fire ai_landing_viewed", landing.length === 1);
  t("J. second start() does not rebuild a second diagnostic_viewed", viewed.length === 1);
  t("L. start() still does not fire diagnostic_started", started.length === 0);
  t("composer remains enabled after early start",
    registry.get("chatInput").disabled !== true &&
    registry.get("chatSend").disabled !== true);
  t("acquisition flag is set after the first successful start",
    UI._internal.isDiagnosticAcquisitionActive() === true);

  UI._internal.markDiagnosticStarted("chip");
  UI._internal.markDiagnosticStarted("text");
  t("L. diagnostic_started still fires once on first real interaction",
    events.filter(e => e.name === "diagnostic_started").length === 1 &&
    events.find(e => e.name === "diagnostic_started").props.first_input_type === "chip");
}

section("Auth still wins after an early start");
{
  const { UI, events, ctx } = loadUi();
  UI.start();
  ctx.athlevoSessionUserId = "u-paid";
  UI.start();
  t("authenticated start after early paint calls routeAfterAuth, not a second view",
    ctx.routeAfterAuthCalls === 1 &&
    ctx.routedUserId === "u-paid" &&
    events.filter(e => e.name === "ai_landing_viewed").length === 1 &&
    events.filter(e => e.name === "diagnostic_viewed").length === 1);
}

section("Guards still refuse returning / checkout / session before paint");
{
  const returning = loadUi();
  returning.ctx.hasReturningAthlevoAccountMarker = () => true;
  returning.ctx.showReturningUserWelcome = () => { returning.ctx.welcome = true; };
  returning.UI.start();
  t("returning-account marker still blocks diagnostic paint",
    returning.ctx.welcome === true &&
    returning.events.filter(e => e.name === "ai_landing_viewed").length === 0);

  const checkout = loadUi();
  checkout.ctx.AthlevoDiagnosticAcquisition = { hasCheckoutReturn: () => true };
  checkout.ctx.showCheckoutReturnWelcome = () => { checkout.ctx.checkout = true; };
  checkout.UI.start();
  t("checkout_return still blocks diagnostic paint",
    checkout.ctx.checkout === true &&
    checkout.events.filter(e => e.name === "ai_landing_viewed").length === 0);

  const authed = loadUi();
  authed.ctx.athlevoSessionUserId = "u1";
  authed.UI.start();
  t("live session still refuses acquisition and uses routeAfterAuth",
    authed.ctx.routeAfterAuthCalls === 1 &&
    authed.events.filter(e => e.name === "diagnostic_viewed").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
