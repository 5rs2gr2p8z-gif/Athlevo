/*
 * Daily Readiness helpers — shared by the coaching consumers (daily
 * brief, weekly analysis, plan generation) and mirrored on the client.
 *
 * Lives OUTSIDE /api so it costs no Vercel function. Nothing here invents
 * data: readiness is only ever the athlete's own reported inputs. The
 * "signal" below is a transparent qualitative interpretation of those
 * inputs — never a fabricated readiness, HRV, or recovery score.
 */

export const SLEEP_QUALITY_LABELS = {
  1: "Very poor",
  2: "Poor",
  3: "Fair",
  4: "Good",
  5: "Excellent"
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

/*
 * A clean, null-free view of a readiness record for an AI payload. Only
 * the athlete's actual answers survive — the model never sees nulls, and
 * there is no invented score.
 */
export function summarizeReadiness(record) {
  if (!record) {
    return null;
  }

  const out = {};

  if (record.readiness_date) {
    out.date = record.readiness_date;
  }

  const sleep = num(record.sleep_quality);
  if (sleep !== null && SLEEP_QUALITY_LABELS[sleep]) {
    out.sleep_quality = SLEEP_QUALITY_LABELS[sleep];
  }

  const energy = num(record.energy);
  if (energy !== null) out.energy_1_to_10 = energy;

  const soreness = num(record.muscle_soreness);
  if (soreness !== null) out.muscle_soreness_1_to_10 = soreness;

  const stress = num(record.mental_stress);
  if (stress !== null) out.mental_stress_1_to_10 = stress;

  if (record.pain_present === true) {
    out.pain = { present: true };
    const location = cleanText(record.pain_location, 200);
    if (location) out.pain.location = location;
    const severity = num(record.pain_severity);
    if (severity !== null) out.pain.severity_1_to_10 = severity;
  }

  const notes = cleanText(record.notes, 1000);
  if (notes) out.notes = notes;

  return Object.keys(out).length ? out : null;
}

/*
 * A transparent, qualitative reading of today's readiness built ONLY from
 * the athlete's own answers. Returns a status plus the specific reasons,
 * so the coach can explain a decision ("you reported poor sleep and high
 * soreness") rather than cite a made-up number. Never returns a score.
 *
 *   status: "good" | "moderate" | "compromised" | "unknown"
 */
export function assessReadinessSignal(record) {
  if (!record) {
    return { status: "unknown", reasons: [], painPresent: false };
  }

  const parts = [];
  const reasons = [];

  const sleep = num(record.sleep_quality); // 1..5
  if (sleep !== null) {
    parts.push((sleep - 1) / 4);
    if (sleep <= 2) {
      reasons.push(
        `sleep was ${(SLEEP_QUALITY_LABELS[sleep] || "poor").toLowerCase()}`
      );
    }
  }

  const energy = num(record.energy); // 1..10 (high good)
  if (energy !== null) {
    parts.push((energy - 1) / 9);
    if (energy <= 3) reasons.push("energy is low");
  }

  const soreness = num(record.muscle_soreness); // 1..10 (low good)
  if (soreness !== null) {
    parts.push((10 - soreness) / 9);
    if (soreness >= 7) reasons.push("muscle soreness is high");
  }

  const stress = num(record.mental_stress); // 1..10 (low good)
  if (stress !== null) {
    parts.push((10 - stress) / 9);
    if (stress >= 7) reasons.push("mental stress is high");
  }

  const painPresent = record.pain_present === true;
  if (painPresent) {
    const location = cleanText(record.pain_location, 120);
    reasons.push(location ? `pain reported (${location})` : "pain reported");
  }

  if (parts.length < 2 && !painPresent) {
    return { status: "unknown", reasons, painPresent };
  }

  const average = parts.length
    ? parts.reduce((a, b) => a + b, 0) / parts.length
    : 0.5;

  let status;
  if (painPresent || average < 0.4) {
    status = "compromised";
  } else if (average < 0.66) {
    status = "moderate";
  } else {
    status = "good";
  }

  return { status, reasons, painPresent };
}

/* ─── readiness score engine ──────────────────────────────────── */

export const READINESS_STATUS = {
  low: { label: "Low", color: "#C0272D" },        // red
  moderate: { label: "Moderate", color: "#E07B1A" }, // orange
  good: { label: "Good", color: "#E0B21A" },      // yellow
  optimal: { label: "Optimal", color: "#1F9D5B" } // green
};

function clampNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export function readinessStatusFromScore(score) {
  if (!Number.isFinite(Number(score))) return "insufficient";
  const s = Number(score);
  if (s < 40) return "low";
  if (s < 60) return "moderate";
  if (s < 80) return "good";
  return "optimal";
}

/*
 * Calculates a 0–100 readiness score. It is DERIVED, never random or
 * hardcoded, and only from data the athlete actually provided:
 *   - the morning check-in (sleep, energy, soreness, stress, pain) — the
 *     required foundation; without at least two subjective answers we
 *     return { sufficient: false } and callers must say so, never invent.
 *   - objective training signals when available (yesterday's load, recent
 *     completion, recent skips, an acute load spike) nudge the score.
 * No HRV/recovery value is ever fabricated.
 *
 * inputs: {
 *   sleep(1-5), energy(1-10), soreness(1-10), stress(1-10),
 *   painPresent(bool), painSeverity(1-10),
 *   yesterdayHard(bool), recentCompletionRate(0-1),
 *   recentSkips(int), acuteSpike(bool)
 * }
 */
export function computeReadinessScore(inputs) {
  const i = inputs || {};

  const components = [];

  const sleep = clampNum(i.sleep, 1, 5);
  if (sleep !== null) {
    components.push({ key: "sleep", good: (sleep - 1) / 4, weight: 0.3 });
  }

  const energy = clampNum(i.energy, 1, 10);
  if (energy !== null) {
    components.push({ key: "energy", good: (energy - 1) / 9, weight: 0.25 });
  }

  const soreness = clampNum(i.soreness, 1, 10);
  if (soreness !== null) {
    components.push({
      key: "soreness",
      good: (10 - soreness) / 9,
      weight: 0.25
    });
  }

  const stress = clampNum(i.stress, 1, 10);
  if (stress !== null) {
    components.push({ key: "stress", good: (10 - stress) / 9, weight: 0.2 });
  }

  // The score is anchored in the athlete's own report. Without it, we do
  // not invent a number.
  if (components.length < 2) {
    return {
      sufficient: false,
      score: null,
      status: "insufficient",
      color: null,
      explanation:
        "Complete today's morning check-in so Athlevo can calculate your readiness.",
      drivers: { positive: [], negative: [] }
    };
  }

  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const base =
    components.reduce((a, c) => a + c.good * c.weight, 0) / totalWeight;

  const painPresent = i.painPresent === true;
  let painPenalty = 0;
  if (painPresent) {
    const severity = clampNum(i.painSeverity, 1, 10);
    painPenalty = Math.min(0.35, 0.1 + (severity === null ? 5 : severity) * 0.025);
  }

  let adjustment = 0;
  const negativeDrivers = [];
  const positiveDrivers = [];

  if (i.yesterdayHard === true) {
    adjustment -= 0.08;
    negativeDrivers.push("yesterday's hard session");
  }

  const completion = clampNum(i.recentCompletionRate, 0, 1);
  if (completion !== null && completion >= 0.85 && !painPresent) {
    adjustment += 0.04;
    positiveDrivers.push("consistent recent training");
  }

  const skips = clampNum(i.recentSkips, 0, 100);
  if (skips !== null && skips >= 2) {
    adjustment -= 0.04;
    negativeDrivers.push("missed sessions recently");
  }

  if (i.acuteSpike === true) {
    adjustment -= 0.06;
    negativeDrivers.push("a sharp jump in recent load");
  }

  const score = Math.round(
    Math.min(1, Math.max(0, base - painPenalty + adjustment)) * 100
  );

  // Name the strongest subjective drivers for the explanation.
  const label = {
    sleep: { pos: "good sleep", neg: "poor sleep" },
    energy: { pos: "strong energy", neg: "low energy" },
    soreness: { pos: "low soreness", neg: "high soreness" },
    stress: { pos: "low stress", neg: "high stress" }
  };

  components
    .slice()
    .sort((a, b) => b.good - a.good)
    .forEach(c => {
      if (c.good >= 0.7) positiveDrivers.unshift(label[c.key].pos);
      else if (c.good <= 0.4) negativeDrivers.unshift(label[c.key].neg);
    });

  if (painPresent) {
    negativeDrivers.unshift("reported pain (handled cautiously)");
  }

  const status = readinessStatusFromScore(score);

  return {
    sufficient: true,
    score,
    status,
    color: READINESS_STATUS[status].color,
    drivers: {
      positive: positiveDrivers.slice(0, 2),
      negative: negativeDrivers.slice(0, 2)
    },
    explanation: buildReadinessExplanation(status, positiveDrivers, negativeDrivers)
  };
}

function buildReadinessExplanation(status, positives, negatives) {
  const pos = positives.slice(0, 2);
  const neg = negatives.slice(0, 2);
  const join = arr =>
    arr.length === 2 ? `${arr[0]} and ${arr[1]}` : arr[0];

  if (pos.length && neg.length) {
    return `${cap(join(pos))} help today; ${join(neg)} pull it down.`;
  }
  if (pos.length) {
    return `${cap(join(pos))} carry today's readiness.`;
  }
  if (neg.length) {
    return `${cap(join(neg))} weigh on today's readiness.`;
  }

  const fallback = {
    optimal: "Your check-in points to a fresh, ready day.",
    good: "Your check-in points to a solid day.",
    moderate: "Your check-in shows a middling day — train, but stay honest.",
    low: "Your check-in shows you're under-recovered today."
  };
  return fallback[status] || "Based on today's check-in.";
}

function cap(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/* Short, athlete-facing factual summary line (no invented score). */
export function readinessSummaryLine(record) {
  const summary = summarizeReadiness(record);

  if (!summary) {
    return "";
  }

  const bits = [];
  if (summary.sleep_quality) bits.push(`Sleep ${summary.sleep_quality}`);
  if (summary.energy_1_to_10 != null) {
    bits.push(`Energy ${summary.energy_1_to_10}/10`);
  }
  if (summary.muscle_soreness_1_to_10 != null) {
    bits.push(`Soreness ${summary.muscle_soreness_1_to_10}/10`);
  }
  if (summary.mental_stress_1_to_10 != null) {
    bits.push(`Stress ${summary.mental_stress_1_to_10}/10`);
  }
  if (summary.pain) {
    bits.push(
      summary.pain.location ? `Pain: ${summary.pain.location}` : "Pain reported"
    );
  }

  return bits.join(" · ");
}
