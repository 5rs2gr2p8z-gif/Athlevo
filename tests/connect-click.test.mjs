/*
 * Athlevo — the Connect click path, EXECUTED.
 *
 * Production shows repeated action=diagnose and NO action=connect, so the
 * click path dies somewhere between the button and fetch(). Every existing
 * suite called authorize() directly, so the actual <button onclick="..."> was
 * never exercised — a broken binding, a missing export or a swallowed error
 * would all have passed unnoticed.
 *
 * This suite mounts the REAL onboarding DOM, finds the REAL primary button by
 * its rendered markup, evaluates its onclick exactly as a browser would, and
 * asserts that exactly one
 *
 *     POST /api/providers?provider=intervals&action=connect
 *
 * is emitted, before any diagnose request.
 *
 * Run: node tests/connect-click.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// Distinctive on purpose: "sess" is a substring of the stage name
// connect_session_checked, so a naive needle would match our own log.
const SECRET = "ZZtop-secret-access-tokenZZ";

/* ── a minimal browser ───────────────────────────────────────────────── */

function makeWorld({ hasSession = true, connectStatus = 200 } = {}) {
  const dom = { html: "", screen: null, tabbar: "none", navigatedTo: null };
  const net = [];          // every fetch, in order
  const trail = [];        // every stage the real code emits

  const el = (id) => {
    if (id === "connectFlowBody") {
      return { set innerHTML(v) { dom.html = v; }, get innerHTML() { return dom.html; } };
    }
    if (id === "tabbar") return { style: { display: dom.tabbar } };
    return null;
  };

  const store = new Map();
  const sandbox = {
    document: { getElementById: el },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    showScreen: (id) => { dom.screen = id; },
    // The real stage hook, as defined by index.html's capture block.
    __athlevoOAuthStage: (stage, detail) => trail.push({ stage, ...(detail || {}) }),
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: hasSession ? { access_token: SECRET } : null } }),
        getUser: async () => ({ data: { user: { id: "u1" } } })
      },
      from: () => ({ insert: async () => ({ error: null }) })
    },
    fetch: async (url, init = {}) => {
      const u = String(url);
      net.push({ url: u, method: (init.method || "GET").toUpperCase() });
      if (u.includes("action=connect")) {
        return { ok: connectStatus < 300, status: connectStatus,
          json: async () => (connectStatus < 300
            ? { authorizationUrl: "https://intervals.icu/oauth/authorize?response_type=code&client_id=x&state=y" }
            : { error: "nope", code: "PROVIDER_NOT_CONFIGURED" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    toast: () => {}
  };

  // window.location.href = ... is the navigation away to the provider.
  sandbox.window = {
    get location() { return { get href() { return ""; }, set href(v) { dom.navigatedTo = v; } }; },
    open: (url) => { dom.opened = url; },
    // In a real page `window` IS the global object, so brain.js reading
    // window.__athlevoOAuthStage and onboardingConnect reading
    // root.__athlevoOAuthStage resolve to the SAME function. Mirror that.
    __athlevoOAuthStage: (stage, detail) => trail.push({ stage, ...(detail || {}) })
  };
  Object.defineProperty(sandbox, "location", {
    get: () => ({ set href(v) { dom.navigatedTo = v; }, get href() { return ""; } })
  });

  const g = sandbox;
  const load = (file, extra = []) => {
    const src = readFileSync(file, "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);");
    new Function(...Object.keys(sandbox), "root", ...extra.map((_, i) => "x" + i), src)(
      ...Object.values(sandbox), g, ...extra);
  };

  /*
   * brain.js is a classic script, not a module: it declares functions and
   * assigns window.AthlevoBrain. Load it the same way the page does.
   */
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  new Function(...Object.keys(sandbox), "root",
    brainSrc + "\n;root.AthlevoBrain = window.AthlevoBrain;")(...Object.values(sandbox), g);

  load("./js/activation.js");
  new Function(...Object.keys(sandbox), "root", "AthlevoAnalytics", "AthlevoDataSource", "AthlevoActivation",
    readFileSync("./js/onboardingConnect.js", "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(sandbox), g, g.AthlevoAnalytics, g.AthlevoDataSource, g.AthlevoActivation);

  if (g.AthlevoConnect && g.AthlevoConnect._timing) {
    g.AthlevoConnect._timing.pollMs = 5;
    g.AthlevoConnect._timing.maxMs = 30;
  }
  return { g, dom, net, trail };
}

const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));

/* ══════════════ the click, end to end ══════════════════════════════ */

section("The PRIMARY button emits exactly one action=connect");
{
  const w = makeWorld();
  await w.g.AthlevoConnect.start();
  w.g.AthlevoConnect.pickWearable("garmin");

  // Find the real button in the rendered markup, by its onclick.
  const buttons = [...w.dom.html.matchAll(/<button[^>]*onclick="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => ({ onclick: m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
                 label: m[2].replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim() }));

  t("the connect step rendered buttons", buttons.length >= 2, String(buttons.length));

  const primary = buttons.find(b => /I'?(ve)? connected/i.test(b.label));
  t("the primary button exists", Boolean(primary), buttons.map(b => b.label).join(" | "));
  t("...and is bound to authorize()",
    primary && /AthlevoConnect\.authorize\(\)/.test(primary.onclick), primary && primary.onclick);

  const helper = buttons.find(b => /Open .* connections/i.test(b.label));
  t("the HELPER button is a different handler entirely",
    helper && /openConnections/.test(helper.onclick), helper && helper.onclick);
  t("...and the helper does NOT start OAuth",
    helper && !/authorize/.test(helper.onclick));

  // Evaluate the onclick exactly as the browser would.
  const before = w.net.length;
  await new Function("AthlevoConnect", primary.onclick)(w.g.AthlevoConnect);
  await wait(60);

  const connects = w.net.filter(r => r.url.includes("action=connect"));
  const diagnoses = w.net.filter(r => r.url.includes("action=diagnose"));

  t("EXACTLY ONE action=connect request was emitted", connects.length === 1,
    `${connects.length} connect, ${diagnoses.length} diagnose, trail=${w.trail.map(s => s.stage).join(">")}`);
  t("...as a POST", connects[0] && connects[0].method === "POST");
  t("...to the provider gateway",
    connects[0] && connects[0].url.includes("/api/providers?provider=intervals&action=connect"));
  t("NO diagnose request was emitted by the click", diagnoses.length === 0, String(diagnoses.length));
  t("connect came FIRST — nothing preceded it",
    w.net.length > before && w.net[before].url.includes("action=connect"), w.net[before] && w.net[before].url);
  t("the browser then navigated to the provider",
    String(w.dom.navigatedTo || "").startsWith("https://intervals.icu/oauth/authorize"), w.dom.navigatedTo);
}

/* ══════════════ the stage trail names the reached hops ═════════════ */

section("The stage trail records every hop on the click path");
{
  const w = makeWorld();
  await w.g.AthlevoConnect.start();
  w.g.AthlevoConnect.pickWearable("garmin");
  await w.g.AthlevoConnect.authorize();
  await wait(60);

  const seen = w.trail.map(s => s.stage);
  ["connect_button_clicked", "authorize_entered", "datasource_resolved",
   "connectIntervals_entered", "providerRequest_connect_entered",
   "connect_fetch_sent", "connect_fetch_response"].forEach(s =>
    t(`stage ${s} is emitted`, seen.includes(s), seen.join(">")));

  t("the hops are recorded in order",
    seen.indexOf("connect_button_clicked") < seen.indexOf("datasource_resolved") &&
    seen.indexOf("datasource_resolved") < seen.indexOf("connect_fetch_sent"));
  t("the trail carries NO credential",
    !JSON.stringify(w.trail).includes(SECRET), JSON.stringify(w.trail).slice(0, 120));
}

/* ══════════════ the failure modes the trail must distinguish ═══════ */

section("A signed-out click is reported, not silently swallowed");
{
  const w = makeWorld({ hasSession: false });
  await w.g.AthlevoConnect.start();
  w.g.AthlevoConnect.pickWearable("garmin");
  await w.g.AthlevoConnect.authorize();
  await wait(40);

  const seen = w.trail.map(s => s.stage);
  t("the click still reaches providerRequest", seen.includes("providerRequest_connect_entered"));
  t("the missing session is recorded",
    w.trail.some(s => s.stage === "connect_session_checked" && s.hasSession === false));
  t("no fetch was sent", !seen.includes("connect_fetch_sent"));
  t("NO connect request reached the network",
    w.net.filter(r => r.url.includes("action=connect")).length === 0);
  t("the reason is captured rather than swallowed",
    w.trail.some(s => /failed/.test(s.stage) && /sign in/i.test(s.message || "")),
    JSON.stringify(w.trail.filter(s => /failed/.test(s.stage))));
}

section("A server rejection surfaces its reason");
{
  const w = makeWorld({ connectStatus: 503 });
  await w.g.AthlevoConnect.start();
  w.g.AthlevoConnect.pickWearable("garmin");
  await w.g.AthlevoConnect.authorize();
  await wait(40);

  t("the request WAS sent", w.net.some(r => r.url.includes("action=connect")));
  t("the response status is recorded",
    w.trail.some(s => s.stage === "connect_fetch_response" && s.status === 503));
  t("the browser did not navigate", !w.dom.navigatedTo);
  t("the failure names itself", w.trail.some(s => s.stage === "connectIntervals_failed"));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
