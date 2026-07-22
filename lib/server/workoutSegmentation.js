/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Workout Segmentation
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Reconstructs the ACTUAL structure of a run — warm-up, work reps, recoveries,
 *  cooldown — instead of counting every fast sample. This is what fixes the
 *  "17 × 5:11/km" bug: 17 one-kilometre auto-splits were each treated as a rep.
 *
 *  Two paths, in priority order:
 *
 *    1. EXPLICIT structure. If the laps carry Intervals.icu interval types
 *       (WARMUP / WORK / RECOVERY / COOLDOWN), that IS the workout. We merge
 *       contiguous same-type laps into blocks and return them directly — no
 *       reconstruction, no guessing.
 *
 *    2. RECONSTRUCTION. When only plain laps/splits exist, we classify each lap
 *       as work / recovery / easy relative to the run's own easy baseline, then
 *       apply HYSTERESIS + MINIMUM DURATIONS and MERGE contiguous laps of the
 *       same effort into one segment. Tiny pace fluctuations can never spawn a
 *       new interval, so a steady run yields ONE segment, not seventeen.
 *
 *  segmentWorkout(laps, opts?) → [ { type, duration, avgPace, distance,
 *                                    reps?, reason } ]  (Part 4 shape)
 *
 *  type ∈ warmup | work | recovery | cooldown | steady
 *  avgPace is seconds per km. Every segment records WHY its boundary was chosen.
 *
 *  Pure + deterministic. No I/O.
 */

const DEFAULTS = {
  minWorkSec: 60,        // a work block shorter than this is noise
  minRecoverySec: 30,    // a recovery shorter than this is absorbed into work
  hysteresisPct: 0.06,   // pace must move >6% to count as an effort CHANGE
  workFasterPct: 0.90,   // "work" = ≤90% of the easy-baseline pace (i.e. faster)
  minLapsForReconstruct: 4
};

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

function lapPaceSec(l) {
  const d = num(l.distance != null ? l.distance : l.distance_meters);
  const s = num(l.moving_time != null ? l.moving_time
    : (l.moving_time_seconds != null ? l.moving_time_seconds : l.elapsed_time));
  if (!d || !s || d <= 0) return null;
  return s / (d / 1000);
}
function lapSec(l) {
  return num(l.moving_time != null ? l.moving_time
    : (l.moving_time_seconds != null ? l.moving_time_seconds : l.elapsed_time)) || 0;
}
function lapDist(l) { return num(l.distance != null ? l.distance : l.distance_meters) || 0; }

/* ── explicit Intervals.icu interval types ───────────────────────────── */

function mapType(raw) {
  const t = String(raw || "").toUpperCase();
  if (/WARM/.test(t)) return "warmup";
  if (/COOL/.test(t)) return "cooldown";
  if (/RECOV|REST/.test(t)) return "recovery";
  if (/WORK|ACTIVE|INTERVAL/.test(t)) return "work";
  return null;
}

function hasExplicitTypes(laps) {
  return Array.isArray(laps) && laps.some(l => mapType(l.type) != null);
}

// Merge contiguous same-type laps into blocks.
function fromExplicit(laps) {
  const out = [];
  for (const l of laps) {
    const type = mapType(l.type) || "work";
    const sec = lapSec(l), dist = lapDist(l);
    const prev = out[out.length - 1];
    if (prev && prev.type === type) {
      prev.duration += sec; prev.distance += dist; prev._laps += 1;
    } else {
      out.push({ type, duration: sec, distance: dist, _laps: 1 });
    }
  }
  return finalize(out, "explicit interval types from the device");
}

/* ── reconstruction from plain laps ──────────────────────────────────── */

/*
 * The work threshold, found by the largest PACE GAP.
 *
 * A single absolute cut can't separate three effort levels (work / moderate /
 * recovery). Instead we sort the paces and walk from the fastest, looking for
 * the first big jump — the natural boundary between the work cluster and
 * everything easier. Work = anything faster than that gap.
 *
 * Returns null when there is no meaningful gap (a steady run or a smooth
 * progression) — which is exactly what stops uniform splits from becoming reps.
 */
function workThreshold(paces, gapRatio) {
  const sorted = paces.slice().sort((a, b) => a - b);   // fastest first
  if (sorted.length < 2) return null;
  // Overall contrast gate: no clearly-faster segment at all → no work.
  if (sorted[sorted.length - 1] / sorted[0] < 1.08) return null;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] / sorted[i] >= gapRatio) {
      // Cut sits between the fast cluster and the next (slower) level.
      return (sorted[i] + sorted[i + 1]) / 2;
    }
  }
  return null;   // smooth spread (e.g. a progression) → no discrete work reps
}

function reconstruct(laps, opts) {
  const paced = laps.map(l => ({ pace: lapPaceSec(l), sec: lapSec(l), dist: lapDist(l) }))
    .filter(x => x.pace != null && x.sec > 0);
  if (paced.length < opts.minLapsForReconstruct) {
    // Too few laps to reconstruct — one steady block.
    return finalize([blockOf(paced, "steady")], "too few laps to reconstruct structure");
  }

  const gapRatio = 1 + Math.max(0.09, opts.hysteresisPct * 1.4);   // a real level change
  const workCut = workThreshold(paced.map(x => x.pace), gapRatio);
  if (workCut == null) {
    // No discrete work cluster → one steady block (steady run / tempo without
    // laps / progression). Never fragmented into tiny intervals.
    return finalize([blockOf(paced, "steady")], "no discrete work cluster — a steady effort");
  }

  // 1. Label each lap by effort with a HARD cut at the natural gap. HYSTERESIS
  //    lives in the gap-detection sensitivity above (a bigger hysteresisPct
  //    demands a wider pace gap before any split is made), and the real
  //    noise filter is the minimum-duration absorption in step 3. A per-lap
  //    "stay band" is deliberately NOT used: with lap-level data the gap
  //    midpoint already separates work from recovery cleanly, and a stay band
  //    would swallow a genuine recovery that sits just past the cut.
  const labels = paced.map(x => x.pace <= workCut ? "work" : "easy");

  // 2. Merge contiguous same-label laps into raw blocks.
  let blocks = [];
  for (let i = 0; i < paced.length; i++) {
    const label = labels[i];
    const prev = blocks[blocks.length - 1];
    if (prev && prev.label === label) { prev.laps.push(paced[i]); }
    else blocks.push({ label, laps: [paced[i]] });
  }

  // 3. Absorb sub-minimum blocks into their neighbours (noise filtering).
  //    A too-short "easy" between two "work" blocks is a genuine recovery only
  //    if it meets minRecoverySec; otherwise it's noise and the works merge.
  blocks = absorbShort(blocks, opts);

  // 4. Name the blocks positionally: leading easy = warmup, trailing easy =
  //    cooldown, easy between works = recovery, work = work.
  const named = nameBlocks(blocks);
  return finalize(named.map(b => ({
    type: b.type,
    duration: b.laps.reduce((s, l) => s + l.sec, 0),
    distance: b.laps.reduce((s, l) => s + l.dist, 0),
    _laps: b.laps.length
  })), "reconstructed from pace transitions (hysteresis + minimum durations)");
}

function blockOf(paced, type) {
  return { type, duration: paced.reduce((s, l) => s + l.sec, 0),
    distance: paced.reduce((s, l) => s + l.dist, 0), _laps: paced.length };
}

// Absorb blocks below the minimum duration into the adjacent block.
function absorbShort(blocks, opts) {
  let changed = true;
  while (changed && blocks.length > 1) {
    changed = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const sec = b.laps.reduce((s, l) => s + l.sec, 0);
      const min = b.label === "work" ? opts.minWorkSec : opts.minRecoverySec;
      if (sec >= min) continue;
      // Merge into the neighbour with the closer effort (prefer the previous).
      const into = blocks[i - 1] || blocks[i + 1];
      if (!into) continue;
      into.laps = (i > 0) ? into.laps.concat(b.laps) : b.laps.concat(into.laps);
      blocks.splice(i, 1);
      changed = true;
      break;
    }
  }
  return blocks;
}

function nameBlocks(blocks) {
  const workIdx = blocks.map((b, i) => b.label === "work" ? i : -1).filter(i => i >= 0);
  const firstWork = workIdx.length ? workIdx[0] : Infinity;
  const lastWork = workIdx.length ? workIdx[workIdx.length - 1] : -Infinity;
  return blocks.map((b, i) => {
    if (b.label === "work") return { ...b, type: "work" };
    if (i < firstWork) return { ...b, type: "warmup" };
    if (i > lastWork) return { ...b, type: "cooldown" };
    return { ...b, type: "recovery" };
  });
}

/* ── shared finalisation ─────────────────────────────────────────────── */

function finalize(rawSegs, reason) {
  const segs = rawSegs.filter(s => s && s.duration > 0).map(s => ({
    type: s.type,
    duration: Math.round(s.duration),
    distance: Math.round(s.distance),
    avgPace: s.distance > 0 ? Math.round(s.duration / (s.distance / 1000)) : null,
    reason
  }));
  const work = segs.filter(s => s.type === "work");
  return {
    segments: segs,
    reps: work.length,
    workDurationSec: work.reduce((a, s) => a + s.duration, 0),
    avgWorkSec: work.length ? Math.round(work.reduce((a, s) => a + s.duration, 0) / work.length) : 0,
    source: reason
  };
}

/* ── public entry ────────────────────────────────────────────────────── */

function segmentWorkout(laps, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!Array.isArray(laps) || laps.length === 0) {
    return { segments: [], reps: 0, workDurationSec: 0, avgWorkSec: 0, source: "no lap data" };
  }
  if (hasExplicitTypes(laps)) return fromExplicit(laps);
  return reconstruct(laps, o);
}

export { segmentWorkout, DEFAULTS };
export default segmentWorkout;
