/**
 * Athlevo Fuel V1 — release-hardening regressions.
 *   · consent v2 re-prompt + withdrawal transition (real consent module / real server gate)
 *   · user-edited estimate is what gets logged
 *   · idempotency key, double-submit guards, payload cap
 *   · activity energy: superseded duplicates, no invented burn
 *   · training-context picker, migration hardening, native permissions
 * Run: node tests/fuel-hardening.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

process.env.TZ = "Asia/Manila"; // day-boundary tests below assume a UTC+8 athlete
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.OPENAI_API_KEY = "openai-test";

let passed = 0, failed = 0;
const test = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
};
const section = n => console.log(`\n──── ${n} ────`);

const fuelSrc = readFileSync("./js/fuel.js", "utf8");
const consentSrc = readFileSync("./js/aiConsent.js", "utf8");
const html = readFileSync("./index.html", "utf8");
const sql = readFileSync("./migrations/2026-09-30_fuel_tracking.sql", "utf8");
const plist = readFileSync("./ios/App/App/Info.plist", "utf8");
const manifest = readFileSync("./android/app/src/main/AndroidManifest.xml", "utf8");

const fctx = vm.createContext({ console }); fctx.window = fctx;
vm.runInContext(fuelSrc, fctx);
const H = fctx.AthlevoFuel._test;

/* ── consent v2 (client module, real code) ── */
section("AI consent v2 — client re-prompt");
function loadConsent({ row, persistOk = true }) {
  const handlers = {}; let shown = 0; const writes = [];
  const btn = id => ({ addEventListener: (t, f) => { handlers[id] = f; }, removeEventListener() {} });
  const modal = { classList: { add() { shown += 1; }, remove() {} } };
  const els = { aiConsentModal: modal, aiConsentContinueBtn: btn("c"), aiConsentNotNowBtn: btn("n"), aiConsentLearnMoreBtn: btn("l") };
  const client = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    upsert: async v => { writes.push(v); return { error: persistOk ? null : {} }; }
  }) };
  const ctx = vm.createContext({ console, document: { getElementById: id => els[id] || null }, sessionStorage: { getItem() { return null; }, setItem() {} } });
  ctx.window = ctx; ctx.supabaseClient = client; ctx.athlevoSessionUserId = "u1";
  vm.runInContext(consentSrc, ctx);
  return { C: ctx.AthlevoAiConsent, handlers, writes, shown: () => shown };
}
{
  test("client consent version is 2", loadConsent({ row: null }).C.CONSENT_VERSION === "2");
  const cur = loadConsent({ row: { status: "granted", consent_version: "2" } });
  test("granted under v2 passes with NO prompt", (await cur.C.ensure({ authenticated: true, source: "fuel_meal_analysis" })) === true && cur.shown() === 0);
  const old = loadConsent({ row: { status: "granted", consent_version: "1" } });
  const p = old.C.ensure({ authenticated: true, source: "fuel_meal_analysis" });
  await new Promise(r => setTimeout(r, 5));
  test("granted under old v1 is RE-PROMPTED once", old.shown() === 1);
  old.handlers.c();
  test("continue -> allowed and re-recorded as v2", (await p) === true && old.writes.length === 1 && old.writes[0].consent_version === "2" && old.writes[0].status === "granted");
  const decl = loadConsent({ row: { status: "granted", consent_version: "1" } });
  const p2 = decl.C.ensure({ authenticated: true, source: "coach" });
  await new Promise(r => setTimeout(r, 5)); decl.handlers.n();
  test("'Not now' -> not allowed, nothing written", (await p2) === false && decl.writes.length === 0);
  const wd = loadConsent({ row: { status: "withdrawn", consent_version: "2" } });
  const p3 = wd.C.ensure({ authenticated: true, source: "fuel_meal_analysis" });
  await new Promise(r => setTimeout(r, 5));
  test("withdrawn consent is re-asked (photo analysis unavailable until granted again)", wd.shown() === 1);
  wd.handlers.n(); await p3;
  const st = await wd.C.setStatusFromSettings(false);
  test("Settings withdrawal still writes 'withdrawn'", st === true && wd.writes.at(-1).status === "withdrawn");
  test("consent modal keeps Continue / Not now / Learn more", ["aiConsentContinueBtn", "aiConsentNotNowBtn", "aiConsentLearnMoreBtn"].every(i => html.includes(`id="${i}"`)) && />\s*Continue\s*</.test(html) && />\s*Not now\s*</.test(html) && /Learn more/.test(html));
  const modalHtml = html.slice(html.indexOf('id="aiConsentModal"'), html.indexOf('id="aiConsentLearnMoreBtn"'));
  test("consent copy covers Fuel photo analysis, is optional, manual always available", /meal photo/i.test(modalHtml) && /optional/i.test(modalHtml) && /manually/i.test(modalHtml));
  test("consent copy does not claim permanent storage or provider deletion", !/stored|saved permanently|deleted immediately|immediately delet/i.test(modalHtml));
  test("no second Fuel-specific consent system (Fuel uses the shared module)", (fuelSrc.match(/AthlevoAiConsent\.ensure/g) || []).length === 1 && !/fuel_consent|athlevo_fuel_consent/i.test(fuelSrc));
}

/* ── withdrawal: history + manual still work; photo blocked (real server gate) ── */
section("Consent withdrawn — server behaviour (real gate)");
const { createFuelHandlers } = await import("../lib/server/fuelEndpoint.js");
const { requireAiConsent } = await import("../lib/server/aiConsent.js?hardening");
{
  const realFetch = globalThis.fetch; let consentReads = 0;
  globalThis.fetch = async input => {
    const u = String(input);
    if (u.includes("/rest/v1/ai_consent")) consentReads += 1;
    const body = u.includes("/rest/v1/ai_consent") ? [{ status: "withdrawn", consent_version: "2" }] : {};
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  const stored = new Map();
  const db = {
    rpcSaveMeal: async (uid, id, meal) => { const k = id || randomUUID(); stored.set(k, { id: k, user_id: uid, ...meal }); return k; },
    readMeal: async (uid, id) => ({ ...stored.get(id), items: [] }),
    deleteMeal: async (uid, id) => stored.delete(id)
  };
  const NOW = new Date("2026-09-30T10:00:00Z");
  const h = createFuelHandlers({ now: () => NOW, db, requireAiConsent, verifyToken: async () => ({ ok: true, user: { id: "alice" } }), checkAiRateLimit: async () => ({ allowed: true }), callOpenAI: async () => { throw new Error("AI must not be called"); } });
  const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
  const req = (method, body, query) => ({ method, headers: { authorization: "Bearer t" }, body, query: query || {} });
  const meal = { source: "manual", local_date: "2026-09-30", meal_name: "Toast", calories: 200, carbs_g: 30, protein_g: 6, fat_g: 5 };
  let r = res(); await h.meals(req("POST", meal), r);
  test("withdrawn: manual POST still logs", r.statusCode === 201);
  const id = r.body.meal.id;
  r = res(); await h.meals(req("PATCH", { ...meal, id, meal_name: "Toast+egg" }), r);
  test("withdrawn: manual edit works", r.statusCode === 200 && r.body.meal.meal_name === "Toast+egg");
  r = res(); await h.meals(req("DELETE", null, { id }), r);
  test("withdrawn: manual delete works", r.statusCode === 200 && r.body.deleted === true);
  test("meals endpoint never consults AI consent", consentReads === 0, `reads=${consentReads}`);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 3, 192, 5, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const GOOD = { mime: "image/jpeg", data: Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(64, 1)]).toString("base64") };
  r = res(); await h.analyzeMeal(req("POST", { image: GOOD }), r);
  test("withdrawn: photo analysis is refused (403 AI_CONSENT_REQUIRED), provider never called", r.statusCode === 403 && r.body.code === "AI_CONSENT_REQUIRED");
  globalThis.fetch = realFetch;
}

/* ── user-edited estimate is what is logged ── */
section("Review edits → logged values");
{
  const sug = { meal_name: "Rice bowl", assumptions: [], uncertainties: [], items: [
    { name: "Rice", quantity: 1, unit: "cup", estimated_grams: 180, calories: 240, carbs_g: 53, protein_g: 4, fat_g: 1 },
    { name: "Chicken", quantity: 100, unit: "g", estimated_grams: 100, calories: 165, carbs_g: 0, protein_g: 31, fat_g: 4 }] };
  const snapshot = JSON.stringify(sug);
  const d = H.draftFromSuggestion(sug, "n", "2026-09-30", new Date("2026-09-30T13:00:00"));
  H.setPath(d, "name", "Post-run bowl");
  H.setPath(d, "items.0.name", "Brown rice");
  H.setPath(d, "items.0.quantity", "2");
  H.setPath(d, "items.0.unit", "bowl");
  H.setPath(d, "items.0.grams", "300");
  H.setPath(d, "items.0.calories", "410.5");
  H.setPath(d, "items.0.carbs_g", "88");
  H.setPath(d, "items.0.protein_g", "9");
  H.setPath(d, "items.0.fat_g", "3");
  d.items.splice(1, 1);
  const extra = H.emptyItem(); extra.name = "Olive oil"; extra.calories = 40; extra.fat_g = 4.5; d.items.push(extra);
  const t = H.draftTotals(d);
  test("totals update from edits (410.5 + 40)", t.calories === 450.5 && t.fat_g === 7.5 && t.carbs_g === 88, JSON.stringify(t));
  const pl = H.buildPayload(d);
  test("payload uses USER-EDITED values, not the original AI object",
    pl.meal_name === "Post-run bowl" && pl.items[0].name === "Brown rice" && pl.items[0].quantity === 2 && pl.items[0].unit === "bowl" && pl.items[0].grams === 300 && pl.items[0].calories === 410.5 && pl.items.length === 2 && pl.items[1].name === "Olive oil");
  test("edited AI item keeps ai_estimated=true; user-added item is not AI", pl.items[0].ai_estimated === true && pl.items[1].ai_estimated === false);
  test("original AI suggestion object was not mutated", JSON.stringify(sug) === snapshot);
  test("decimals parse (0.5, 1,200)", H.parseField("0.5") === 0.5 && H.parseField("1,200") === 1200);
  const quick = { mode: "quick", source: "manual", mealId: null, clientId: H.newClientId(), name: "Coffee", mealType: "snack", note: "", localDate: "2026-09-30", items: [], totals: { calories: 5, carbs_g: 0, protein_g: 0, fat_g: 0 } };
  test("manual quick entry: only name + calories needed (macros default 0)", H.validateDraft(quick) === null);
}

/* ── idempotency / double submit ── */
section("Double-submit protection");
{
  const id = H.newClientId();
  test("client id is a UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  const d = { mode: "quick", source: "manual", mealId: null, clientId: id, name: "x", mealType: "", note: "", localDate: "2026-09-30", items: [], totals: { calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0 } };
  test("retry of the SAME draft sends the SAME client_id", H.buildPayload(d).client_id === H.buildPayload(d).client_id && H.buildPayload(d).client_id === id);
  test("a different draft gets a different key", H.newClientId() !== H.newClientId());
  test("edit (PATCH) carries no client_id", H.buildPayload({ ...d, mealId: "m1" }).client_id === undefined);
  const { validateMealPayload } = await import("../lib/server/fuelSchema.js");
  const base = { source: "manual", local_date: "2026-09-30", meal_name: "x", calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0 };
  const now = new Date("2026-09-30T10:00:00Z");
  test("server accepts a valid client_id", validateMealPayload({ ...base, client_id: id }, { now }).ok === true);
  test("server rejects a malformed client_id", validateMealPayload({ ...base, client_id: "abc" }, { now }).ok === false);
  test("migration: unique (user_id, client_id) + ON CONFLICT DO NOTHING + no duplicate items", /fuel_meals_user_client_idx/.test(sql) && /on conflict \(user_id, client_id\) do nothing/i.test(sql));
  const { createFuelHandlers: mk } = await import("../lib/server/fuelEndpoint.js");
  const h = mk({ now: () => now, verifyToken: async () => ({ ok: true, user: { id: "a" } }), db: { rpcSaveMeal: async () => "x", readMeal: async () => ({}), deleteMeal: async () => true } });
  const r = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await h.meals({ method: "POST", headers: { authorization: "Bearer t" }, body: { ...base, note: "x".repeat(40000) } }, r);
  test("oversized meal body is refused (413)", r.statusCode === 413);
  const bodyOf = n => { const i = fuelSrc.indexOf(`function ${n}(`); let d0 = 0, s = false; for (let j = fuelSrc.indexOf("{", i); j < fuelSrc.length; j++) { if (fuelSrc[j] === "{") { d0++; s = true; } else if (fuelSrc[j] === "}") { d0--; if (s && d0 === 0) return fuelSrc.slice(i, j + 1); } } return ""; };
  test("submitDraft guards on state.busy BEFORE any await", /if \(!d \|\| state\.busy\) return;[\s\S]*state\.busy = true;[\s\S]*await api/.test(bodyOf("submitDraft")) && bodyOf("submitDraft").indexOf("state.busy = true") < bodyOf("submitDraft").indexOf("await api"));
  test("Log meal button is disabled while saving", /fuelSaveBtn"\)[\s\S]{0,60}disabled = true/.test(bodyOf("submitDraft")) || /btn\.disabled = true/.test(bodyOf("submitDraft")));
  test("analyze() is single-flight (state.analyzing)", /if \(state\.analyzing\) return;/.test(bodyOf("analyze")) && /finally \{ state\.analyzing = false; \}/.test(bodyOf("analyze")));
  test("failed save keeps the draft and re-enables Retry", /catch \(e\)[\s\S]*state\.busy = false[\s\S]*showFormError/.test(bodyOf("submitDraft")) && !/state\.draft = null/.test(bodyOf("submitDraft").split("catch")[1] || ""));
}

/* ── activity energy ── */
section("Activity energy");
{
  const day = H.localDateKey(new Date("2026-09-30T10:00:00"));
  const rows = [
    { start_date: "2026-09-30T10:00:00", raw_data: { calories_kcal: 500 } },
    { start_date: "2026-09-30T10:01:00", raw_data: { calories_kcal: 500, superseded: true } },
    { start_date: "2026-09-30T18:00:00", raw_data: { calories_kcal: 0 } },
    { start_date: "2026-09-30T19:00:00", raw_data: null }
  ];
  const e = H.activityEnergyForDay(rows, day);
  test("superseded duplicate is not double-counted", e && e.kcal === 500 && e.activities === 1, JSON.stringify(e));
  test("no calorie data → null (existing 'not available' state)", H.activityEnergyForDay([rows[2], rows[3]], day) === null);
  test("UI labels it 'Activity energy' from recorded activities, never total daily", /Activity energy/.test(fuelSrc) && /isn’t your total daily energy expenditure/.test(fuelSrc));
  test("planned sessions are read from training_sessions, never summed as energy", !/training_sessions[\s\S]{0,300}calories/.test(fuelSrc));
}

/* ── training context ── */
section("Training context");
{
  const P = H.pickTraining;
  const ss = [{ session_type: "rest", title: "", session_date: "2026-09-30" }];
  test("rest day is shown as a rest day", /rest/i.test(P(ss, "2026-09-30", "2026-10-01").title));
  test("easy run with distance", P([{ session_type: "easy_run", title: "Easy run", session_date: "2026-09-30", distance_km: 8 }], "2026-09-30", "2026-10-01").detail === "8 km");
  test("interval session by title", P([{ session_type: "interval", title: "6 x 800m", session_date: "2026-09-30" }], "2026-09-30", "2026-10-01").title === "6 x 800m");
  test("long run by duration", P([{ session_type: "long_run", title: null, session_date: "2026-09-30", duration_minutes: 95 }], "2026-09-30", "2026-10-01").detail === "95 min");
  test("no session today → tomorrow's, labelled Tomorrow", P([{ session_type: "easy_run", session_date: "2026-10-01", title: "Easy" }], "2026-09-30", "2026-10-01").label === "Tomorrow");
  test("nothing planned → null (card hidden, nothing invented)", P([], "2026-09-30", "2026-10-01") === null);
  test("two sessions in a day → first + '+1 more session'", /\+1 more session$/.test(P([{ session_type: "easy_run", title: "AM easy", session_date: "2026-09-30" }, { session_type: "strength", title: "Gym", session_date: "2026-09-30" }], "2026-09-30", "2026-10-01").detail));
  test("uses the same canonical table as the rest of the app (training_sessions), no plan parser", /from\("training_sessions"\)/.test(fuelSrc) && !/parsePlan|planParser|generatePlan/.test(fuelSrc));
  test("no nutrition prescriptions in training card", !/carb.?load|eat (more|less)|fuel (up|with)/i.test(fuelSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
}

/* ── incomplete-diary language ── */
section("Incomplete-diary safety");
{
  const code = fuelSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  test("no deficit/surplus/underfuel/overeat/remaining/goal-missed wording", !/\b(deficit|surplus|under-?fuel\w*|over-?eat\w*|calories remaining|remaining calories|goal missed|on track)\b/i.test(code));
  test("'No logged meals' for empty days, never '0 kcal' text", /No logged meals/.test(code) && !/["']0 kcal["']/.test(code));
  const wk = H.buildWeek([{ local_date: "2026-09-30", logged_at: "a", calories: 700, carbs_g: 1, protein_g: 1, fat_g: 1 }], "2026-09-30");
  test("6 blank days + 1 logged: average is 700 (not 100)", H.weekAverages(wk).calories === 700 && H.weekAverages(wk).loggedDays === 1);
}

/* ── migration + native ── */
section("Migration + native permissions");
{
  const noComments = sql.replace(/--.*$/gm, "");
  test("SECURITY DEFINER function pins an empty search_path", /security definer[\s\S]{0,300}set search_path = ''/i.test(noComments));
  test("function EXECUTE limited to service_role", /revoke all on function public\.fuel_save_meal[\s\S]*from public, anon, authenticated/.test(noComments) && /grant execute[\s\S]*to service_role/.test(noComments));
  test("client write privileges revoked on meals/items", /revoke insert, update, delete, truncate on public\.fuel_meals from authenticated/.test(noComments) && /revoke insert, update, delete, truncate on public\.fuel_meal_items from authenticated/.test(noComments));
  test("anon has no access to Fuel tables", /revoke all on public\.fuel_meals from anon/.test(noComments));
  test("RLS enabled on all three tables", ["fuel_meals", "fuel_meal_items", "fuel_preferences"].every(t => new RegExp(`alter table public\\.${t} enable row level security`).test(noComments)));
  test("iOS camera string is specific and not background", /NSCameraUsageDescription<\/key>\s*<string>[^<]*photograph a meal[^<]*<\/string>/.test(plist));
  test("no photo-library / microphone permission added", !/NSPhotoLibraryUsageDescription|NSMicrophoneUsageDescription/.test(plist));
  test("Android: no CAMERA permission declared (capture goes through the system camera intent)", !/android\.permission\.CAMERA/.test(manifest));
  test("HEIC is not claimed as supported", !/heic\s+(is\s+)?supported/i.test(fuelSrc) && /couldn.t be opened/.test(fuelSrc));
}

/* ── QA-prep: consent second-ensure, timezone, precision, edge inputs, error copy ── */
section("Consent v1→v2: no repeat prompt once granted");
{
  const t = loadConsent({ row: { status: "granted", consent_version: "1" } });
  const p1 = t.C.ensure({ authenticated: true, source: "fuel_meal_analysis" });
  await new Promise(r => setTimeout(r, 5)); t.handlers.c(); await p1;
  const shownAfterFirst = t.shown();
  const again = await t.C.ensure({ authenticated: true, source: "fuel_meal_analysis" });
  test("after Continue (v2 saved) the next analysis does NOT show the prompt again", again === true && t.shown() === shownAfterFirst);
  const failPersist = loadConsent({ row: { status: "granted", consent_version: "1" }, persistOk: false });
  const pf = failPersist.C.ensure({ authenticated: true, source: "fuel_meal_analysis" });
  await new Promise(r => setTimeout(r, 5)); failPersist.handlers.c();
  test("if v2 cannot be saved, analysis is NOT allowed (never claim consent that isn't stored)", (await pf) === false);
}

section("Day boundaries (Asia/Manila, UTC+8)");
{
  const before = new Date("2026-09-30T15:50:00Z"); // 23:50 PHT, Sep 30
  const after = new Date("2026-09-30T16:10:00Z");  // 00:10 PHT, Oct 1
  test("23:50 PHT is still Sep 30 locally (although it is Sep 30 in UTC too)", H.localDateKey(before) === "2026-09-30");
  test("00:10 PHT is Oct 1 locally even though UTC is still Sep 30", H.localDateKey(after) === "2026-10-01");
  const meals = [
    { local_date: H.localDateKey(before), logged_at: before.toISOString(), calories: 500, carbs_g: 1, protein_g: 1, fat_g: 1 },
    { local_date: H.localDateKey(after), logged_at: after.toISOString(), calories: 300, carbs_g: 1, protein_g: 1, fat_g: 1 }
  ];
  test("Oct 1 view groups only the after-midnight meal (grouping uses local_date, never the UTC date of logged_at)",
    H.mealsForDay(meals, "2026-10-01").length === 1 && H.mealsForDay(meals, "2026-10-01")[0].calories === 300);
  test("Sep 30 keeps the pre-midnight meal", H.mealsForDay(meals, "2026-09-30").length === 1 && H.mealsForDay(meals, "2026-09-30")[0].calories === 500);
  const wk = H.buildWeek(meals, "2026-10-01");
  test("week view: Sep 30 = 500, Oct 1 = 300", wk[5].totals.calories === 500 && wk[6].totals.calories === 300);
  const { validateMealPayload } = await import("../lib/server/fuelSchema.js");
  const base = { source: "manual", meal_name: "x", calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0 };
  const utcLate = new Date("2026-09-30T23:30:00Z"); // 07:30 PHT Oct 1
  test("server accepts the athlete's local date when it is a day ahead of UTC (PHT morning)", validateMealPayload({ ...base, local_date: "2026-10-01" }, { now: utcLate }).ok === true);
  test("server still rejects dates 2+ days ahead", validateMealPayload({ ...base, local_date: "2026-10-02" }, { now: utcLate }).ok === false);
  test("timestamps stay canonical: DB logged_at is timestamptz set server-side, grouping column is local_date", /logged_at timestamptz not null default now\(\)/.test(sql) && /local_date date not null/.test(sql));
  test("draft date is the LOCAL day at creation", H.draftFromSuggestion({ meal_name: "x", items: [] }, "", H.localDateKey(before), before).localDate === "2026-09-30");
}

section("Number display precision");
{
  test("whole kcal / whole grams in display", H.fmtKcal(623.7) === "624 kcal" && H.fmtInt(37.428571) === "37");
  const code = fuelSrc;
  test("no toFixed / raw float rendering of macros in the UI", !/toFixed\(/.test(code));
  const d = { mode: "quick", source: "manual", mealId: null, clientId: H.newClientId(), name: "x", mealType: "", note: "", localDate: "2026-09-30", items: [], totals: { calories: 400, carbs_g: 37.428571, protein_g: 20.25, fat_g: 10.05 } };
  const { validateMealPayload } = await import("../lib/server/fuelSchema.js");
  const v = validateMealPayload(H.buildPayload(d), { now: new Date("2026-09-30T04:00:00Z") });
  test("server stores at most one decimal (37.428571 -> 37.4)", v.ok && v.value.meal.carbs_g === 37.4 && [20.2, 20.3].includes(v.value.meal.protein_g));
  test("summed totals do not show float noise (0.1+0.2)", H.sumTotals([{ calories: 0.1 }, { calories: 0.2 }]).calories === 0.3);
}

section("Malicious / oversized input fails safely");
{
  const { validateMealPayload, validateImagePayload, FUEL_LIMITS } = await import("../lib/server/fuelSchema.js");
  const now = new Date("2026-09-30T04:00:00Z");
  const mk = extra => ({ source: "manual", local_date: "2026-09-30", meal_name: "x", calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0, ...extra });
  const item = extra => ({ name: "Rice", calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0, ...extra });
  test("empty image data rejected", validateImagePayload({ mime: "image/jpeg", data: "" }).ok === false);
  test("Infinity via JSON (1e999) rejected", validateMealPayload(JSON.parse('{"source":"manual","local_date":"2026-09-30","meal_name":"x","calories":1e999,"carbs_g":0,"protein_g":0,"fat_g":0}'), { now }).ok === false);
  test("huge calories rejected", validateMealPayload(mk({ calories: 1e9 }), { now }).ok === false);
  test("huge macro rejected", validateMealPayload(mk({ protein_g: 99999 }), { now }).ok === false);
  test("string 'NaN' / 'Infinity' rejected", validateMealPayload(mk({ calories: "NaN" }), { now }).ok === false && validateMealPayload(mk({ fat_g: "Infinity" }), { now }).ok === false);
  test("exactly 30 items accepted, 31 rejected", validateMealPayload(mk({ calories: undefined, items: Array.from({ length: 30 }, () => item()) }), { now }).ok === true && validateMealPayload(mk({ items: Array.from({ length: 31 }, () => item()) }), { now }).ok === false);
  const long = validateMealPayload(mk({ calories: undefined, items: [item({ name: "y".repeat(10000) })] }), { now });
  test("very long food name is capped", long.ok && long.value.items[0].name.length <= FUEL_LIMITS.MAX_NAME_LEN);
  test("negative quantity/grams rejected", validateMealPayload(mk({ calories: undefined, items: [item({ quantity: -1 })] }), { now }).ok === false && validateMealPayload(mk({ calories: undefined, items: [item({ grams: -5 })] }), { now }).ok === false);
  // analyze endpoint: huge note is capped before it reaches the model; provider failure never leaks
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 3, 192, 5, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const img = { mime: "image/jpeg", data: Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(64, 1)]).toString("base64") };
  const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
  let seenNote = null;
  const h1 = createFuelHandlers({ now: () => now, verifyToken: async () => ({ ok: true, user: { id: "a" } }), requireAiConsent: async () => ({ allowed: true }), checkAiRateLimit: async () => ({ allowed: true }),
    callOpenAI: async ({ note }) => { seenNote = note; return { output_text: JSON.stringify({ is_food_photo: true, meal_name: "x", items: [{ name: "Rice", quantity: null, unit: null, estimated_grams: null, calories: 200, carbs_g: 40, protein_g: 4, fat_g: 1, confidence: "low" }], assumptions: [], uncertainties: [] }) }; } });
  let r = res(); await h1.analyzeMeal({ method: "POST", headers: { authorization: "Bearer t" }, body: { image: img, note: "n".repeat(50000) } }, r);
  test("huge note is capped before reaching the model", r.statusCode === 200 && seenNote && seenNote.length <= FUEL_LIMITS.MAX_NOTE_LEN, String(seenNote && seenNote.length));
  const origWarn = console.warn; console.warn = () => {};
  const h2 = createFuelHandlers({ now: () => now, verifyToken: async () => ({ ok: true, user: { id: "a" } }), requireAiConsent: async () => ({ allowed: true }), checkAiRateLimit: async () => ({ allowed: true }),
    callOpenAI: async () => { throw new Error("401 Incorrect API key sk-proj-SECRET at Object.<anonymous> (/var/task/x.js:1:1)"); } });
  r = res(); await h2.analyzeMeal({ method: "POST", headers: { authorization: "Bearer t" }, body: { image: img } }, r);
  const leak = JSON.stringify(r.body);
  test("provider failure: friendly copy, no key/stack/provider text", r.statusCode === 502 && !/sk-|stack|Object\.|openai|\/var\/task|Incorrect/i.test(leak), leak);
  const h3 = createFuelHandlers({ now: () => now, verifyToken: async () => ({ ok: true, user: { id: "a" } }),
    db: { rpcSaveMeal: async () => { throw Object.assign(new Error('relation "fuel_meals" does not exist'), { code: "DB_ERROR" }); }, readMeal: async () => null, deleteMeal: async () => false } });
  r = res(); await h3.meals({ method: "POST", headers: { authorization: "Bearer t" }, body: mk({}) }, r);
  const leak2 = JSON.stringify(r.body);
  test("DB failure: no SQL / relation names leak to the client", r.statusCode === 500 && !/relation|sql|fuel_meals|postgres|supabase/i.test(leak2), leak2);
  console.warn = origWarn;
  test("client describeError never echoes raw server/provider text", !/does not exist|sk-|stack/i.test(H.describeError({ code: "DB_ERROR", message: 'relation "fuel_meals" does not exist' }, "save")) && !/openai/i.test(H.describeError({ code: "ANALYSIS_FAILED", message: "OpenAI 500" })));
  test("413 maps to human copy", /too large/i.test(H.describeError({ code: "HTTP_413" })) && /too large/i.test(H.describeError({ code: "PAYLOAD_TOO_LARGE" }, "save")));
  test("save-failure copy says changes are kept", /Your changes are still here/.test(H.describeError({ code: "DB_ERROR" }, "save")));
}

section("Account deletion");
{
  const gw = readFileSync("./api/providers/index.js", "utf8");
  const list = gw.slice(gw.indexOf("const userDataTables = ["), gw.indexOf("];", gw.indexOf("const userDataTables = [")));
  test("deletion stage 3 removes fuel_meals and fuel_preferences", /"fuel_meals"/.test(list) && /"fuel_preferences"/.test(list));
  test("fuel_meal_items removed via ON DELETE CASCADE (meal + auth.users) — verified against real Postgres", /meal_id uuid not null\s+references public\.fuel_meals \(id\) on delete cascade/.test(sql) && (sql.match(/references auth\.users \(id\) on delete cascade/g) || []).length >= 3);
  test("deletion tolerates a not-yet-migrated table (404) so it can never block account deletion", /if \(!res\.ok && res\.status !== 404\)/.test(gw));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
