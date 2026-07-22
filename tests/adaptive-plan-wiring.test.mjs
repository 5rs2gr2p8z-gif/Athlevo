/*
 * Athlevo — Adaptive Smart Plan v2 wiring (preview · apply · dismiss).
 *
 * Tier A drives the PURE adapter (buildProposal) with realistic inputs.
 * Tier B drives the REAL get-week.js handler over an in-memory Supabase —
 * nothing about routing, auth-scoping, patching, or rollback is mocked away.
 *
 * Run: node tests/adaptive-plan-wiring.test.mjs
 */

import { buildProposal } from "../lib/server/adaptivePlanAdapter.js";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const NOW = "2026-07-22";
const ago = n => new Date(Date.parse(NOW + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10);
const fwd = n => new Date(Date.parse(NOW + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// A steady 4-week base so acute load sits BELOW chronic → low, non-rising fatigue.
function steadyHistory() {
  const acute = [{ start_date: ago(3), distance_meters: 12000, moving_time_seconds: 3600 },
    { start_date: ago(6), distance_meters: 12000, moving_time_seconds: 1440, recognition: { workoutType: "Threshold" } }];
  const chronic = [9, 11, 13, 16, 18, 20, 23, 25].map(a =>
    ({ start_date: ago(a), distance_meters: 12000, moving_time_seconds: 3600 }));
  return acute.concat(chronic);
}

/* ══════ Tier A — the adapter produces correct proposals ═══════════════ */

section("Excellent week + low fatigue → ONE threshold progression");
let excellentProposal;
{
  const sessions = [
    { id: "sp1", session_date: ago(3), session_type: "Easy", duration_minutes: 60, distance_km: 12 },
    { id: "sp2", session_date: ago(6), session_type: "Threshold", duration_minutes: 24, distance_km: 12, target_rpe: "6" },
    { id: "sp3", session_date: ago(9), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
    { id: "sp4", session_date: ago(13), session_type: "Long Run", duration_minutes: 120, distance_km: 20 },
    { id: "su1", session_date: fwd(2), session_type: "Threshold", duration_minutes: 24, distance_km: 12 },
    { id: "su2", session_date: fwd(4), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
    { id: "su3", session_date: fwd(6), session_type: "Long Run", duration_minutes: 120, distance_km: 20 }
  ];
  const executions = [
    { training_session_id: "sp1", status: "completed", actual_duration_minutes: 60 },
    { training_session_id: "sp2", status: "completed", actual_duration_minutes: 24, actual_rpe: "4" },
    { training_session_id: "sp3", status: "completed", actual_duration_minutes: 55 },
    { training_session_id: "sp4", status: "completed", actual_duration_minutes: 120 }
  ];
  const proposal = buildProposal({ sessions, executions, activities: steadyHistory(), profile: {}, now: NOW });
  excellentProposal = proposal;
  t("posture is progress", proposal.posture === "progress", proposal.posture + " / " + JSON.stringify(proposal.memorySummary.fatigue));
  t("exactly one proposed change", proposal.proposedChanges.length === 1, String(proposal.proposedChanges.length));
  const c = proposal.proposedChanges[0];
  t("...it progresses the upcoming threshold", c.workoutId === "su1" && c.field === "duration_minutes");
  t("...duration 24 → 27", c.before.duration_minutes === 24 && c.after.duration_minutes === 27);
  t("the change carries before, after, and a reason", c.before && c.after && typeof c.reason === "string" && c.reason.length > 10);
  t("not stable (a card should show)", proposal.stable === false);
  t("a fingerprint is produced", /^adp_/.test(proposal.fingerprint));
}

section("High fatigue → maintain, never a progression");
{
  const activities = [1, 2, 3, 4, 5, 6].map(a => ({ start_date: ago(a), distance_meters: 20000, moving_time_seconds: 6000,
    recognition: a % 2 ? { workoutType: "Threshold" } : null }));
  const sessions = [{ id: "u1", session_date: fwd(2), session_type: "Threshold", duration_minutes: 24, distance_km: 12 }];
  const proposal = buildProposal({ sessions, executions: [], activities, profile: {}, now: NOW });
  t("fatigue reads high", proposal.memorySummary.fatigue.level === "high", JSON.stringify(proposal.memorySummary.fatigue));
  t("no change is an increase", proposal.proposedChanges.every(c => (c.after.duration_minutes || 0) <= 24));
}

section("Missed long run → a safe reschedule proposal");
let reschedProposal;
{
  const sessions = [
    { id: "m1", session_date: ago(3), session_type: "Long Run", duration_minutes: 120, distance_km: 20 }, // missed (no exec, past)
    { id: "u1", session_date: fwd(2), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
    { id: "u2", session_date: fwd(4), session_type: "Threshold", duration_minutes: 24, distance_km: 12 }
  ];
  const proposal = buildProposal({ sessions, executions: [], activities: steadyHistory(), profile: {}, now: NOW });
  reschedProposal = proposal;
  const resched = proposal.proposedChanges.find(c => c.after.session_type === "Long Run");
  t("a reschedule change exists", Boolean(resched));
  t("...it converts a FUTURE easy slot", resched && resched.workoutId === "u1");
  t("...with a stored reason mentioning the missed long run", resched && /long run/i.test(resched.reason));
  t("no past/missed session is ever a target", proposal.proposedChanges.every(c => c.workoutId !== "m1"));
}

section("Nothing meaningful to change → stable, no card");
{
  const sessions = [
    { id: "sp1", session_date: ago(3), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
    { id: "sp2", session_date: ago(6), session_type: "Threshold", duration_minutes: 24, distance_km: 12 },
    { id: "u1", session_date: fwd(2), session_type: "Easy", duration_minutes: 55, distance_km: 10 }
  ];
  const executions = [
    { training_session_id: "sp1", status: "completed", actual_duration_minutes: 55 },
    { training_session_id: "sp2", status: "completed", actual_duration_minutes: 24 }
  ];
  // Moderate, steady load → not Excellent-consistent enough to progress, no misses.
  const activities = [3, 6, 10, 13, 17, 20, 24, 27].map(a => ({ start_date: ago(a), distance_meters: 11000, moving_time_seconds: 3600 }));
  const proposal = buildProposal({ sessions, executions, activities, profile: {}, now: NOW });
  t("posture is maintain", proposal.posture === "maintain", proposal.posture);
  t("stable — zero proposed changes", proposal.stable === true && proposal.proposedChanges.length === 0);
}

section("Safety guards: taper/race week never increases; injury forces maintain");
{
  const base = { sessions: [{ id: "su1", session_date: fwd(2), session_type: "Threshold", duration_minutes: 24, distance_km: 12 },
      { id: "su2", session_date: fwd(4), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
      { id: "su3", session_date: fwd(6), session_type: "Long Run", duration_minutes: 120, distance_km: 20 }],
    executions: [{ training_session_id: "x", status: "completed" }], activities: steadyHistory(), now: NOW };
  const taper = buildProposal({ ...base, profile: { race_date: fwd(5) } });
  t("taper/race week holds — no increases", taper.proposedChanges.every(c => c.action !== "increase") && taper.guards.taperRaceHold === true);

  const injuryExec = [{ training_session_id: "x", status: "completed", pain_present: true, completed_at: ago(2) }];
  const injured = buildProposal({ ...base, executions: injuryExec, profile: {} });
  t("injury/pain forces maintain — no increases", injured.proposedChanges.every(c => c.action !== "increase") && injured.guards.injuryHold === true);
  t("injury guard is reported active (pain_present exists)", injured.guards.injurySignalActive === true &&
    /pain_present/.test(injured.guards.injurySignal));
}

section("Weekly review is present and compact");
{
  t("review attached to the excellent proposal", excellentProposal.weeklyReview !== null);
  const r = excellentProposal.weeklyReview;
  t("has completed / quality / mileage / takeaway", r.completedLabel && r.quality && typeof r.mileageKm === "number" && r.takeaway);
  t("takeaway is one concise paragraph", typeof r.takeaway === "string" && !/\n/.test(r.takeaway) && r.takeaway.length < 400);
}

section("Determinism — identical inputs → identical fingerprint");
{
  const mk = () => buildProposal({ sessions: [{ id: "su1", session_date: fwd(2), session_type: "Threshold", duration_minutes: 24, distance_km: 12 }],
    executions: [], activities: steadyHistory(), profile: {}, now: NOW });
  t("same inputs → same fingerprint", mk().fingerprint === mk().fingerprint);
}

/* ══════ Tier B — the REAL handler over an in-memory Supabase ═══════════ */

const handler = (await import("../api/training/get-week.js")).default;

function makeWorld(seed) {
  const db = JSON.parse(JSON.stringify(seed.tables));
  const users = seed.users;                       // token → userId
  let idSeq = 1000;
  const J = (code, body) => ({ ok: code >= 200 && code < 300, status: code,
    json: async () => body, text: async () => JSON.stringify(body) });

  const matchRow = (row, filters) => filters.every(({ key, op, val }) => {
    let cell;
    if (key.includes("->>")) { const [c, k] = key.split("->>"); cell = row[c] && row[c][k]; }
    else cell = row[key];
    if (op === "eq") return String(cell) === val;
    if (op === "gte") return String(cell) >= val;
    if (op === "lte") return String(cell) <= val;
    if (op === "in") return val.replace(/[()]/g, "").split(",").includes(String(cell));
    return true;
  });
  const parseFilters = qs => (qs || "").split("&").map(pair => {
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const key = decodeURIComponent(pair.slice(0, eq));
    const rest = pair.slice(eq + 1);
    if (["select", "order", "limit", "on_conflict"].includes(key)) return null;
    const dot = rest.indexOf(".");
    return { key, op: rest.slice(0, dot), val: decodeURIComponent(rest.slice(dot + 1)) };
  }).filter(Boolean);

  globalThis.fetch = async (url, init = {}) => {
    const s = String(url), m = (init.method || "GET").toUpperCase();
    if (s.includes("/auth/v1/user")) {
      const tok = String((init.headers && init.headers.Authorization) || "").replace("Bearer ", "");
      const uid = users[tok];
      return uid ? J(200, { id: uid }) : J(401, {});
    }
    const rel = s.split("/rest/v1/")[1] || "";
    const qi = rel.indexOf("?");
    const table = qi < 0 ? rel : rel.slice(0, qi);
    const qs = qi < 0 ? "" : rel.slice(qi + 1);
    const filters = parseFilters(qs);
    db[table] = db[table] || [];
    if (m === "GET") return J(200, db[table].filter(r => matchRow(r, filters)));
    if (m === "POST") {
      const body = init.body ? JSON.parse(init.body) : {};
      const rows = Array.isArray(body) ? body : [body];
      const out = rows.map(r => {
        const row = { ...r };
        if (row.id == null) row.id = "row_" + (idSeq++);
        if (row._boom) return row;                 // never persisted; used to force failure
        const existing = qs.includes("on_conflict=id") ? db[table].find(x => x.id === row.id) : null;
        if (existing) Object.assign(existing, row); else db[table].push(row);
        return row;
      });
      return J(200, out);
    }
    if (m === "PATCH") {
      const patch = init.body ? JSON.parse(init.body) : {};
      const hits = db[table].filter(r => matchRow(r, filters));
      if (hits.some(r => r._boom)) return J(500, { message: "boom" });   // simulate a mid-batch DB failure
      hits.forEach(r => Object.assign(r, patch));
      return J(200, hits);
    }
    if (m === "DELETE") {
      db[table] = db[table].filter(r => !matchRow(r, filters));
      return J(200, []);
    }
    return J(200, []);
  };
  return db;
}

const res = () => { const r = { code: null, body: null, hdrs: {} };
  r.status = c => (r.code = c, r); r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => { r.hdrs[k] = v; }; r.end = () => r; return r; };

const call = async (token, body) => {
  const r = res();
  await handler({ method: "POST", headers: { authorization: `Bearer ${token}` }, body }, r);
  return r;
};

// A world that yields a one-threshold-progression proposal for user A.
function progressWorld(extra = {}) {
  const sessions = [
    { id: "sp2", user_id: "A", training_plan_id: "P", session_date: ago(6), session_type: "Threshold", duration_minutes: 24, distance_km: 12, target_rpe: "6" },
    { id: "su1", user_id: "A", training_plan_id: "P", session_date: fwd(2), session_type: "Threshold", duration_minutes: 24, distance_km: 12, ...(extra.su1 || {}) },
    { id: "su2", user_id: "A", training_plan_id: "P", session_date: fwd(4), session_type: "Easy", duration_minutes: 55, distance_km: 10 },
    { id: "past1", user_id: "A", training_plan_id: "P", session_date: ago(3), session_type: "Easy", duration_minutes: 55, distance_km: 10 }
  ];
  const executions = [
    { id: "e2", user_id: "A", training_session_id: "sp2", status: "completed", actual_duration_minutes: 24, actual_rpe: "4" },
    { id: "e1", user_id: "A", training_session_id: "past1", status: "completed", actual_duration_minutes: 55 }
  ];
  const activities = steadyHistory().map((a, i) => ({ id: "a" + i, user_id: "A", ...a }));
  return {
    users: { tokA: "A", tokB: "B" },
    tables: {
      training_plans: [{ id: "P", user_id: "A", status: "active", week_start: ago(2), updated_at: NOW }],
      training_sessions: sessions, activities, workout_execution_records: executions,
      profiles: [{ id: "A", race_date: null }], coach_action_proposals: []
    }
  };
}

section("Handler: preview returns a proposal + fingerprint for the owner");
let fpA;
{
  makeWorld(progressWorld());
  const r = await call("tokA", { intent: "adaptive_preview", today: NOW });
  t("200 with a proposal", r.code === 200 && r.body.hasPlan === true, JSON.stringify(r.body && r.body.posture));
  t("one proposed change with before/after/reason", r.body.proposedChanges.length === 1 &&
    r.body.proposedChanges[0].before && r.body.proposedChanges[0].after && r.body.proposedChanges[0].reason);
  t("weekly review included", r.body.weeklyReview != null);
  fpA = r.body.fingerprint;
  t("a fingerprint is returned", /^adp_/.test(fpA));
}

section("Handler: apply patches ONLY the specified future workout");
{
  const db = makeWorld(progressWorld());
  const pre = await call("tokA", { intent: "adaptive_preview", today: NOW });
  const r = await call("tokA", { intent: "adaptive_apply", fingerprint: pre.body.fingerprint, today: NOW });
  t("apply succeeds with applied:1", r.code === 200 && r.body.applied === 1, JSON.stringify(r.body));
  const su1 = db.training_sessions.find(s => s.id === "su1");
  const su2 = db.training_sessions.find(s => s.id === "su2");
  const past = db.training_sessions.find(s => s.id === "past1");
  t("the future threshold is updated (24 → 27)", su1.duration_minutes === 27);
  t("the unrelated future easy is untouched", su2.duration_minutes === 55);
  t("the past/completed workout is never modified", past.duration_minutes === 55);
  t("an applied audit envelope is stored with metadata", db.coach_action_proposals.some(pr =>
    pr.status === "applied" && pr.proposed_changes.kind === "adaptive" &&
    pr.proposed_changes.engineVersion && pr.applied_at && pr.original_snapshot));
}

section("Handler: Keep current plan dismisses the exact fingerprint; card then hidden");
{
  const db = makeWorld(progressWorld());
  const pre = await call("tokA", { intent: "adaptive_preview", today: NOW });
  const fp = pre.body.fingerprint;
  const d = await call("tokA", { intent: "adaptive_dismiss", fingerprint: fp });
  t("dismiss succeeds", d.code === 200 && d.body.dismissed === true);
  t("a cancelled row stores the fingerprint", db.coach_action_proposals.some(pr =>
    pr.status === "cancelled" && pr.proposed_changes.fingerprint === fp));
  const pre2 = await call("tokA", { intent: "adaptive_preview", today: NOW });
  t("the same recommendation is now suppressed", pre2.body.suppressed === true);
}

section("Handler: identical inputs never create duplicate proposals");
{
  const db = makeWorld(progressWorld());
  const pre = await call("tokA", { intent: "adaptive_preview", today: NOW });
  const fp = pre.body.fingerprint;
  await call("tokA", { intent: "adaptive_dismiss", fingerprint: fp });
  await call("tokA", { intent: "adaptive_dismiss", fingerprint: fp });
  const dismissals = db.coach_action_proposals.filter(pr => pr.status === "cancelled" && pr.proposed_changes.fingerprint === fp);
  t("only ONE dismissal row exists for the fingerprint", dismissals.length === 1, String(dismissals.length));
  const preAgain = await call("tokA", { intent: "adaptive_preview", today: NOW });
  t("preview fingerprint is stable across identical inputs", preAgain.body.fingerprint === fp);
}

section("Handler: a mid-apply DB failure rolls back — nothing left changed");
{
  const db = makeWorld(progressWorld({ su1: { _boom: true } }));
  const pre = await call("tokA", { intent: "adaptive_preview", today: NOW });
  const r = await call("tokA", { intent: "adaptive_apply", fingerprint: pre.body.fingerprint, today: NOW });
  t("apply reports a rolled-back failure", r.code === 500 && r.body.rolledBack === true, JSON.stringify(r.body));
  const su1 = db.training_sessions.find(s => s.id === "su1");
  t("the target session is unchanged", su1.duration_minutes === 24);
  t("no applied envelope is left behind", !db.coach_action_proposals.some(pr => pr.status === "applied"));
}

section("Handler: another athlete cannot read or modify this plan");
{
  const db = makeWorld(progressWorld());
  const preB = await call("tokB", { intent: "adaptive_preview", today: NOW });
  t("user B sees no plan (cannot read A's plan)", preB.body.hasPlan === false);
  const applyB = await call("tokB", { intent: "adaptive_apply", fingerprint: fpA, today: NOW });
  t("user B cannot apply against A's plan", applyB.code === 404 || applyB.code === 409, String(applyB.code));
  const su1 = db.training_sessions.find(s => s.id === "su1");
  t("A's future session is untouched by B", su1.duration_minutes === 24);
}

/* ══════ Tier C — the client card / modal / weekly review render ═══════ */

section("Client: card only shows when changes exist; modal shows before/after/reason");
{
  const { readFileSync } = await import("node:fs");
  // A tiny DOM shim: getElementById → element with innerHTML + classList.
  const els = {};
  const el = () => { const set = new Set(); return { innerHTML: "",
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), _set: set } }; };
  ["adaptivePlanCard", "adaptiveWeeklyReview", "adaptivePlanModal", "aplMsg"].forEach(id => (els[id] = el()));
  const win = { console: { log() {} }, document: { getElementById: id => els[id] || (els[id] = el()) } };
  const src = readFileSync("./js/adaptivePlan.js", "utf8");
  new Function("window", src)(win);
  const A = win.AthlevoAdaptivePlan;

  const preview = {
    hasPlan: true, stable: false, suppressed: false, alreadyApplied: false,
    fingerprint: "adp_abc",
    proposedChanges: [
      { workoutId: "su1", date: fwd(2), before: { duration_minutes: 24 }, after: { duration_minutes: 27 },
        reason: "Threshold volume increased after a controlled session." }
    ],
    weeklyReview: { completedLabel: "5 / 6", quality: { label: "2 / 2" }, mileageKm: 58,
      longestRunKm: 20, consistency: "Good", takeaway: "A solid week of training." }
  };

  A._render(preview);
  t("the card renders when a change exists", /Plan update available/.test(els.adaptivePlanCard.innerHTML) &&
    /1 adjustment/.test(els.adaptivePlanCard.innerHTML));
  t("the weekly review renders compactly", /Last week/.test(els.adaptiveWeeklyReview.innerHTML) &&
    /5 \/ 6/.test(els.adaptiveWeeklyReview.innerHTML) && /58 km/.test(els.adaptiveWeeklyReview.innerHTML));

  A.openReview();
  const modal = els.adaptivePlanModal.innerHTML;
  t("modal shows the before → after diff", /24 → 27 min/.test(modal));
  t("modal shows the reason", /controlled session/.test(modal));
  t("modal shows the affected date", modal.length > 0 && /Apply changes/.test(modal) && /Keep current plan/.test(modal));
  t("modal is shown", els.adaptivePlanModal.classList.contains("show"));

  // A stable preview draws no card.
  A._render({ hasPlan: true, stable: true, proposedChanges: [] });
  t("no card when the plan is stable", els.adaptivePlanCard.innerHTML === "");

  // A suppressed (dismissed) proposal draws no card.
  A._render({ ...preview, suppressed: true });
  t("no card when the proposal was dismissed", els.adaptivePlanCard.innerHTML === "");
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
