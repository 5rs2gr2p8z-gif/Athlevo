/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Athlete coaching mode   ·   authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE place that decides whether an athlete is self_guided or human_coached.
 *  Decided from the athlete's ACTIVE coach assignments (loaded server-side via
 *  the service role). The client can never change the mode — the server
 *  re-resolves it on every managed read/write.
 *
 *  Rules (conservative by design — errs toward human_coached so AI can never
 *  silently overwrite a coach's plan):
 *    · no active assignment           → self_guided
 *    · exactly one active assignment  → human_coached (that coach is primary)
 *    · multiple active assignments    → human_coached, primary = earliest
 *      assigned_at (deterministic), flagged ambiguous for resolution
 *    · invited / paused / ended       → do NOT activate managed mode
 */

export const COACHING_MODES = ["self_guided", "human_coached"];

function str(v) { return v == null ? "" : String(v); }

// Active assignments where THIS athlete is the athlete.
function activeAssignmentsForAthlete(assignments, athleteId) {
  const aid = str(athleteId);
  if (!aid) return [];
  return (Array.isArray(assignments) ? assignments : []).filter(
    a => a && str(a.athlete_id) === aid && str(a.status) === "active"
  );
}

/*
 * resolveCoachingMode(assignments, athleteId) →
 *   {
 *     mode: "self_guided" | "human_coached",
 *     coachId: string | null,     // the primary active coach
 *     assignment: row | null,     // the primary assignment
 *     ambiguous: boolean,         // >1 active coach (needs resolution)
 *     activeCoachCount: number
 *   }
 *
 * Deterministic: primary = the active assignment with the earliest
 * assigned_at (ties broken by assignment id) so the same inputs always pick
 * the same coach.
 */
export function resolveCoachingMode(assignments, athleteId) {
  const active = activeAssignmentsForAthlete(assignments, athleteId);
  if (!active.length) {
    return { mode: "self_guided", coachId: null, assignment: null, ambiguous: false, activeCoachCount: 0 };
  }
  const sorted = active.slice().sort((a, b) => {
    const ta = Date.parse(a.assigned_at || a.created_at || 0) || 0;
    const tb = Date.parse(b.assigned_at || b.created_at || 0) || 0;
    if (ta !== tb) return ta - tb;
    return str(a.id).localeCompare(str(b.id));
  });
  const primary = sorted[0];
  // Dedup coaches (a malformed duplicate row must not read as "ambiguous").
  const distinctCoaches = new Set(active.map(a => str(a.coach_id)));
  return {
    mode: "human_coached",
    coachId: str(primary.coach_id) || null,
    assignment: primary,
    ambiguous: distinctCoaches.size > 1,
    activeCoachCount: distinctCoaches.size
  };
}

export function isHumanCoached(assignments, athleteId) {
  return resolveCoachingMode(assignments, athleteId).mode === "human_coached";
}

/*
 * Build the SAFE coach profile the athlete may see. Never includes email
 * (unless a future explicit public flag is set) or any private/business field.
 */
export function buildSafeCoachProfile(coachProfile, assignment) {
  const p = coachProfile || {};
  const name = str(p.full_name) || "Your coach";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = !parts.length
    ? "C"
    : parts.length === 1
      ? parts[0].slice(0, 1).toUpperCase()
      : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return {
    display_name: name,
    initials,
    coaching_title: str(p.coaching_title) || "Coach",
    assignment_start_date: assignment ? str(assignment.assigned_at) : null,
    // Only surface email if a profile explicitly marks it public.
    public_contact: p.public_contact_email && p.contact_email_is_public === true
      ? str(p.contact_email) : null
  };
}

export const COACHING_MODE_VERSION = "coaching-mode-v1";
