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

function makeWorld({ hasSession = true, connectStatus = 200,
                     providerConnected = false, statusFails = false } = {}) {
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
      if (u.includes("action=status")) {
        if (statusFails) throw new Error("network down");
        return { ok: true, status: 200,
          json: async () => ({ provider: "intervals", connected: providerConnected,
                               status: providerConnected ? "connected" : "not_connected" }) };
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
  w.g.AthlevoConnect.continueToAccount();     // Step 2 — the account step owns the connect button

  // Find the real button in the rendered markup, by its onclick.
  const buttons = [...w.dom.html.matchAll(/<button[^>]*onclick="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => ({ onclick: m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
                 label: m[2].replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim() }));

  t("the account step rendered a button", buttons.length >= 1, String(buttons.length));

  const primary = buttons.find(b => /create free account/i.test(b.label));
  t("the primary button creates the account & continues", Boolean(primary), buttons.map(b => b.label).join(" | "));
  t("...and is bound to authorize()",
    primary && /AthlevoConnect\.authorize\(\)/.test(primary.onclick), primary && primary.onclick);

  // The account step is where the athlete starts the secure sign-in.
  t("the screen is titled 'Create your free Sync account'",
    /Create your free Sync account/.test(w.dom.html));
  t("the sync partner is NOT named in a heading or button",
    !/<h[12][^>]*>[^<]*Intervals/i.test(w.dom.html) &&
    !/<button[^>]*>[^<]*Intervals/i.test(w.dom.html));

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

/* ══════════ detection can be reached WITHOUT any OAuth ═════════════ */

section("The stale-flag loop that caused the production incident is closed");
{
  /*
   * THE ORIGINAL PRODUCTION SYMPTOM. sessionStorage.athlevo_guided_setup
   * survives every reload, and routeAfterAuth() resumed guided setup on that
   * flag alone — landing on "Checking for workouts" and polling diagnose
   * without authorize(), connectIntervals() or any OAuth request. Hence a
   * detection screen with a completely empty connect trail.
   *
   * This asserts the loop can no longer form.
   */
  const w = makeWorld({ providerConnected: false });
  w.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  w.g.sessionStorage.setItem("athlevo_guided_wearable", "garmin");

  t("isActive() is still true from sessionStorage alone",
    w.g.AthlevoConnect.isActive() === true);

  await w.g.AthlevoConnect.resumeAfterConnect();
  await wait(60);

  t("but the flag NO LONGER implies a connection — detection is refused",
    !/Checking for workouts/.test(w.dom.html));
  t("no connect request was made (none is expected here)",
    w.net.filter(r => r.url.includes("action=connect")).length === 0);
  t("no diagnose loop is started",
    w.net.filter(r => r.url.includes("action=diagnose")).length === 0);
  t("the flag is cleared, so the loop cannot re-form on reload",
    w.g.sessionStorage.getItem("athlevo_guided_setup") === null);
}

section("Build markers execute at load, independent of any behaviour");
{
  const w = makeWorld();
  const W = w.g.window;   // in a real page, window === the global object
  t("onboardingConnect.js marker is set",
    W.__ATHLEVO_CONNECT_TRACE_VERSION === "connect-wizard-v2");
  t("brain.js marker is set",
    W.__ATHLEVO_BRAIN_TRACE_VERSION === "connect-trace-v1");
  t("activation.js marker is set",
    W.__ATHLEVO_ACTIVATION_TRACE_VERSION === "connect-trace-v1");
  t("markers do not depend on a click, a session or a network call", true);
}

/* ══════ the stale-flag guard ═══════════════════════════════════════ */

const visible = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

section("1. guided_setup=1 + provider DISCONNECTED");
{
  const w = makeWorld({ providerConnected: false });
  w.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  w.g.sessionStorage.setItem("athlevo_guided_wearable", "garmin");

  await w.g.AthlevoConnect.resumeAfterConnect();
  await wait(60);

  t("NO diagnose request was made",
    w.net.filter(r => r.url.includes("action=diagnose")).length === 0,
    w.net.map(r => r.url.split("action=")[1]).join(","));
  t("the stale guided-setup flag is CLEARED",
    w.g.sessionStorage.getItem("athlevo_guided_setup") === null);
  t("the detection screen is NOT shown", !/Checking for workouts/.test(w.dom.html));
  t("the athlete is returned to the connect step",
    /isn.t connected yet/.test(visible(w.dom.html)), visible(w.dom.html).slice(0, 70));
  t("...with their chosen wearable preserved in state",
    w.g.AthlevoConnect._state ? w.g.AthlevoConnect._state.wearable === "garmin" : true);
  t("the server was actually consulted",
    w.net.some(r => r.url.includes("action=status")));
}

section("2. guided_setup=1 + provider CONNECTED");
{
  const w = makeWorld({ providerConnected: true });
  w.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  w.g.sessionStorage.setItem("athlevo_guided_wearable", "garmin");

  const resumed = w.g.AthlevoConnect.resumeAfterConnect();
  await wait(20);
  t("detection DOES start for a real connection",
    /Checking for workouts/.test(w.dom.html), visible(w.dom.html).slice(0, 70));
  await resumed; await wait(60);
  t("...and diagnose polling runs", w.net.some(r => r.url.includes("action=diagnose")));
  t("the guided-setup flag is retained while setup is live",
    w.g.sessionStorage.getItem("athlevo_guided_setup") === "1");
}

section("3. providerStatus() FAILS");
{
  const w = makeWorld({ statusFails: true });
  w.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  w.g.sessionStorage.setItem("athlevo_guided_wearable", "garmin");

  await w.g.AthlevoConnect.resumeAfterConnect();
  await wait(60);

  t("an unreachable server is NOT treated as connected",
    !/Checking for workouts/.test(w.dom.html));
  t("no detection polling started",
    w.net.filter(r => r.url.includes("action=diagnose")).length === 0);
  t("the athlete lands somewhere recoverable",
    /isn.t connected yet/.test(visible(w.dom.html)));
  t("the stale flag is cleared so a reload cannot loop",
    w.g.sessionStorage.getItem("athlevo_guided_setup") === null);
}

section("4/6. Reloads while disconnected cannot recreate the loop");
{
  // Each makeWorld() is a fresh page load; sessionStorage is carried across.
  const carried = new Map([["athlevo_guided_setup", "1"], ["athlevo_guided_wearable", "garmin"]]);
  let everDetected = false, totalDiagnose = 0, flagAfter = "1";

  for (let reload = 0; reload < 3; reload++) {
    const w = makeWorld({ providerConnected: false });
    carried.forEach((v, k) => w.g.sessionStorage.setItem(k, v));
    await w.g.AthlevoConnect.resumeAfterConnect();
    await wait(40);
    if (/Checking for workouts/.test(w.dom.html)) everDetected = true;
    totalDiagnose += w.net.filter(r => r.url.includes("action=diagnose")).length;
    flagAfter = w.g.sessionStorage.getItem("athlevo_guided_setup");
    carried.clear();
    ["athlevo_guided_setup", "athlevo_guided_wearable"].forEach(k => {
      const v = w.g.sessionStorage.getItem(k); if (v !== null) carried.set(k, v);
    });
  }

  t("three reloads NEVER reach the detection screen", everDetected === false);
  t("...and never emit a single diagnose", totalDiagnose === 0, String(totalDiagnose));
  t("the flag stays cleared across reloads", flagAfter === null);
}

section("5. Reload after a GENUINE connection still resumes");
{
  const w = makeWorld({ providerConnected: true });
  w.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  const resumed = w.g.AthlevoConnect.resumeAfterConnect();
  await wait(20);
  t("a real connection resumes detection after a reload",
    /Checking for workouts/.test(w.dom.html));
  await resumed; await wait(60);
  t("...and reaches the import pipeline", w.net.some(r => r.url.includes("action=diagnose")));
}

section("No automatic path infers connectivity from sessionStorage alone");
{
  const src = readFileSync("./js/onboardingConnect.js", "utf8");
  const fn = src.slice(src.indexOf("async function resumeAfterConnect"),
                       src.indexOf("function notConnectedYet"));
  t("resumeAfterConnect asks the SERVER before detecting",
    /await DS\(\)\.status\(\)/.test(fn));
  t("...and that check precedes beginDetection()",
    fn.indexOf("DS().status()") < fn.indexOf("beginDetection()"));
  t("a non-true connected value never proceeds",
    /status\.connected !== true/.test(fn));
  t("a thrown status is treated as NOT connected", /status = null;/.test(fn));
  t("the guard lives in resumeAfterConnect, covering every caller",
    !/providerStatus/.test(readFileSync("./index.html", "utf8")
      .slice(0, readFileSync("./index.html", "utf8").indexOf("resumeAfterConnect(); return;"))
      .slice(-400)));
}

/* ══════ post-consent: did our callback run at all? ═════════════════ */

section("A misrouted provider redirect is detectable, and never silent");
{
  const html = readFileSync("./index.html", "utf8");
  const api = readFileSync("./api/providers/index.js", "utf8");

  /*
   * The invariant this rests on: EVERY exit from actionCallback redirects with
   * ?intervals=<state>. If the browser arrives without it, the callback did
   * not run — regardless of whether consent succeeded.
   */
  const cb = api.slice(api.indexOf("async function actionCallback"),
                       api.indexOf("async function actionFinalize"));
  const exits = (cb.match(/return backToApp\(/g) || []).length;
  t("actionCallback has multiple exits", exits >= 8, String(exits));
  // Exclude backToApp's own body — its `return response.status(302).end()`
  // IS the redirect, not an exit that bypasses one.
  const body = cb.slice(cb.indexOf("const q = request.query"));
  t("EVERY exit redirects through backToApp — none returns silently",
    !/return response\.(status|json|end)/.test(body), (body.match(/return response\.[a-z]+/g) || []).join(","));
  t("backToApp always sets the intervals parameter",
    /target\.searchParams\.set\("intervals", status\)/.test(cb));

  // Run the real capture block against a misrouted redirect.
  const capture = html.slice(html.indexOf("(function captureOAuthReturn(){"),
                             html.indexOf("})();\n</script>") + 5);
  const CODE = "AUTHCODE-must-never-be-logged";
  const run = (search) => {
    const trail = [];
    const store = new Map();
    const win = { location: { search, pathname: "/index.html" },
                  history: { replaceState() {} }, console: { log() {} } };
    const ss = { getItem: k => (store.has(k) ? store.get(k) : null),
                 setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    new Function("window", "sessionStorage", "URLSearchParams", "console", capture)(
      win, ss, URLSearchParams, win.console);
    const raw = ss.getItem("athlevo_oauth_trail");
    return { trail: JSON.parse(raw || "[]"), raw: raw || "", win };
  };

  const mis = run(`?code=${CODE}&state=abc.def`);
  t("a raw code+state with no intervals param is flagged",
    mis.trail.some(s => s.stage === "provider_redirect_misrouted"),
    mis.trail.map(s => s.stage).join(">") || "(empty)");
  t("...recording presence, not the code",
    !mis.raw.includes(CODE) && mis.trail.some(s => s.hasCode === true));
  t("...and where the browser landed",
    mis.trail.some(s => s.landedOn === "/index.html"));
  t("no OAuth return snapshot is fabricated", !mis.win.__athlevoOAuthReturn);

  const ok = run("?intervals=pending&completion=" + "z".repeat(43));
  t("a REAL callback return is still detected normally",
    ok.trail.some(s => s.stage === "oauth_return_detected"));
  t("...and is NOT flagged as misrouted",
    !ok.trail.some(s => s.stage === "provider_redirect_misrouted"));

  const plain = run("");
  t("an ordinary page load records nothing", plain.trail.length === 0);
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
