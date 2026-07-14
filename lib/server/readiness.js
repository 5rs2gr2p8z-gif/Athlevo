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
