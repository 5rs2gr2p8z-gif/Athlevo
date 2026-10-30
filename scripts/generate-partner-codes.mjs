#!/usr/bin/env node
/*
 * Make a batch of unique partner discount codes (one per runner) for the public sign-up.
 *
 *   node scripts/generate-partner-codes.mjs --partner race-2026-11-24 --count 100
 *
 * Options
 *   --partner <label>   internal label for this batch, shown only to you (required).
 *                       Lower-case letters, digits, dots, dashes and underscores.
 *   --count <n>         how many codes to make, 1 to 1000 (required)
 *   --percent <n>       percent off, 1 to 50 (default 10)
 *   --products <list>   leave out for Athlevo Guided and Athlevo Coaching (the default). The ₱999
 *                       Athlevo Plan and VIP Coaching take a code only when named: any of
 *                       training-plan, guided, coaching, vip (comma separated). "plan" is refused,
 *                       because it used to mean the ₱1,998 offer, which is now "guided"; the new ₱999
 *                       Athlevo Plan is "training-plan". The old name "elite" still works and means vip.
 *   --expires <date>    last day a code works, YYYY-MM-DD in Philippine time (default: no expiry)
 *   --note <text>       free text stored with each code
 *   --out <folder>      where to write the files (default: partner-codes/, which git ignores)
 *
 * It writes two files and changes nothing else:
 *   <label>-<time>.sql   paste into the Supabase SQL editor to switch the codes on
 *   <label>-<time>.csv   the codes (ABCD-EFGH) to hand out, one per row
 * Codes are only valid once the SQL has been run. Running it twice is harmless.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CODE_PRODUCT_IDS, MAX_DISCOUNT_PERCENT, PARTNER_CODE_ALPHABET, PARTNER_CODE_LENGTH, formatPartnerCode
} from "../lib/server/partnerCodes.js";

// ATHLEVO_PLAN_MONTHLY is Guided (the offer that used to be called Athlevo Plan) and
// ATHLEVO_ELITE_MONTHLY is VIP Coaching (formerly Elite Coaching): product ids never change on a rename.
const PRODUCT_IDS = {
  "training-plan": "ATHLEVO_TRAINING_PLAN", guided: "ATHLEVO_PLAN_MONTHLY", coaching: "ATHLEVO_COACHING_MONTHLY",
  vip: "ATHLEVO_ELITE_MONTHLY", elite: "ATHLEVO_ELITE_MONTHLY"
};
const MAX_COUNT = 1000;

/** `count` distinct codes. `randomInt` is injectable so a test can force collisions. */
export function generateCodes(count, randomInt = crypto.randomInt) {
  const codes = new Set();
  while (codes.size < count) {
    let code = "";
    for (let i = 0; i < PARTNER_CODE_LENGTH; i += 1) {
      code += PARTNER_CODE_ALPHABET[randomInt(PARTNER_CODE_ALPHABET.length)];
    }
    codes.add(code);
  }
  return [...codes];
}

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function parseOptions(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    raw[arg.slice(2)] = value;
    i += 1;
  }
  const known = ["partner", "count", "percent", "products", "expires", "note", "out"];
  const unknown = Object.keys(raw).filter(key => !known.includes(key));
  if (unknown.length) throw new Error(`Unknown option: --${unknown[0]}`);

  const partner = String(raw.partner || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(partner)) {
    throw new Error("--partner is required: lower-case letters, digits, dots, dashes, underscores (for example race-2026-11-24)");
  }
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`--count must be a whole number from 1 to ${MAX_COUNT}`);
  const percent = raw.percent === undefined ? 10 : Number(raw.percent);
  if (!Number.isInteger(percent) || percent < 1 || percent > MAX_DISCOUNT_PERCENT) {
    throw new Error(`--percent must be a whole number from 1 to ${MAX_DISCOUNT_PERCENT}`);
  }
  let productIds = null;
  if (raw.products !== undefined) {
    const names = String(raw.products).toLowerCase().trim().split(",").map(item => item.trim()).filter(Boolean);
    // "plan" used to mean the ₱1,998 offer, which is now Guided. It is refused so an old command fails
    // loudly instead of quietly making codes for a different offer.
    if (names.includes("plan")) throw new Error('--products plan is ambiguous since the offers were renamed: use "guided" for the offer that used to be called Athlevo Plan, or "training-plan" for the new ₱999 Athlevo Plan');
    if (!names.length || names.some(name => !PRODUCT_IDS[name])) throw new Error("--products must be training-plan, guided, coaching and/or vip");
    productIds = [...new Set(names)].map(name => PRODUCT_IDS[name]);
    // Exactly Guided and Coaching is what a code with no list already means, so store no list.
    if (productIds.length === DEFAULT_CODE_PRODUCT_IDS.length && DEFAULT_CODE_PRODUCT_IDS.every(id => productIds.includes(id))) productIds = null;
  }
  let expiresAt = null;
  if (raw.expires !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.expires) || Number.isNaN(Date.parse(`${raw.expires}T00:00:00+08:00`))) {
      throw new Error("--expires must be a date like 2026-12-31");
    }
    expiresAt = `${raw.expires}T23:59:59+08:00`;
  }
  return {
    partner, count, percent, productIds, expiresAt,
    note: raw.note === undefined ? null : String(raw.note).slice(0, 200),
    out: raw.out || "partner-codes"
  };
}

export function buildSql(codes, options) {
  const products = options.productIds
    ? `array[${options.productIds.map(sqlText).join(", ")}]::text[]`
    : "null";
  const rows = codes.map(code =>
    `  (${sqlText(code)}, ${sqlText(options.partner)}, ${options.percent}, ${products}, ` +
    `${options.expiresAt ? sqlText(options.expiresAt) + "::timestamptz" : "null"}, ` +
    `${options.note ? sqlText(options.note) : "null"})`);
  return [
    `-- ${codes.length} partner codes for "${options.partner}" (${options.percent}% off).`,
    "-- Run in the Supabase SQL editor. Safe to run twice: a code that already exists is skipped.",
    "insert into public.partner_codes (code, partner, percent_off, product_ids, expires_at, note) values",
    rows.join(",\n"),
    "on conflict (code) do nothing;",
    ""
  ].join("\n");
}

export function buildCsv(codes, options) {
  return ["code,batch,percent_off,expires"].concat(codes.map(code =>
    [formatPartnerCode(code), options.partner, options.percent, options.expiresAt ? options.expiresAt.slice(0, 10) : ""].join(","))
  ).join("\n") + "\n";
}

function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\nUsage: node scripts/generate-partner-codes.mjs --partner <label> --count <n> [--percent 10] [--products training-plan,guided,coaching,vip] [--expires YYYY-MM-DD] [--note text] [--out folder]`);
    process.exit(1);
  }
  const codes = generateCodes(options.count);
  fs.mkdirSync(options.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const base = path.join(options.out, `${options.partner}-${stamp}`);
  fs.writeFileSync(`${base}.sql`, buildSql(codes, options), { flag: "wx" });
  fs.writeFileSync(`${base}.csv`, buildCsv(codes, options), { flag: "wx" });
  console.log(`Made ${codes.length} codes for "${options.partner}" (${options.percent}% off` +
    `${options.expiresAt ? ", last day " + options.expiresAt.slice(0, 10) : ", no expiry"}).`);
  console.log(`  1. Run in Supabase SQL editor: ${base}.sql`);
  console.log(`  2. Hand out the codes from:    ${base}.csv`);
  console.log("The codes only work after step 1.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
