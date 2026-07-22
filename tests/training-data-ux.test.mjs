/*
 * Athlevo — ONE training-data connection.
 *
 * Athlevo aggregates through a provider layer, but the athlete was being shown
 * four separate connection rows (Strava, Intervals.icu, Garmin, COROS) — three
 * of which could not actually be connected — and a setup card whose step 1 was
 * gated on Strava specifically. An athlete with a working provider connection
 * therefore kept seeing an unfinished "Connect Strava" step forever.
 *
 * Asserts the consolidated experience against the REAL shipped files, plus the
 * server contract for disconnect and ownership release.
 *
 * Run: node tests/training-data-ux.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.INTERVALS_CLIENT_ID = "cid";
process.env.INTERVALS_CLIENT_SECRET = "sec";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.APP_URL = "https://app.test";

const handler = (await import("../api/providers/index.js")).default;

let p = 0, f = 0;
const real = console.log;
const t = (n, c, e) => { c ? (p++, real("PASS — " + n))
  : (f++, real("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => real(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const planSetup = readFileSync("./js/planSetup.js", "utf8");
const brain = readFileSync("./js/brain.js", "utf8");

const visible = (s) => String(s).replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/* ══════════ 1. Today setup card ═══════════════════════════════════ */

section("1. The Today setup card talks about training, not Strava");
{
  const fn = planSetup.slice(planSetup.indexOf("function renderTodayCta"),
                             planSetup.indexOf("function connectTrainingData"));

  t("title is 'Set up your training'", /Set up your training/.test(fn));
  t("copy names the two steps generically",
    /Step 1 — connect your training data\. Step 2 — build your training plan\./.test(fn));
  t("the connection CTA is 'Connect Training Data'", /Connect Training Data/.test(fn));
  t("the plan CTA is 'Build Training Plan'", /Build Training Plan/.test(fn));

  t("NOTHING in the card says 'Connect Strava'", !/Connect Strava/.test(fn));
  t("...nor 'Build My Coach' — the athlete builds a plan, not a coach",
    !/Build My Coach/.test(fn));
  t("the connect action does NOT call connectStrava()", !/connectStrava\(\)/.test(fn));

  t("connect routes into the EXISTING guided provider flow",
    /AthlevoPlan\.connectTrainingData\(\)/.test(fn) &&
    /AthlevoConnect\.start\(\)/.test(planSetup));
  t("...falling back to the existing brain connector, not a new OAuth path",
    /AthlevoBrain\.connectIntervals\(\)/.test(planSetup));
  t("no new provider OAuth flow was invented",
    !/garmin.*oauth|coros.*oauth/i.test(planSetup));

  t("Build Training Plan still invokes the existing plan action",
    /onclick="AthlevoPlan\.start\(\)">Build Training Plan/.test(fn));
}

section("1b. Step 1 is satisfied by ANY provider connection");
{
  const fn = planSetup.slice(planSetup.indexOf("function renderTodayCta"),
                             planSetup.indexOf("function connectTrainingData"));
  t("an explicit connected flag is honoured", /connectedOverride === true/.test(fn));
  t("a provider connection counts, not just Strava",
    /profile\.intervals_connected === true/.test(fn));

  const refresh = planSetup.slice(planSetup.indexOf("async function refreshTodayCta"));
  t("the state comes from the SERVER, not a decorated profile flag",
    /await window\.AthlevoBrain\.providerStatus\(\)/.test(refresh));
  t("...and is passed into the render", /renderTodayCta\(profile, has, connected\)/.test(refresh));
  t("a failed status check falls back rather than throwing",
    /catch \(e\) \{ \/\* fall back to the profile flags \*\//.test(refresh));

  // Execute the real renderer both ways.
  const run = (profile, connected) => {
    let out = "";
    const doc = { getElementById: () => ({ style: {}, set innerHTML(v) { out = v; }, get innerHTML() { return out; } }) };
    const src = planSetup.slice(planSetup.indexOf("function renderTodayCta"),
                                planSetup.indexOf("function connectTrainingData"));
    new Function("document", src + "\nreturn renderTodayCta;")(doc)(profile, false, connected);
    return visible(out);
  };

  const off = run({ strava_connected: false, intervals_connected: false }, undefined);
  t("a disconnected athlete sees ONE connection CTA", /Connect Training Data/.test(off));
  t("...and is NOT asked for Strava", !/Strava/.test(off), off.slice(0, 90));

  const viaProvider = run({ strava_connected: false, intervals_connected: true }, undefined);
  t("a provider-connected athlete is treated as connected",
    /Build Training Plan/.test(viaProvider) && !/Connect Training Data/.test(viaProvider));
  t("...and never sees 'Connect Strava' again", !/Connect Strava/.test(viaProvider));

  const viaServer = run({ strava_connected: false, intervals_connected: false }, true);
  t("the server's verdict alone is enough", /Build Training Plan/.test(viaServer));

  const viaStrava = run({ strava_connected: true, intervals_connected: false }, undefined);
  t("an existing Strava athlete is still connected — no regression",
    /Build Training Plan/.test(viaStrava));
}

/* ══════════ 2. The You / connections section ══════════════════════ */

section("2. ONE training-data card replaces four provider rows");
{
  ["<b>Strava</b>", "<b>Intervals.icu</b>", "<b>Garmin Connect</b>", "<b>COROS</b>"]
    .forEach(row => t(`the separate ${visible(row)} row is gone`, !html.includes(row)));

  // A single premium Training Data STATUS card (js/syncStatus.js) replaces the
  // old static row and gives sync confidence at a glance.
  t("a single Training Data status card is mounted", /id="syncStatusCard"/.test(html));
  const sync = readFileSync("./js/syncStatus.js", "utf8");
  t("the card is labelled 'Training data'", /Training data/.test(sync));
  t("disconnected copy invites connecting a watch",
    /Connect a watch to sync your workouts automatically/.test(sync));
  t("the CTA is 'Connect'", /label: "Connect"/.test(sync));
  t("Connect uses the existing provider flow",
    /connectTrainingData/.test(sync) && /AthlevoConnect/.test(sync));
  t("no provider is sold in a card heading (implementation detail hidden)",
    !/<h[12][^>]*>[^<]*Intervals/.test(sync));
  t("no Garmin/COROS/Strava connect control remains in this section",
    !/connectGarmin|connectCoros|connectStrava/.test(sync));
}

section("2b. The connected state");
{
  const fn = brain.slice(brain.indexOf("function setIntervalsUi"),
                         brain.indexOf("async function setTrainingDataCount"));
  t("connected status reads 'Connected'", /connected:\s*\{ text: "Connected"/.test(fn));
  t("connected copy describes automatic sync",
    /Your training activities are automatically synced with Athlevo\./.test(fn));
  t("connected copy is applied on live states",
    /copy\.textContent = s\.live \? CONNECTED_COPY : DISCONNECTED_COPY/.test(fn));
  t("Connect is hidden once connected",
    /connectBtn\.style\.display = s\.live \? "none" : ""/.test(fn));
  t("Disconnect appears only when connected",
    /disconnectBtn\.style\.display = s\.live \? "" : "none"/.test(fn));

  const count = brain.slice(brain.indexOf("async function setTrainingDataCount"));
  t("the imported count is shown when genuinely known",
    /activities imported/.test(count));
  t("...from data already loaded, with no extra request",
    /await loadAthleteActivities\(\)/.test(count));
  t("...only in a connected state",
    /\["connected", "synced", "partial"\]\.includes\(row\.dataset\.state\)/.test(count));
  t("a missing count never breaks the card", /catch \(e\)/.test(count));
}

/* ══════════ 3. Disconnect ═════════════════════════════════════════ */

section("3. Disconnect is authenticated, scoped, and releases ownership");
{
  const TOKEN = "ZZprovider-access-tokenZZ";
  function world({ accounts = [] } = {}) {
    const db = { accounts: [...accounts] };
    globalThis.fetch = async (u, i = {}) => {
      const s = String(u), m = (i.method || "GET").toUpperCase();
      const J = (c, b) => ({ ok: c >= 200 && c < 300, status: c,
        headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
      if (s.includes("/auth/v1/user")) {
        const who = String((i.headers && i.headers.Authorization) || "").replace("Bearer ", "");
        return who === "none" ? J(401, {}) : J(200, { id: who });
      }
      if (s.includes("/rest/v1/provider_accounts")) {
        if (m === "PATCH") {
          const id = decodeURIComponent((s.match(/id=eq\.([^&]+)/) || [])[1] || "");
          const row = db.accounts.find(a => a.id === id);
          if (row) Object.assign(row, JSON.parse(i.body));
          return J(200, row ? [row] : []);
        }
        if (s.includes("provider_athlete_id=eq.")) {
          const aid = decodeURIComponent((s.match(/provider_athlete_id=eq\.([^&]+)/) || [])[1] || "");
          return J(200, db.accounts.filter(a => a.provider_athlete_id === aid)
            .map(a => ({ user_id: a.user_id })));
        }
        const uid = decodeURIComponent((s.match(/user_id=eq\.([^&]+)/) || [])[1] || "");
        return J(200, db.accounts.filter(a => a.user_id === uid));
      }
      return J(200, []);
    };
    return db;
  }
  const res = () => { const r = { code: null, body: null, hdrs: {} };
    r.status = c => (r.code = c, r); r.json = b => (r.body = b, r);
    r.setHeader = (k, v) => { r.hdrs[k] = v; }; r.end = () => r; return r; };
  const call = async (action, as) => { const r = res();
    await handler({ method: "POST", headers: as === null ? {} : { authorization: `Bearer ${as}` },
      query: { provider: "intervals", action }, body: {} }, r);
    return r; };

  const row = (user) => ({ id: "pa-" + user, user_id: user, provider: "intervals",
    provider_athlete_id: "i123", access_token: TOKEN, status: "connected" });

  // Only the authenticated user's own connection.
  {
    const db = world({ accounts: [row("A"), row("B")] });
    db.accounts[1].provider_athlete_id = "i999";
    const r = await call("disconnect", "A");
    t("disconnect succeeds for the authenticated user", r.code === 200 && r.body.success === true);
    t("...clearing THEIR credentials", db.accounts[0].access_token === null);
    t("...and marking them disconnected", db.accounts[0].status === "disconnected");
    t("the OTHER user's connection is untouched",
      db.accounts[1].access_token === TOKEN && db.accounts[1].status === "connected");
    t("...including their athlete id", db.accounts[1].provider_athlete_id === "i999");
  }

  // Unauthenticated.
  {
    const db = world({ accounts: [row("A")] });
    const r = await call("disconnect", "none");
    t("an unauthenticated disconnect is rejected", r.code === 401);
    t("...and changes nothing", db.accounts[0].access_token === TOKEN);
  }

  // A user cannot name someone else's row — identity comes from the token.
  {
    const db = world({ accounts: [row("A")] });
    const r = await call("disconnect", "B");
    t("a different user disconnecting finds nothing to disconnect", r.code === 200);
    t("...and cannot touch user A's row", db.accounts[0].access_token === TOKEN);
  }

  // Ownership release — the point of the change.
  {
    const db = world({ accounts: [row("A")] });
    await call("disconnect", "A");
    t("the athlete id is RELEASED on disconnect", db.accounts[0].provider_athlete_id === null);

    /*
     * Without this, findOwnerByProviderAthlete kept matching the abandoned row
     * forever and every future connection hit a stale ALREADY_LINKED.
     */
    const src = readFileSync("./api/providers/index.js", "utf8");
    const owner = src.slice(src.indexOf("async function findOwnerByProviderAthlete"),
                            src.indexOf("async function upsertProviderAccount"));
    t("ownership is matched on provider_athlete_id alone",
      /provider_athlete_id=eq\./.test(owner));

    // So user B can now claim it.
    const stillOwned = db.accounts.some(a => a.provider_athlete_id === "i123");
    t("no row still claims that provider athlete", !stillOwned);
  }

  // The guard itself must NOT be weakened.
  {
    const src = readFileSync("./api/providers/index.js", "utf8");
    t("the ALREADY_LINKED guard still exists in the callback",
      /code: "ALREADY_LINKED"/.test(src));
    t("...and in finalize", (src.match(/ALREADY_LINKED/g) || []).length >= 2);
    t("a LIVE connection still blocks a second Athlevo user",
      /owner\.userId && owner\.userId !== String\(user\.id\)/.test(src));
  }

  // Imported training history is never destroyed.
  {
    const src = readFileSync("./api/providers/index.js", "utf8");
    const fn = src.slice(src.indexOf("async function actionDisconnect"),
                         src.indexOf("/* ═══════════════════════ ACTION: reanalyze"));
    t("disconnect never deletes the provider row", !/method: "DELETE"/.test(fn));
    t("...and never touches activities", !/activities/.test(fn));
    t("the athlete keeps their training history",
      /training history is theirs/.test(fn) || /KEEPS the row/.test(fn));
  }

  t("the client confirms before disconnecting",
    /Disconnect your training data\?/.test(brain));
  t("...and refreshes the setup card afterwards",
    /AthlevoPlan\.refreshTodayCta\(\)/.test(brain));
  t("...returning the card to the disconnected state",
    /setIntervalsUi\("idle"\)/.test(brain));

  /*
   * Provider-side revocation: Intervals.icu documents no token-revocation
   * endpoint, so we do not call one. Disconnecting clears our stored
   * credential; the athlete revokes Athlevo's access from within Intervals if
   * they wish. Asserted so nobody later assumes revocation happens here.
   */
  const src = readFileSync("./api/providers/index.js", "utf8");
  const fn = src.slice(src.indexOf("async function actionDisconnect"),
                       src.indexOf("/* ═══════════════════════ ACTION: reanalyze"));
  t("no unsupported provider revocation call is invented",
    !/revoke/i.test(fn) && !/intervals\.icu/i.test(fn));
}

/* ══════════ Appended: Today setup card states A / B / C ═══════════ */
{
  const real2 = console.log;
  const html2 = readFileSync("./index.html", "utf8");
  const planSetup2 = readFileSync("./js/planSetup.js", "utf8");
  const brain2 = readFileSync("./js/brain.js", "utf8");
  const vis = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  section("No active production renderer emits the old Today strings");
  {
    // Every production file, minus comments, must be free of the old copy.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const files = { "index.html": strip(html2), "planSetup.js": strip(planSetup2),
                    "brain.js": strip(brain2), "train.js": strip(readFileSync("./js/train.js", "utf8")) };
    for (const bad of ["Set up your coach", "Build My Coach", "Connect Strava", "Step 1 — connect Strava"]) {
      for (const [name, src] of Object.entries(files)) {
        t(`'${bad}' is absent from active ${name}`, !src.includes(bad),
          src.includes(bad) ? bad : "");
      }
    }
    // The renderers themselves.
    t("renderTodayCta never renders a Strava CTA",
      !/Connect Strava/.test(planSetup2.slice(planSetup2.indexOf("function renderTodayCta"),
                                              planSetup2.indexOf("function connectTrainingData"))));
    t("renderSetup never renders a Strava CTA or 'Build My Coach'",
      !/Connect Strava|Build My Coach|connectStrava/.test(
        planSetup2.slice(planSetup2.indexOf("function renderSetup"),
                         planSetup2.indexOf("async function start"))));
  }

  // Execute the REAL renderTodayCta across the three states.
  const runCta = (profile, has, connectedOverride) => {
    let out = "";
    const doc = { getElementById: () => ({ style: {}, set innerHTML(v) { out = v; }, get innerHTML() { return out; } }) };
    const src = planSetup2.slice(planSetup2.indexOf("function renderTodayCta"),
                                planSetup2.indexOf("function connectTrainingData"));
    new Function("document", src + "\nreturn renderTodayCta;")(doc)(profile, has, connectedOverride);
    return out;
  };

  section("STATE A — not connected, no plan");
  {
    const out = runCta({ strava_connected: false, intervals_connected: false }, false, false);
    const v = vis(out);
    t("title 'Set up your training'", /Set up your training/.test(v));
    t("two-step generic copy", /Step 1 — connect your training data\. Step 2 — build your training plan\./.test(v));
    t("shows Connect Training Data", /Connect Training Data/.test(v));
    t("shows Build Training Plan", /Build Training Plan/.test(v));
    t("connect uses the existing provider flow",
      /AthlevoPlan\.connectTrainingData\(\)/.test(out));
    t("no Strava CTA", !/Strava/.test(v));
  }

  section("STATE B — connected, no plan");
  {
    const out = runCta({ intervals_connected: true }, false, true);
    const v = vis(out);
    t("title 'Your training is connected'", /Your training is connected/.test(v));
    t("copy points to building the plan next",
      /Your activity history is syncing with Athlevo\. Next, build your personalized training plan\./.test(v));
    t("shows Build Training Plan", /Build Training Plan/.test(v));
    t("does NOT show a redundant Connect button", !/Connect Training Data/.test(v));
    t("no Strava CTA", !/Strava/.test(v));
  }

  section("STATE C — connected, plan exists → no card");
  {
    let hidden = false, cleared = false;
    const doc = { getElementById: () => ({ style: { set display(v) { if (v === "none") hidden = true; } },
      set innerHTML(v) { if (v === "") cleared = true; } }) };
    const src = planSetup2.slice(planSetup2.indexOf("function renderTodayCta"),
                                planSetup2.indexOf("function connectTrainingData"));
    new Function("document", src + "\nreturn renderTodayCta;")(doc)({ intervals_connected: true }, true, true);
    t("the setup card is hidden entirely when a plan exists", hidden);
    t("...and its markup cleared", cleared);
  }

  console.log = real2;
}

console.log(`\n${p} passed, ${f} failed (with Today-states appended)`);
process.exit(f ? 1 : 0);
