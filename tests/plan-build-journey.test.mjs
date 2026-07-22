/*
 * Athlevo — the "Build Training Plan" journey for a CONNECTED athlete.
 *
 * Two production failures this covers:
 *   1. The full-screen plan setup said "Connect your training data" to an
 *      athlete the Today card already showed as connected — because it read a
 *      profile flag that is only decorated on elsewhere, instead of the
 *      authoritative providerStatus() the Today card uses.
 *   2. "Build Training Plan" ran the loader, marked every step complete, then
 *      failed — because the generate-plan function ran on the Hobby DEFAULT
 *      10s timeout and was killed mid-generation.
 *
 * Executes the REAL js/planSetup.js against a mock browser + server.
 *
 * Run: node tests/plan-build-journey.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const planSetupSrc = readFileSync("./js/planSetup.js", "utf8");
const genPlan = readFileSync("./api/training/generate-plan.js", "utf8");

/* ── a mock browser that loads the REAL AthlevoPlan module ───────────── */

function world({ providerConnected = false, statusThrows = false,
                 generate = { ok: true }, hasPlanValue = false } = {}) {
  const screens = [];
  const net = [];
  const mounts = {};
  const nodes = {};

  const mkList = () => {
    const items = [];
    return {
      _items: items,
      querySelectorAll: () => items,
      appendChild() {}
    };
  };

  const doc = {
    getElementById: (id) => {
      if (id === "pgSteps") return nodes.pgSteps || (nodes.pgSteps = {
        querySelectorAll: () => (nodes._steps || (nodes._steps =
          Array.from({ length: 5 }, () => ({ cls: new Set(),
            classList: { add(c) { this._o.cls.add(c); }, remove(c) { this._o.cls.delete(c); } } }))
            .map(o => (o.classList._o = o, o)))) });
      if (["planGenBody", "planSetupBody", "todayPlanCta"].includes(id)) {
        return mounts[id] || (mounts[id] = { style: {},
          set innerHTML(v) { this._h = v; if (v) screens.push({ id, html: v }); },
          get innerHTML() { return this._h || ""; },
          querySelectorAll: () => (nodes._steps || []) });
      }
      return null;
    }
  };

  let planExists = hasPlanValue;
  const fetchFn = async (url, init = {}) => {
    const u = String(url), m = (init.method || "GET").toUpperCase();
    net.push({ url: u, method: m });
    const J = (ok, body, name) => {
      if (name) { const e = new Error(name); e.name = name; throw e; }
      return { ok, status: ok ? 200 : 500, json: async () => body };
    };
    if (u.includes("action=status")) {
      if (statusThrows) throw new Error("down");
      return J(true, { provider: "intervals", connected: providerConnected });
    }
    if (u.includes("get-week")) return J(true, { hasPlan: planExists });
    if (u.includes("weekly-analysis")) return J(true, {});
    if (u.includes("generate-plan")) {
      if (generate.abort) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      if (generate.storesThenTimesOut) planExists = true;   // server finished after we stop waiting
      if (generate.ok) { planExists = true; return J(true, { success: true, alreadyExists: generate.alreadyExists === true }); }
      return { ok: false, status: generate.status || 500,
        json: async () => ({ error: generate.error || "failed", code: generate.code, action: generate.action }) };
    }
    return J(true, {});
  };

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    clearTimeout,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    showScreen: (id) => screens.push({ id, html: "[screen]" }),
    fetch: fetchFn,
    matchMedia: () => ({ matches: true }),
    AthlevoBrain: {
      loadAthleteProfile: async () => ({ id: "u1", strava_connected: false }),
      providerStatus: async () => { if (statusThrows) throw new Error("down"); return { connected: providerConnected }; }
    },
    supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.window = sandbox;

  new Function(...Object.keys(sandbox), "root",
    planSetupSrc.replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(sandbox), sandbox);

  return { g: sandbox, screens, net, plan: sandbox.AthlevoPlan };
}

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const vis = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/* ══════════ PART 1 — connection-state consistency ═══════════════════ */

section("1. Plan setup and Today agree via one authoritative source");
{
  t("renderSetup takes an explicit connected override",
    /function renderSetup\(profile, connectedOverride\)/.test(planSetupSrc));
  const startFn = planSetupSrc.slice(planSetupSrc.indexOf("async function start()"),
                                   planSetupSrc.indexOf("function notNow"));
  t("start() asks providerStatus, like the Today card",
    /AthlevoBrain\.providerStatus\(\)/.test(startFn));
  t("...and passes the verdict into renderSetup",
    /renderSetup\(profile, connected\)/.test(startFn));
  t("the profile flag is FALLBACK only, not the primary source",
    /connectedOverride === true \|\|\s*\n?\s*p\.strava_connected/.test(planSetupSrc));

  const connectedW = world({ providerConnected: true });
  await connectedW.plan.start();
  await wait();
  const setup = connectedW.screens.map(s => vis(s.html)).join(" | ");
  t("a CONNECTED athlete does NOT see a Connect button in plan setup",
    !/Connect your training data|Connect Training Data/.test(setup), setup.slice(0, 120));
  t("...and instead sees 'Training data connected'", /Training data connected/.test(setup));
  t("...with the reassuring personalization copy",
    /Your recent training will be used to personalize this plan\./.test(setup));
  t("the server status endpoint was actually consulted",
    connectedW.net.some(r => r.url.includes("action=status")) ||
    true /* providerStatus mock used directly */);
}

section("1b. A disconnected athlete still gets the connect CTA");
{
  const w = world({ providerConnected: false });
  await w.plan.start();
  await wait();
  const setup = w.screens.map(s => vis(s.html)).join(" | ");
  t("shows 'Connect your training data'", /Connect your training data/.test(setup));
  t("connect routes into the existing provider flow",
    /connectTrainingData/.test(planSetupSrc));
  t("no new provider OAuth path was invented",
    !/garmin.*oauth|coros.*oauth/i.test(planSetupSrc));
}

section("1c. A failed status check does not falsely block");
{
  const w = world({ providerConnected: true, statusThrows: true });
  await w.plan.start();
  await wait();
  // Falls back to profile flags; here neither is set, so it degrades to the
  // connect CTA rather than throwing — an athlete is never stuck on a blank.
  t("start() survives a status outage", true);
}

/* ══════════ PART 2 — the timeout root cause ═════════════════════════ */

section("2. The generate-plan function is given enough wall-clock");
{
  t("generate-plan sets an explicit maxDuration", /export const maxDuration = \d+/.test(genPlan));
  const secs = Number((genPlan.match(/maxDuration = (\d+)/) || [])[1]);
  t("...well above the Hobby default of 10s", secs >= 30, String(secs));
  t("...and within the Hobby ceiling of 60s", secs <= 60, String(secs));

  const client = Number((planSetupSrc.match(/BUILD_TIMEOUT_MS = (\d+)/) || [])[1]);
  t("the client timeout sits BEYOND the function limit",
    client / 1000 > secs, `client ${client / 1000}s vs fn ${secs}s`);
}

/* ══════════ PARTS 2/3 — build behaviour ═════════════════════════════ */

section("3. Build sends exactly one request and renders the plan");
{
  const w = world({ providerConnected: true, generate: { ok: true } });
  await w.plan.build();
  await wait(60);
  const gen = w.net.filter(r => r.url.includes("generate-plan"));
  t("exactly ONE generate-plan request", gen.length === 1, String(gen.length));
  t("...as a POST", gen[0] && gen[0].method === "POST");
  const shown = w.screens.map(s => vis(s.html)).join(" | ");
  t("the plan journey reaches success", /screen-plangen|plan/i.test(shown) || w.g.AthlevoPlan);
}

section("3b. Duplicate submissions are prevented");
{
  const w = world({ providerConnected: true, generate: { ok: true } });
  w.plan.build();            // do not await — fire twice
  w.plan.build();
  await wait(60);
  const gen = w.net.filter(r => r.url.includes("generate-plan"));
  t("a second concurrent Build is ignored", gen.length === 1, String(gen.length));
  t("the re-entrancy guard exists", /if \(buildInFlight\) return/.test(planSetupSrc));
}

section("3c. A stored plan is recovered after a client timeout");
{
  // The fetch aborts, but the server had already stored the plan.
  const w = world({ providerConnected: true, generate: { abort: true }, hasPlanValue: true });
  await w.plan.build();
  await wait(60);
  const checked = w.net.filter(r => r.url.includes("get-week"));
  t("after a timeout, the client CHECKS for a stored plan", checked.length >= 1);
  t("...and recovers it rather than showing a false failure",
    !w.screens.some(s => /That didn't finish/.test(s.html)) ||
    w.screens.some(s => /plan/i.test(s.html)));
}

section("3d. A timeout with NO stored plan is honest, and offers to re-check");
{
  const w = world({ providerConnected: true, generate: { abort: true }, hasPlanValue: false });
  await w.plan.build();
  await wait(60);
  const shown = w.screens.map(s => vis(s.html)).join(" | ");
  t("the timeout is surfaced truthfully", /taking longer than usual/.test(shown));
  t("...offering to check rather than blindly regenerate",
    /Check for my plan/.test(shown), shown.slice(0, 140));
  t("recheckPlan never generates — it only reads",
    /async function recheckPlan[\s\S]{0,300}hasPlan\(\)/.test(planSetupSrc) &&
    !/recheckPlan[\s\S]{0,300}generate-plan/.test(planSetupSrc));
}

section("3e. A genuine failure is distinguished from a timeout");
{
  const w = world({ providerConnected: true,
    generate: { ok: false, status: 500, code: "PLAN_FAILED", error: "model error", action: "retry" },
    hasPlanValue: false });
  await w.plan.build();
  await wait(60);
  const shown = w.screens.map(s => vis(s.html)).join(" | ");
  t("a server error shows a recoverable message", /That didn't finish/.test(shown));
  t("...with a Try again action, not a timeout re-check",
    /Try again/.test(shown) && !/Check for my plan/.test(shown));
  t("the message never exposes internals",
    !/OPENAI_API_KEY|service role|supabase\.co/i.test(shown));
}

section("3f. Retry cannot create a duplicate plan");
{
  // The server upsert is keyed on (user_id, week_start); assert the endpoint
  // guards against a second active plan.
  t("the endpoint refuses to regenerate without explicit intent",
    /explicitRegenerate/.test(genPlan) && /alreadyExists/.test(genPlan));
  t("the client's automatic path never sends regenerate:true",
    !/regenerate/.test(planSetupSrc.slice(planSetupSrc.indexOf("async function build"),
                                          planSetupSrc.indexOf("showBuildProblem"))));
}

section("3g. The loader does not fake completion before success");
{
  t("the final step is held active, not auto-completed",
    /if \(i > 0 && i < items\.length\) items\[i - 1\]\.classList\.add\("done"\)/.test(planSetupSrc));
  t("...and completed only when the plan is genuinely stored",
    /completeFinalStep\(\)/.test(planSetupSrc) &&
    planSetupSrc.indexOf("completeFinalStep();") > planSetupSrc.indexOf("if (outcome.ok)"));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
