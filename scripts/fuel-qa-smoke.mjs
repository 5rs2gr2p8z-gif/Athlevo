#!/usr/bin/env node
// Fuel QA server smoke test against a Vercel PREVIEW. No OpenAI call is made.
// Usage:
//   FUEL_QA_BASE=https://<preview>.vercel.app FUEL_QA_EMAIL=... FUEL_QA_PASSWORD=... \
//     node scripts/fuel-qa-smoke.mjs
// Optional: VERCEL_BYPASS_SECRET (Protection Bypass for Automation) if the preview is protected.
// Credentials come from the environment only; use a disposable QA account.
// Creates exactly one manual meal and deletes it again.
import { randomUUID } from "node:crypto";

const SUPABASE_URL = "https://hqwdehqsllyvrcnlcytj.supabase.co";
const ANON = "sb_publishable_KxbACTdnsHG_uFNAV01bfA_NGkW-PCt"; // public key, same as index.html

export async function runSmoke({ base, email, password, bypass, fetchImpl = fetch, log = console.log }) {
  if (!/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(base || "")) throw new Error("FUEL_QA_BASE must be a https://*.vercel.app preview origin (never athlevo.org).");
  const results = [];
  const check = (name, ok, extra = "") => { results.push({ name, ok }); log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
  const hdr = extra => ({ "Content-Type": "application/json", ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}), ...extra });
  const api = (path, opts = {}) => fetchImpl(base + path, { ...opts, headers: hdr(opts.headers) });

  let r = await api("/api/fuel/meals", { method: "POST", body: "{}" });
  check("unauthenticated POST /api/fuel/meals rejected", r.status === 401, `(${r.status})`);
  r = await api("/api/fuel/analyze-meal", { method: "POST", body: "{}" });
  check("unauthenticated POST /api/fuel/analyze-meal rejected", r.status === 401, `(${r.status})`);
  if (results.some(x => !x.ok)) { log("Stop: gateway not reachable/protected? (401 expected, 401 from Vercel Authentication HTML also counts as blocked — see docs)."); return results; }

  if (!email || !password) { log("SKIP authenticated checks: set FUEL_QA_EMAIL / FUEL_QA_PASSWORD."); return results; }
  const tok = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const session = await tok.json().catch(() => ({}));
  check("test account signs in", tok.ok && !!session.access_token);
  if (!session.access_token) return results;
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const rest = () => fetchImpl(`${SUPABASE_URL}/rest/v1/fuel_meals?select=id&limit=1`, { headers: { apikey: ANON, ...auth } });
  const read = await rest();
  check("authenticated Fuel meal read (RLS, tables exist)", read.ok, `(${read.status})`);

  const today = new Date().toISOString().slice(0, 10);
  const create = await api("/api/fuel/meals", { method: "POST", headers: auth, body: JSON.stringify({ source: "manual", local_date: today, meal_name: "QA smoke (auto-deleted)", calories: 1, carbs_g: 0, protein_g: 0, fat_g: 0, client_id: randomUUID() }) });
  const created = await create.json().catch(() => ({}));
  const id = created.meal && created.meal.id;
  check("manual meal create", create.status === 201 && !!id, `(${create.status})`);
  if (id) {
    const del = await api(`/api/fuel/meals?id=${id}`, { method: "DELETE", headers: auth });
    check("delete the test meal", del.ok, `(${del.status})`);
    const again = await api(`/api/fuel/meals?id=${id}`, { method: "DELETE", headers: auth });
    check("meal is really gone (second delete 404)", again.status === 404, `(${again.status})`);
  }
  return results;
}

export const EXPECTED_CHECKS = 7;

// Final verdict line. Never prints credentials or tokens.
export function verdict(results) {
  const failed = results.filter(x => !x.ok).length;
  if (failed) return "FUEL QA SMOKE FAILED";
  if (results.length < EXPECTED_CHECKS) return "FUEL QA SMOKE INCOMPLETE";
  return "FUEL QA SMOKE PASSED";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let res = [];
  try {
    res = await runSmoke({ base: process.env.FUEL_QA_BASE, email: process.env.FUEL_QA_EMAIL, password: process.env.FUEL_QA_PASSWORD, bypass: process.env.VERCEL_BYPASS_SECRET });
  } catch (e) {
    console.log(`ERROR  ${e && e.message ? e.message : e}`);
    res = [{ name: "smoke run", ok: false }];
  }
  const line = verdict(res);
  console.log(line);
  process.exit(line === "FUEL QA SMOKE PASSED" ? 0 : 1);
}
