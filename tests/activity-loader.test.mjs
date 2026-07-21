/*
 * Athlevo — activity loader windows & pagination.
 *
 * Extracts the REAL loader from js/brain.js and runs it against a Supabase
 * double that enforces PostgREST semantics (range paging, gte filters,
 * server-side `is` filters, 1000-row hard ceiling per request).
 *
 * Proves the 200-row cap regression cannot recur. Run:
 *   node tests/activity-loader.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const brain = readFileSync("./js/brain.js", "utf8");
const DAY = 86400000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

/* ── extract the real loader + its dependencies ─────────────────────── */

function grab(name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, "m");
  const m = brain.match(re);
  if (!m) throw new Error(`could not extract ${name} from brain.js`);
  return m[0];
}
function grabConst(name) {
  const re = new RegExp(`const\\s+${name}\\s*=[\\s\\S]*?;\\n`, "m");
  const m = brain.match(re);
  if (!m) throw new Error(`could not extract const ${name}`);
  return m[0];
}

const SOURCE = [
  grabConst("ACTIVITY_WINDOWS"),
  grabConst("ACTIVITY_PAGE_SIZE"),
  grabConst("ACTIVITY_MAX_ROWS"),
  grabConst("ACTIVITY_CACHE_TTL_MS"),
  grab("resolveActivityWindow"),
  grab("sortActivitiesByStartDesc"),
  grab("loadAthleteActivities"),
  grab("loadAthleteActivitiesUncached"),
  grab("invalidateActivityCache")
].join("\n\n");

/* ── PostgREST-faithful Supabase double ─────────────────────────────── */

function makeClient(rows, spy) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: (table) => {
      const q = { _gte: null, _isNull: [], _range: null, _order: null };
      q.select = () => q;
      q.eq = () => q;
      q.is = (col, val) => { if (val === null) q._isNull.push(col); return q; };
      q.gte = (col, val) => { q._gte = { col, val }; return q; };
      q.order = (col, o) => { q._order = { col, asc: o && o.ascending }; return q; };
      q.range = (from, to) => {
        spy.requests += 1;
        spy.tables.add(table);
        // PostgREST caps a single request at 1000 rows.
        const span = to - from + 1;
        if (span > 1000) {
          return Promise.resolve({ data: null, error: { message: "range too large" } });
        }
        let set = rows.slice();
        // Server-side filters, applied BEFORE paging — the whole point.
        q._isNull.forEach(col => {
          if (col === "raw_data->superseded") {
            set = set.filter(r => !(r.raw_data && r.raw_data.superseded === true));
          }
        });
        if (q._gte) set = set.filter(r => r[q._gte.col] >= q._gte.val);
        set.sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date));
        spy.serverFiltered = set.length;
        const page = set.slice(from, to + 1).map(r => ({
          ...r,
          laps: r.raw_data && r.raw_data.laps,
          superseded: r.raw_data && r.raw_data.superseded
        }));
        return Promise.resolve({ data: page, error: null });
      };
      return q;
    }
  };
}

function run(rows) {
  const spy = { requests: 0, tables: new Set(), serverFiltered: 0, logs: [] };
  const sandbox = {
    supabaseClient: makeClient(rows, spy),
    console: { log: (...a) => spy.logs.push(String(a[0])), warn: (...a) => spy.logs.push(String(a[0])), error: (...a) => spy.logs.push(String(a[0])) }
  };
  const api = new Function(...Object.keys(sandbox), `
    let __activityCache = { key: null, at: 0, data: null };
    let __activityInflight = null;
    ${SOURCE}
    return { loadAthleteActivities, invalidateActivityCache, resolveActivityWindow, ACTIVITY_WINDOWS, ACTIVITY_PAGE_SIZE, ACTIVITY_MAX_ROWS };
  `)(...Object.values(sandbox));
  return { api, spy };
}

/* ── fixtures ───────────────────────────────────────────────────────── */

let ID = 0;
const act = (o) => ({
  id: "a" + (++ID), user_id: "u1", source: "strava", external_activity_id: "x" + ID,
  name: "Run", sport_type: "run", activity_type: "Run",
  distance_meters: 10000, moving_time_seconds: 3000, start_date: iso(now),
  raw_data: {}, ...o
});

// Dean's real production shape: 274 canonical activities over ~3 years.
function dataset274() {
  ID = 0;
  const rows = [];
  for (let i = 0; i < 274; i++) {
    rows.push(act({ start_date: iso(now - i * 4 * DAY) }));   // ~3 years
  }
  return rows;
}

/* ══════════════════════ 274-activity athlete ════════════════════════ */

section("274 canonical activities (real production shape)");
{
  const rows = dataset274();
  /*
   * The loader computes its cutoff at query time, milliseconds after this
   * fixture was built, so an activity sitting EXACTLY on the boundary falls
   * just outside. Assert against the strict interior and allow the boundary
   * item either way — anything more than one row of drift is a real bug.
   */
  const within = (days) => ({
    inclusive: rows.filter(r => Date.parse(r.start_date) >= now - days * DAY).length,
    strict: rows.filter(r => Date.parse(r.start_date) > now - days * DAY).length
  });
  const H = within(400), Rn = within(120);
  const inHistory = H.inclusive, inRecent = Rn.inclusive;

  const { api, spy } = run(rows);
  const full = await api.loadAthleteActivities("full");
  t("full window returns ALL 274 — nothing silently dropped",
    full.length === 274, `${full.length}`);
  t("the 74 previously hidden by the 200 cap are present",
    full.length - 200 === 74, `${full.length - 200}`);

  const { api: a2 } = run(rows);
  const hist = await a2.loadAthleteActivities("history");
  t("history window returns every activity inside 400 days",
    hist.length >= H.strict && hist.length <= H.inclusive,
    `${hist.length}, expected ${H.strict}–${H.inclusive}`);
  t("history is not capped at 200", hist.length > 200 || inHistory <= 200);

  const { api: a3, spy: s3 } = run(rows);
  const rec = await a3.loadAthleteActivities("recent");
  t("recent window returns only ~120 days",
    rec.length >= Rn.strict && rec.length <= Rn.inclusive,
    `${rec.length}, expected ${Rn.strict}–${Rn.inclusive}`);
  t("recent window excludes everything older than 120 days",
    rec.every(r => Date.parse(r.start_date) >= now - 121 * DAY));
  t("history window excludes everything older than 400 days",
    hist.every(r => Date.parse(r.start_date) >= now - 401 * DAY));
  t("recent is cheaper than history (fewer rows)", rec.length < hist.length);
  t("short window costs a single request", s3.requests === 1, `${s3.requests}`);
}

/* ══════════════════════ pagination beyond 1000 ══════════════════════ */

section("Pagination — 1,240 activities");
{
  ID = 0;
  const rows = [];
  for (let i = 0; i < 1240; i++) rows.push(act({ start_date: iso(now - i * 6 * 3600000) }));

  const { api, spy } = run(rows);
  const all = await api.loadAthleteActivities("full");
  t("returns all 1,240 activities across pages", all.length === 1240, `${all.length}`);
  t("used multiple paged requests", spy.requests >= 3, `${spy.requests} requests`);
  t("no request exceeded PostgREST's 1000-row limit", !spy.logs.some(l => /range too large/.test(l)));
  t("newest-first ordering preserved across page boundaries",
    all.every((r, i) => i === 0 || Date.parse(all[i - 1].start_date) >= Date.parse(r.start_date)));
  t("no duplicated rows across pages", new Set(all.map(r => r.id)).size === all.length);

  // Page-boundary exactness: 1000 rows = exactly 2 pages of 500, and the
  // loop must not issue a third pointless request... it must, because a full
  // page means "there may be more". Assert it stops on the first SHORT page.
  ID = 0;
  const exact = [];
  for (let i = 0; i < 1000; i++) exact.push(act({ start_date: iso(now - i * 3600000) }));
  const { api: a2, spy: s2 } = run(exact);
  const r2 = await a2.loadAthleteActivities("full");
  t("exactly 1000 rows: all returned", r2.length === 1000, `${r2.length}`);
  t("...stopping only after a short page", s2.requests === 3, `${s2.requests}`);
}

section("Safety ceiling");
{
  ID = 0;
  const rows = [];
  for (let i = 0; i < 6000; i++) rows.push(act({ start_date: iso(now - i * 3600000) }));
  const { api, spy } = run(rows);
  const all = await api.loadAthleteActivities("full");
  t("stops at the 5,000-row safety ceiling", all.length === 5000, `${all.length}`);
  t("warns when the ceiling is hit", spy.logs.some(l => /safety limit/.test(l)));
  t("does not page unboundedly", spy.requests <= 11, `${spy.requests}`);
}

/* ══════════════ superseded rows must not consume budget ═════════════ */

section("Superseded duplicates never cost a canonical activity");
{
  ID = 0;
  const rows = [];
  // 300 canonical + 300 superseded, interleaved so a client-side filter
  // applied after a cap would lose roughly half the real training.
  for (let i = 0; i < 300; i++) {
    rows.push(act({ start_date: iso(now - i * 2 * DAY) }));
    rows.push(act({ start_date: iso(now - i * 2 * DAY - 3600000),
      source: "intervals", raw_data: { superseded: true, superseded_by: "strava:x" } }));
  }

  const { api, spy } = run(rows);
  const all = await api.loadAthleteActivities("full");
  t("all 300 canonical activities returned despite 300 duplicates",
    all.length === 300, `${all.length}`);
  t("zero superseded rows leak through", all.every(r => r.superseded !== true));
  t("superseded rows filtered SERVER-SIDE (before paging)",
    spy.serverFiltered === 300, `server returned ${spy.serverFiltered}`);

  // The regression itself: under the old behaviour this athlete would have
  // seen only ~100 canonical activities from a 200-row cap.
  const oldBehaviour = rows
    .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date))
    .slice(0, 200)
    .filter(r => !(r.raw_data && r.raw_data.superseded)).length;
  t("old 200-cap would have lost activities; new loader does not",
    oldBehaviour < 300 && all.length === 300, `old would give ${oldBehaviour}`);
}

/* ══════════════════════ windows & contract ══════════════════════════ */

section("Window contract");
{
  const { api } = run(dataset274());
  t("recent = 120 days", api.ACTIVITY_WINDOWS.recent.days === 120);
  t("history = 400 days", api.ACTIVITY_WINDOWS.history.days === 400);
  t("full = unbounded", api.ACTIVITY_WINDOWS.full.days === null);
  t("page size is a real page, not a cap", api.ACTIVITY_PAGE_SIZE === 500);

  t("legacy numeric argument maps to history, never a truncated set",
    api.resolveActivityWindow(200) === "history");
  t("unknown window falls back to history", api.resolveActivityWindow("nonsense") === "history");
  t("no argument defaults to history", api.resolveActivityWindow(undefined) === "history");

  // A legacy caller must not silently get 200 rows any more.
  const { api: a2 } = run(dataset274());
  const legacy = await a2.loadAthleteActivities(200);
  t("loadAthleteActivities(200) no longer returns exactly 200",
    legacy.length !== 200, `${legacy.length}`);
}

section("Caching is per-window");
{
  const rows = dataset274();
  const { api, spy } = run(rows);
  const a = await api.loadAthleteActivities("recent");
  const before = spy.requests;
  const b = await api.loadAthleteActivities("recent");
  t("second call for the same window is served from cache",
    spy.requests === before && a.length === b.length);
  const c = await api.loadAthleteActivities("history");
  t("a DIFFERENT window is not served the recent cache",
    spy.requests > before && c.length !== a.length, `recent=${a.length} history=${c.length}`);
  api.invalidateActivityCache();
  const after = spy.requests;
  await api.loadAthleteActivities("recent");
  t("invalidateActivityCache forces a refetch", spy.requests > after);
}

section("Resilience");
{
  // A mid-page error must return partial data, not throw or return nothing.
  ID = 0;
  const rows = [];
  for (let i = 0; i < 1200; i++) rows.push(act({ start_date: iso(now - i * 3600000) }));
  const spy = { requests: 0, tables: new Set(), serverFiltered: 0, logs: [] };
  const client = makeClient(rows, spy);
  const realFrom = client.from;
  client.from = (tbl) => {
    const q = realFrom(tbl);
    const realRange = q.range;
    q.range = (f, to) => (f >= 1000
      ? Promise.resolve({ data: null, error: { message: "boom" } })
      : realRange(f, to));
    return q;
  };
  const sandbox = { supabaseClient: client, console: { log: (...a) => spy.logs.push(String(a[0])), warn: () => {}, error: (...a) => spy.logs.push(String(a[0])) } };
  const api = new Function(...Object.keys(sandbox), `
    let __activityCache = { key: null, at: 0, data: null };
    let __activityInflight = null;
    ${SOURCE}
    return { loadAthleteActivities };`)(...Object.values(sandbox));
  const partial = await api.loadAthleteActivities("full");
  t("a failed page returns partial data rather than nothing",
    partial.length === 1000, `${partial.length}`);
  t("the failure is logged", spy.logs.some(l => /Could not load athlete activities/.test(l)));
}

section("No numeric call sites remain in production code");
{
  const files = ["brain", "trends", "athlevoScore", "coach", "coachBrainData",
                 "developmentData", "raceDetection", "athleteModel", "workoutAnalysis"];
  const offenders = files.filter(f =>
    /loadAthleteActivities\(\s*\d/.test(readFileSync(`./js/${f}.js`, "utf8")));
  t("every consumer requests a named window", offenders.length === 0, offenders.join(","));

  const windowOf = (f) => {
    const s = readFileSync(`./js/${f}.js`, "utf8");
    return [...s.matchAll(/loadAthleteActivities\("([a-z]+)"\)/g)].map(m => m[1]);
  };
  t("Today/brain uses the cheap recent window", windowOf("brain").includes("recent"));
  t("workout analysis uses recent", windowOf("workoutAnalysis").includes("recent"));
  t("Trends uses history", windowOf("trends").every(w => w === "history"));
  t("Score uses history", windowOf("athlevoScore").includes("history"));
  t("Coach uses history", windowOf("coach").includes("history"));
  t("athlete model uses history", windowOf("athleteModel").every(w => w === "history"));
  t("race detection uses full (all-time bests)", windowOf("raceDetection").includes("full"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
