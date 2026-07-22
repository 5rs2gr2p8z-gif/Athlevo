/*
 * Athlevo — Adaptive Smart Plan v2.
 *
 * Drives the REAL planning engines (TrainingMemory, ProgressionRules,
 * PlanAdjustmentEngine, WeeklyReview). Everything is pure and deterministic —
 * nothing mocked, no AI, no I/O.
 *
 * Run: node tests/adaptive-plan-v2.test.mjs
 */

import { buildTrainingMemory } from "../lib/server/trainingMemory.js";
import {
  progressEasy, progressThreshold, progressVO2, progressLong,
  progressTempo, progressRecovery, progressDiscipline
} from "../lib/server/progressionRules.js";
import { adjustPlan } from "../lib/server/planAdjustmentEngine.js";
import { buildWeeklyReview } from "../lib/server/weeklyReview.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const NOW = "2026-07-22";
const ago = n => {           // n days before NOW, as YYYY-MM-DD
  const d = new Date(Date.parse(NOW + "T00:00:00Z") - n * 86400000);
  return d.toISOString().slice(0, 10);
};

/* ══════ TrainingMemory — the source of truth ══════════════════════════ */

section("TrainingMemory derives current status from real history");
{
  const workouts = [
    { date: ago(2), type: "Threshold", distanceKm: 12, durationMin: 70, rpe: 6 },
    { date: ago(4), type: "Easy", distanceKm: 10, durationMin: 55 },
    { date: ago(6), type: "Easy", distanceKm: 10, durationMin: 55 },
    { date: ago(9), type: "Long Run", distanceKm: 20, durationMin: 120 },
    { date: ago(12), type: "Easy", distanceKm: 10, durationMin: 55 },
    { date: ago(20), type: "Threshold", distanceKm: 12, durationMin: 70 },
    { date: ago(26), type: "Long Run", distanceKm: 22, durationMin: 130 }
  ];
  const plannedSessions = [
    { date: ago(1), type: "Easy", distanceKm: 10, status: "completed" },
    { date: ago(3), type: "Threshold", distanceKm: 12, status: "completed", quality: true },
    { date: ago(4), type: "Threshold", distanceKm: 12, status: "skipped", quality: true },
    { date: ago(8), type: "Long Run", distanceKm: 20, status: "skipped", long: true },
    { date: ago(10), type: "VO2", distanceKm: 11, status: "completed", quality: true },
    { date: ago(12), type: "Easy", distanceKm: 10, status: "completed" }
  ];
  const m = buildTrainingMemory({ workouts, plannedSessions, now: NOW });

  t("weekly (acute) load is the last-7-day sum", m.weeklyLoadKm === 32, String(m.weeklyLoadKm));
  t("recent quality sessions counted (14d)", m.recentQualitySessions === 1, String(m.recentQualitySessions));
  t("long-run history captured newest-first", m.longRunHistory[0].km === 20 && m.longRunHistory.length === 2);
  t("longest recent long run", m.longestRecentKm === 22, String(m.longestRecentKm));
  t("a fatigue estimate exists on 0–100", m.fatigue.score >= 0 && m.fatigue.score <= 100);
  t("load ramp is flagged (acute>chronic → rising/high)", m.fatigue.trend === "rising" && m.fatigue.level === "high", JSON.stringify(m.fatigue));
  t("consistency ratio + label derived", m.consistency.label === "Fair" && m.consistency.completed === 4, JSON.stringify(m.consistency));
  t("a missed long run is remembered", m.missedLongRun === true);
  t("a missed quality session is counted", m.missedQualityCount === 1, String(m.missedQualityCount));
  t("block inferred from the workout mix", m.block === "Peak" || m.block === "Build", m.block);
  t("confidence reflects having both load + plan", m.confidence === "high");
}

section("An easy/down week reads as low fatigue, falling trend");
{
  const workouts = [
    { date: ago(2), type: "Easy", distanceKm: 10 }, { date: ago(5), type: "Easy", distanceKm: 10 },
    { date: ago(9), type: "Long Run", distanceKm: 20 }, { date: ago(12), type: "Threshold", distanceKm: 12 },
    { date: ago(15), type: "Easy", distanceKm: 12 }, { date: ago(16), type: "Easy", distanceKm: 20 },
    { date: ago(18), type: "Long Run", distanceKm: 22 }, { date: ago(20), type: "Easy", distanceKm: 20 },
    { date: ago(22), type: "Easy", distanceKm: 12 }, { date: ago(25), type: "Easy", distanceKm: 12 }
  ];
  const m = buildTrainingMemory({ workouts, plannedSessions: [], now: NOW });
  t("acute load well below chronic → low fatigue", m.fatigue.level === "low", JSON.stringify(m.fatigue));
  t("trend reads as falling (deliberate down week)", m.fatigue.trend === "falling", m.fatigue.trend);
}

/* ══════ ProgressionRules — gradual, capped, one thing at a time ════════ */

section("Progression is gradual and capped per discipline");
{
  const easy = progressEasy({ distanceKm: 10 }, { allowProgression: true });
  t("easy grows ≤10%", easy.changed && easy.to === 10.8 && easy.delta === 0.8, JSON.stringify(easy));
  t("easy holds while recovering", progressEasy({ distanceKm: 10 }, { allowProgression: false }).changed === false);

  const thr = progressThreshold({ workMinutes: 20 }, { lastOutcome: "easy" });
  t("threshold adds a few minutes after a clean session", thr.changed && thr.to === 23);
  t("threshold holds after a hard session", progressThreshold({ workMinutes: 20 }, { lastOutcome: "hard" }).changed === false);
  t("threshold holds without a clean prior session", progressThreshold({ workMinutes: 20 }, {}).changed === false);

  const vo2 = progressVO2({ reps: 5 }, { lastOutcome: "on_target" });
  t("VO2 adds exactly one rep", vo2.changed && vo2.to === 6 && vo2.delta === 1);
  t("VO2 holds when tired", progressVO2({ reps: 5 }, { allowProgression: false }).changed === false);

  const long = progressLong({ distanceKm: 18 }, { allowProgression: true });
  t("long run extends ≤2 km", long.changed && long.to === 20 && long.delta === 2);
  t("long run repeats after a missed long run", progressLong({ distanceKm: 18 }, { allowProgression: true, missedLastLong: true }).changed === false);
  t("long run holds at the ceiling", progressLong({ distanceKm: 36 }, { allowProgression: true }).changed === false);

  t("tempo grows a couple of minutes", progressTempo({ durationMin: 20 }, {}).to === 22);
  t("recovery is NEVER progressed", progressRecovery({ durationMin: 30 }).changed === false);
  t("dispatch routes by discipline", progressDiscipline("threshold", { workMinutes: 20 }, { lastOutcome: "easy" }).to === 23);
}

/* ══════ PlanAdjustmentEngine — successful progression ═════════════════ */

section("Completing a threshold easily nudges the NEXT threshold up (one thing)");
{
  const memory = { block: "Build", fatigue: { level: "low", trend: "steady" },
    consistency: { label: "Excellent" }, missedQualityCount: 0, missedLongRun: false, confidence: "high" };
  const upcoming = [
    { id: "a", date: ago(-1), type: "Easy", distanceKm: 10 },
    { id: "b", date: ago(-3), type: "Threshold", workMinutes: 20 },
    { id: "c", date: ago(-6), type: "Long Run", distanceKm: 18 }
  ];
  const out = adjustPlan({ memory, upcoming, outcomes: { threshold: "easy" }, todayKey: NOW });
  t("posture is progress", out.posture === "progress");
  t("exactly ONE change is made", out.changed === 1, String(out.changed));
  t("...and it increases the threshold", out.changes[0].action === "increase" &&
    out.changes[0].discipline === "threshold" && out.changes[0].to === 23);
  t("nothing else is touched (stability)", out.unchangedCount === 2);
  t("the change stores a reason", typeof out.changes[0].reason === "string" && out.changes[0].reason.length > 10);
  t("never increases everything at once", out.changes.filter(c => c.action === "increase").length === 1);
}

/* ══════ high fatigue — maintain, never progress ═══════════════════════ */

section("High fatigue eases the next quality session instead of progressing");
{
  const memory = { block: "Build", fatigue: { level: "high", trend: "rising" },
    consistency: { label: "Good" }, missedQualityCount: 0, missedLongRun: false, confidence: "high" };
  const upcoming = [
    { id: "a", date: ago(-2), type: "Threshold", workMinutes: 24 },
    { id: "b", date: ago(-4), type: "Easy", distanceKm: 10 }
  ];
  const out = adjustPlan({ memory, upcoming, todayKey: NOW });
  t("posture is recover", out.posture === "recover");
  t("no progression happens", out.changes.every(c => c.action !== "increase"));
  t("the next quality session is eased to aerobic", out.changes.some(c => c.action === "convert" && c.to === "easy"));
  t("the reason explains the ease-off", /fatigue is high/i.test(out.changes[0].reason));
}

/* ══════ two missed quality — reduce progression ═══════════════════════ */

section("Two missed quality sessions reduce the next quality volume");
{
  const memory = { block: "Build", fatigue: { level: "moderate", trend: "steady" },
    consistency: { label: "Fair" }, missedQualityCount: 2, missedLongRun: false, confidence: "medium" };
  const upcoming = [{ id: "a", date: ago(-2), type: "Threshold", workMinutes: 24 }];
  const out = adjustPlan({ memory, upcoming, todayKey: NOW });
  t("posture is reduce", out.posture === "reduce");
  t("the next quality volume is pulled back", out.changes[0].action === "decrease" && out.changes[0].to === 20);
  t("reason cites the missed quality sessions", /two missed quality/i.test(out.changes[0].reason));
}

/* ══════ missed long run — reschedule to a suitable slot ═══════════════ */

section("A missed long run is rescheduled, plan otherwise stable");
{
  const memory = { block: "Base", fatigue: { level: "moderate", trend: "steady" },
    consistency: { label: "Good" }, missedQualityCount: 0, missedLongRun: true,
    recentMissed: [{ date: ago(3), type: "Long Run", long: true }], confidence: "high" };
  const upcoming = [
    { id: "a", date: ago(-1), type: "Easy", distanceKm: 10 },
    { id: "b", date: ago(-3), type: "Threshold", workMinutes: 20 }
  ];
  const out = adjustPlan({ memory, upcoming, todayKey: NOW });
  t("a reschedule change is produced", out.changes.some(c => c.action === "reschedule" && c.to === "long"));
  t("it targets an easy/rest slot", out.changes[0].date === ago(-1));
  t("the reason explains the move", /long run moved/i.test(out.changes[0].reason));
  t("no progression sneaks in alongside it", out.changes.every(c => c.action !== "increase"));
}

/* ══════ plan stability — nothing changes when on track ════════════════ */

section("On-track weeks are left completely alone");
{
  const memory = { block: "Build", fatigue: { level: "moderate", trend: "steady" },
    consistency: { label: "Good" }, missedQualityCount: 0, missedLongRun: false, confidence: "high" };
  const upcoming = [
    { id: "a", date: ago(-1), type: "Easy", distanceKm: 10 },
    { id: "b", date: ago(-3), type: "Threshold", workMinutes: 20 },
    { id: "c", date: ago(-5), type: "Long Run", distanceKm: 18 }
  ];
  const out = adjustPlan({ memory, upcoming, todayKey: NOW });
  t("posture is maintain", out.posture === "maintain");
  t("zero changes — no surprises", out.changed === 0 && out.stable === true);
  t("every upcoming session is preserved", out.unchangedCount === 3);
  t("a note records the hold", out.notes.length >= 1);
}

/* ══════ long-run progression via the engine (Base block) ══════════════ */

section("A consistent Base block progresses the long run by 2 km");
{
  const memory = { block: "Base", fatigue: { level: "low", trend: "steady" },
    consistency: { label: "Excellent" }, missedQualityCount: 0, missedLongRun: false, confidence: "high" };
  const upcoming = [
    { id: "a", date: ago(-2), type: "Easy", distanceKm: 10 },
    { id: "b", date: ago(-6), type: "Long Run", distanceKm: 20 }
  ];
  const out = adjustPlan({ memory, upcoming, outcomes: { long: "on_target" }, todayKey: NOW });
  t("posture is progress", out.posture === "progress");
  t("the long run is the single change", out.changed === 1 && out.changes[0].discipline === "long");
  t("extended by 2 km (20 → 22)", out.changes[0].to === 22 && out.changes[0].from === 20);
}

/* ══════ WeeklyReview — honest one-glance summary ══════════════════════ */

section("A completed week produces a real summary + coach takeaway");
{
  const sessions = [
    { date: ago(6), type: "Easy", distanceKm: 10, status: "completed" },
    { date: ago(5), type: "Threshold", distanceKm: 12, status: "completed", quality: true },
    { date: ago(4), type: "Easy", distanceKm: 8, status: "completed" },
    { date: ago(3), type: "VO2", distanceKm: 8, status: "completed", quality: true },
    { date: ago(2), type: "Easy", distanceKm: 10, status: "skipped" },
    { date: ago(1), type: "Long Run", distanceKm: 20, status: "completed", long: true }
  ];
  const r = buildWeeklyReview({ weekStart: ago(6), sessions });
  t("completed ratio is 5 / 6", r.completedLabel === "5 / 6", r.completedLabel);
  t("quality is 2 / 2", r.quality.label === "2 / 2");
  t("mileage totals only completed work", r.mileageKm === 58, String(r.mileageKm));
  t("longest run captured", r.longestRunKm === 20);
  t("consistency labelled deterministically", r.consistency === "Good", r.consistency);
  t("coach takeaway is one concise paragraph", typeof r.takeaway === "string" &&
    r.takeaway.length > 30 && !/\n/.test(r.takeaway));
}

/* ══════ independence — the planner never depends on the UI ════════════ */

section("The planning engine is UI-free and deterministic");
{
  const files = ["trainingMemory", "progressionRules", "planAdjustmentEngine", "weeklyReview"];
  const { readFileSync } = await import("node:fs");
  files.forEach(name => {
    const s = readFileSync(`./lib/server/${name}.js`, "utf8");
    t(`${name}: no DOM/window/document`, !/\bwindow\.|\bdocument\.|getElementById|querySelector/.test(s));
    t(`${name}: no network I/O`, !/\bfetch\s*\(|supabase|require\(/.test(s));
  });
  // determinism: same input → identical output.
  const memory = { block: "Build", fatigue: { level: "low", trend: "steady" },
    consistency: { label: "Excellent" }, missedQualityCount: 0, missedLongRun: false, confidence: "high" };
  const up = [{ id: "b", date: ago(-3), type: "Threshold", workMinutes: 20 }];
  const a = JSON.stringify(adjustPlan({ memory, upcoming: up, outcomes: { threshold: "easy" } }));
  const b = JSON.stringify(adjustPlan({ memory, upcoming: up, outcomes: { threshold: "easy" } }));
  t("deterministic: identical inputs → identical output", a === b);
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
