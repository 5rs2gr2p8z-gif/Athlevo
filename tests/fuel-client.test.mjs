/**
 * Athlevo Fuel V1 — client tests (pure helpers + static wiring checks).
 * Run: node tests/fuel-client.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0, failed = 0;
function test(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}

const src = readFileSync("./js/fuel.js", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const html = readFileSync("./index.html", "utf8");
const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
const plist = readFileSync("./ios/App/App/Info.plist", "utf8");
const ctx = vm.createContext({ console });
ctx.window = ctx; ctx.self = ctx;
vm.runInContext(src, ctx);
const H = ctx.AthlevoFuel._test;

/* ── totals / week semantics ── */
const meals = [
  { local_date: "2026-09-30", logged_at: "2026-09-30T08:00:00Z", calories: 400, carbs_g: 50, protein_g: 20, fat_g: 10 },
  { local_date: "2026-09-30", logged_at: "2026-09-30T12:00:00Z", calories: 600, carbs_g: 70, protein_g: 30, fat_g: 20 },
  { local_date: "2026-09-28", logged_at: "2026-09-28T12:00:00Z", calories: 800, carbs_g: 100, protein_g: 40, fat_g: 20 }
];
test("sumTotals adds meals", H.sumTotals(meals.slice(0, 2)).calories === 1000);
test("sumTotals of nothing is zeros (not NaN)", H.sumTotals([]).calories === 0);
const week = H.buildWeek(meals, "2026-09-30");
test("week has 7 days", week.length === 7);
test("unlogged day has null totals (never 0 kcal)", week.filter(d => !d.logged).every(d => d.totals === null));
test("logged days flagged", week.filter(d => d.logged).length === 2);
const avg = H.weekAverages(week);
test("average uses logged days only", avg.loggedDays === 2 && avg.calories === 900, JSON.stringify(avg));
test("no logs → null average, not zero", H.weekAverages(H.buildWeek([], "2026-09-30")).calories === null);
test("mealsForDay filters by local_date", H.mealsForDay(meals, "2026-09-28").length === 1);

/* ── energy: no invented expenditure ── */
const acts = [
  { start_date: "2026-09-30T10:00:00", raw_data: { calories_kcal: 500 } },
  { start_date: "2026-09-30T18:00:00", raw_data: { calories: 999 } },
  { start_date: "2026-09-29T10:00:00", raw_data: { calories_kcal: 700 } }
];
const e = H.activityEnergyForDay(acts, H.localDateKey(new Date("2026-09-30T10:00:00")));
test("activity energy uses raw_data.calories_kcal only", e && e.kcal === 500 && e.activities === 1, JSON.stringify(e));
test("other-day activity ignored", H.activityEnergyForDay(acts, "2026-01-01") === null);
test("`calories` field is not treated as energy", H.activityEnergyForDay([acts[1]], H.localDateKey(new Date("2026-09-30T18:00:00"))) === null);
test("no TDEE/BMR/maintenance in client", !/\b(tdee|bmr|maintenance calories)\b/i.test(code));

/* ── drafts / payload / validation ── */
const sug = { meal_name: "Rice bowl", assumptions: ["a"], uncertainties: [], items: [{ name: "Rice", quantity: 1, unit: "cup", estimated_grams: 180, calories: 240, carbs_g: 53, protein_g: 4, fat_g: 1 }] };
const d = H.draftFromSuggestion(sug, "post run", "2026-09-30", new Date("2026-09-30T13:00:00"));
test("AI draft is marked ai_photo and items ai_estimated", d.source === "ai_photo" && d.items[0].ai_estimated === true);
test("AI draft keeps the note", d.note === "post run");
test("draftTotals sums items", H.draftTotals(d).calories === 240);
test("valid draft passes", H.validateDraft(d) === null);
test("empty name rejected", /name/i.test(H.validateDraft({ ...d, name: " " }) || ""));
test("negative macros rejected", H.validateDraft({ ...d, items: [{ ...d.items[0], carbs_g: -1 }] }) !== null);
test("absurd calories rejected", H.validateDraft({ ...d, items: [{ ...d.items[0], calories: 20000 }] }) !== null);
const pl = H.buildPayload(d);
test("payload has no image/photo fields", !/image|photo_url|base64/i.test(JSON.stringify(pl)));
test("payload carries items and source", pl.source === "ai_photo" && pl.items.length === 1);
const prior = { id: "m1", source: "manual", meal_name: "Toast", meal_type: "breakfast", local_date: "2026-09-20", note: "n", calories: 200, carbs_g: 30, protein_g: 6, fat_g: 5, fuel_meal_items: [] };
const rep = H.draftFromMeal(prior, "repeat", "2026-09-30", new Date("2026-09-30T08:00:00"));
test("repeat draft is new (no id), today, source repeated", rep.mealId === null && rep.localDate === "2026-09-30" && rep.source === "repeated");
const ed = H.draftFromMeal(prior, "edit", "2026-09-30", new Date());
test("edit draft keeps id and date", ed.mealId === "m1" && ed.localDate === "2026-09-20");
test("parseField blank → null, junk → NaN", H.parseField("") === null && Number.isNaN(H.parseField("abc")) && H.parseField("1,200") === 1200);
test("describeError consent wording offers manual", /manually/i.test(H.describeError({ code: "AI_CONSENT_REQUIRED" })));
test("describeError never blames athlete", !/your fault|you (did|should have)/i.test(H.describeError({ code: "ANALYSIS_FAILED" })));
test("esc escapes HTML", H.esc("<b>&\"") .indexOf("<") === -1);

/* ── static wiring ── */
test("flag key is fuel_tracking_v1", H.FLAG === "fuel_tracking_v1");
test("flag defaults OFF (isEnabled(FLAG,false))", /isEnabled\([^)]*FLAG\s*,\s*false\)/.test(src) || /isEnabled\(\s*FLAG\s*,\s*false/.test(src));
test("entry point is hidden by default", /id="youFuelEntry"[^>]*hidden/.test(html));
test("Fuel screen exists", /id="screen-fuel"/.test(html));
test("camera input uses image/* + capture", /id="fuelCameraInput"[^>]*accept="image\/\*"[^>]*capture="environment"/.test(html));
test("library input has no capture", /id="fuelLibraryInput"[^>]*accept="image\/\*"/.test(html) && !/id="fuelLibraryInput"[^>]*capture/.test(html));
test("fuel.js is loaded after featureFlags.js", html.indexOf('<script src="js/featureFlags.js') > -1 && html.indexOf('<script src="js/fuel.js') > html.indexOf('<script src="js/featureFlags.js'));
test("sheet is a modal dialog", /id="fuelSheet"[\s\S]{0,200}role="dialog" aria-modal="true"/.test(html));

function fnBody(name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let depth = 0, started = false;
  for (let j = src.indexOf("{", i); j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return "";
}
const analyzeBody = fnBody("analyze");
test("analyze() exists and never hits /api/fuel/meals", analyzeBody.length > 0 && !/fuel\/meals/.test(analyzeBody));
test("analyze() gates on AI consent", /AthlevoAiConsent\.ensure/.test(analyzeBody));
test("AI consent used only in analyze()", (src.match(/AthlevoAiConsent\.ensure/g) || []).length === 1);
test("startManual does not touch consent", !/Consent/.test(fnBody("startManual")));
const meal_calls = (src.match(/\/api\/fuel\/meals/g) || []).length;
const saveBody = fnBody("submitDraft") + fnBody("deleteDetailMeal");
test("meal writes only in submitDraft/deleteDetailMeal", meal_calls >= 1 && (saveBody.match(/\/api\/fuel\/meals/g) || []).length === meal_calls, `${meal_calls}`);
test("client never inserts meals directly", !/from\(["']fuel_meals["']\)\s*\.(insert|update|delete|upsert)/.test(src) && !/from\(["']fuel_meal_items["']\)\s*\.(insert|update|delete|upsert)/.test(src));
test("no localStorage of meal data", !/localStorage[\s\S]{0,80}(meal|draft|calor)/i.test(src));
test("photo released after use", /function releasePhoto/.test(src));
test("logged-intake language used", /Logged intake/.test(src) && /No logged meals/.test(src));
test("no '0 kcal consumed' phrasing", !/kcal consumed/i.test(code));
test("expenditure-unavailable copy present", /Daily expenditure isn.t available/.test(src));

/* ── analytics ── */
const events = ["fuel_opened","fuel_add_meal_started","fuel_photo_selected","fuel_analysis_started","fuel_analysis_completed","fuel_analysis_failed","fuel_estimate_edited","fuel_meal_logged","fuel_meal_edited","fuel_meal_deleted","fuel_meal_repeated","fuel_weekly_viewed"];
test("all Fuel events registered", events.every(n => registry.includes(`"${n}"`) || registry.includes(`'${n}'`) || registry.includes(n)));
const trackCalls = src.match(/track\("[a-z_]+",\s*\{[^}]*\}/g) || [];
test("analytics props carry no note/name/calories/image", trackCalls.length > 0 && trackCalls.every(c => !/\b(note|meal_name|name|calories|carbs|protein|fat|image|photo|base64|text)\s*:/.test(c.replace(/^track\("[a-z_]+",/, ""))), trackCalls.join(" | "));

/* ── native / legal ── */
test("iOS camera usage string present", /NSCameraUsageDescription/.test(plist));
const terms = readFileSync("./legal/terms-of-service.md", "utf8").toLowerCase().includes("fuel");
test("Terms untouched by Fuel", terms === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
