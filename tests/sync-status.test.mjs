/*
 * Athlevo — Training Data Status (sync confidence).
 *
 * Loads the REAL js/syncStatus.js and exercises its pure state machine, its
 * rendered card for all six states, the skeleton loader, the import banner,
 * and new-import detection. Nothing is mocked; the component is presentation
 * only (it delegates every action to the existing frozen handlers).
 *
 * Run: node tests/sync-status.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const src = readFileSync("./js/syncStatus.js", "utf8");
const win = { console: { log() {} }, document: null };
new Function("window", src)(win);
const S = win.AthlevoSyncStatus;

const NOW = Date.parse("2026-07-22T09:00:00");
const run = (over = {}) => Object.assign({
  id: "act9", workout_type: "Easy Run", distance_meters: 8200,
  start_date: "2026-07-22T06:30:00"
}, over);

/* ══════ deriveState — six clear states + loading ══════════════════════ */

section("Every sync state is derived unambiguously");
{
  t("loading → skeleton state", S.deriveState({ loading: true }).key === "loading");
  t("no wearable connected → none", S.deriveState({ connected: false }).key === "none");
  t("connected + workouts → connected (healthy)",
    S.deriveState({ connected: true, count: 146 }).key === "connected");
  t("connected + zero workouts → waiting for first workout",
    S.deriveState({ connected: true, count: 0 }).key === "waiting");
  t("reconnect_required → connection lost",
    S.deriveState({ connected: true, status: "reconnect_required", count: 5 }).key === "lost");
  t("explicit syncing flag → sync in progress",
    S.deriveState({ connected: true, syncing: true, count: 5 }).key === "syncing");
  t("a status error → sync failed",
    S.deriveState({ error: true, connected: true, count: 5 }).key === "failed");
  t("provider unavailable → coming soon",
    S.deriveState({ available: false }).key === "unavailable");
}

/* ══════ the card renders the right thing for each state ═══════════════ */

section("Connected & healthy card shows the reassuring detail");
{
  const model = S.deriveState({ connected: true, count: 146, provider: "Garmin",
    latest: run(), lastSyncTs: NOW - 120000 });
  const html = S.renderCardHTML(model, NOW);
  t("names the connected provider", /Garmin connected/.test(html));
  t("shows a healthy green dot", /ss-dot-good/.test(html));
  t("shows last sync as relative time", /2 minutes ago/.test(html));
  t("shows the imported count", /Activities imported<\/span><b>146/.test(html));
  t("shows the latest workout one-liner", /Easy Run • 8\.2 km • Today/.test(html));
  t("confirms everything is working", /Everything is working normally/.test(html) && /ss-status ok/.test(html));
  t("offers Check now + Disconnect", /Check now/.test(html) && /Disconnect/.test(html));
}

section("Each state explains exactly what to do next");
{
  const card = k => S.renderCardHTML(S.deriveState(k), NOW);
  const none = card({ connected: false });
  t("no wearable → Connect", /No wearable connected/.test(none) && /AthlevoSyncStatus\.action\('connect'\)/.test(none));

  const waiting = card({ connected: true, count: 0 });
  t("waiting → Open Sync Partner + guidance", /Waiting for your first workout/.test(waiting) &&
    /Open Sync Partner/.test(waiting) && /Finish linking your watch/.test(waiting));

  const lost = card({ connected: true, status: "reconnect_required", count: 3 });
  t("connection lost → Reconnect, red dot", /Connection lost/.test(lost) && /Reconnect/.test(lost) && /ss-dot-bad/.test(lost));

  const failed = card({ error: true, connected: true, count: 3 });
  t("sync failed → Reconnect + reassurance data is safe", /Sync failed/.test(failed) && /your data is safe/.test(failed));

  const syncing = card({ connected: true, syncing: true, count: 3 });
  t("syncing → pulsing dot, checking copy", /ss-dot-sync/.test(syncing) && /Checking for new workouts/.test(syncing));
}

/* ══════ skeleton loader — never a blank area ═════════════════════════ */

section("Loading shows a skeleton, never a blank card");
{
  const html = S.renderCardHTML(S.deriveState({ loading: true }), NOW);
  t("renders a skeleton with shimmer blocks", /ss-skeleton/.test(html) && /ss-sk-block/.test(html));
  t("marks itself busy for assistive tech", /aria-busy="true"/.test(html));
  const css = readFileSync("./index.html", "utf8");
  t("the shimmer animation is defined", /@keyframes ssShimmer/.test(css));
  t("reduced-motion disables the shimmer", /prefers-reduced-motion[^}]*\.ss-sk[\s\S]{0,40}animation:none/.test(css) ||
    /\.ss-sk,\.ss-dot-sync\{animation:none\}/.test(css));
}

/* ══════ import success banner (Part 4) ═══════════════════════════════ */

section("A new workout shows a subtle success banner, not a popup");
{
  const html = S.renderBannerHTML(run({ workout_type: "Easy Run" }), NOW);
  t("confirms the import by name", /Easy Run imported/.test(html));
  t("says Athlevo analyzed it", /Athlevo analyzed your workout/.test(html));
  t("offers 'View analysis →'", /View analysis →/.test(html) && /AthlevoSyncStatus\.viewLatest\(\)/.test(html));
  t("is dismissable, not intrusive", /ss-banner-x/.test(html) && /dismissBanner/.test(html));
  t("no modal/popup wrapper", !/modal|dialog|overlay/i.test(html));
}

section("New-import detection fires once per new activity");
{
  const acts = [run({ id: "a3", start_date: "2026-07-22T06:00:00" }),
    run({ id: "a2", start_date: "2026-07-21T06:00:00" }),
    run({ id: "a1", start_date: "2026-07-20T06:00:00" })];
  const found = S.detectNewImport(acts, "a2");
  t("detects the newest unseen activity", found && found.id === "a3");
  t("does not re-fire for an already-seen newest", S.detectNewImport(acts, "a3") === null);
  t("empty history → nothing to announce", S.detectNewImport([], null) === null);
}

/* ══════ connection management (Part 5) ═══════════════════════════════ */

section("Connection management offers the right controls per state");
{
  const labels = k => S.actionsFor(S.deriveState(k).key).map(a => a.act);
  t("healthy → can check now and disconnect",
    labels({ connected: true, count: 5 }).join() === "check,disconnect");
  t("lost → can reconnect and open partner",
    labels({ connected: true, status: "reconnect_required", count: 5 }).join() === "reconnect,openPartner");
  t("none → can connect", labels({ connected: false }).join() === "connect");
  t("actions delegate to existing frozen handlers only",
    /connectIntervals/.test(src) && /disconnectIntervals/.test(src) && /openSyncPartner/.test(src) &&
    /connectTrainingData/.test(src) && /root\.AthlevoBrain/.test(src) && /root\.AthlevoPlan/.test(src));
  t("the component never fetches or mutates data itself (read-only)",
    !/supabase|fetch\(|providerRequest|\.insert\(|\.update\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
}

/* ══════ personas (Part 8) ════════════════════════════════════════════ */

section("Personas");
{
  // 1. First sync — freshly connected, workouts have landed.
  const first = S.renderCardHTML(S.deriveState({ connected: true, count: 146, latest: run(), lastSyncTs: NOW - 60000 }), NOW);
  t("first sync: shows the count and healthy status", /146/.test(first) && /Everything is working normally/.test(first));

  // 2. Repeat sync — returning user, recent sync.
  const repeat = S.renderCardHTML(S.deriveState({ connected: true, count: 152, latest: run({ start_date: "2026-07-22T07:30:00" }), lastSyncTs: NOW - 90000 }), NOW);
  t("repeat sync: relative last-sync + latest workout", /minute/.test(repeat) && /Easy Run/.test(repeat));

  // 3. Failed sync.
  t("failed sync: clear failure + retry path", /Sync failed/.test(S.renderCardHTML(S.deriveState({ error: true, connected: true }), NOW)));

  // 4. No workouts yet.
  t("no workouts yet: waiting state, not an error",
    /Waiting for your first workout/.test(S.renderCardHTML(S.deriveState({ connected: true, count: 0 }), NOW)));

  // 5. Multiple connected providers.
  const multi = S.renderCardHTML(S.deriveState({ connected: true, count: 200,
    providers: [{ name: "Garmin", connected: true }, { name: "COROS", connected: true }], latest: run(), lastSyncTs: NOW }), NOW);
  t("multiple providers: each is listed with a status dot", /Garmin/.test(multi) && /COROS/.test(multi) && /ss-prov/.test(multi));

  // 6. Returning user, connection lost since last visit.
  t("returning user with a lost connection is told to reconnect",
    /Reconnect/.test(S.renderCardHTML(S.deriveState({ connected: true, status: "reconnect_required", count: 88 }), NOW)));
}

/* ══════ relative-time formatting ═════════════════════════════════════ */

section("Relative time reads naturally");
{
  t("<45s → Just now", S.formatRelative(NOW - 10000, NOW) === "Just now");
  t("minutes", S.formatRelative(NOW - 5 * 60000, NOW) === "5 minutes ago");
  t("one hour singular", S.formatRelative(NOW - 60 * 60000, NOW) === "1 hour ago");
  t("days", S.formatRelative(NOW - 3 * 86400000, NOW) === "3 days ago");
  t("null timestamp → null", S.formatRelative(null, NOW) === null);
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
