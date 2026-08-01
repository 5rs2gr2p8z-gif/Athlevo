/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach ⇄ Athlete assignments   ·   authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Pure authorization core for coach access. The API loads assignment rows via
 *  the service role and passes them here; these functions decide access. No
 *  client-supplied athlete_id is ever trusted — access is only granted when an
 *  ACTIVE assignment row (coach_id → athlete_id) exists for the AUTHENTICATED
 *  coach.
 *
 *  Statuses: invited · active · paused · ended. Only `active` grants access.
 */

export const ASSIGNMENT_STATUSES = ["invited", "active", "paused", "ended"];
export const ACCESS_GRANTING_STATUSES = ["active"];

function str(v) {
  return v == null ? "" : String(v);
}

/*
 * Keep only rows that (a) belong to this coach and (b) are ACTIVE. Everything
 * else — ended, paused, invited, or another coach's row — grants nothing.
 */
export function activeAssignmentsForCoach(assignments, coachId) {
  const cid = str(coachId);
  if (!cid) return [];
  return (Array.isArray(assignments) ? assignments : []).filter(
    a => a && str(a.coach_id) === cid && str(a.status) === "active"
  );
}

/*
 * The set of athlete ids this coach may access right now. Deduplicated, so a
 * malformed duplicate row can never widen or double-count access.
 */
export function assignedAthleteIds(assignments, coachId) {
  const ids = new Set();
  for (const a of activeAssignmentsForCoach(assignments, coachId)) {
    if (a.athlete_id != null) ids.add(str(a.athlete_id));
  }
  return [...ids];
}

/*
 * THE authorization check. Access requires an ACTIVE assignment linking THIS
 * coach to THIS athlete. A client-supplied athlete_id that is not in the
 * coach's active set is denied — the id alone can never bypass authorization.
 */
export function canCoachAccessAthlete(assignments, coachId, athleteId) {
  const aid = str(athleteId);
  if (!aid) return false;
  return activeAssignmentsForCoach(assignments, coachId).some(
    a => str(a.athlete_id) === aid
  );
}

/*
 * Would inserting {coachId, athleteId} create a DUPLICATE live assignment?
 * "Live" = invited/active/paused (the same set the partial unique index
 * guards). Used by the admin/bootstrap path before creating a row so the
 * app-level check matches the DB constraint.
 */
export function wouldDuplicateLiveAssignment(assignments, coachId, athleteId) {
  const cid = str(coachId);
  const aid = str(athleteId);
  const LIVE = ["invited", "active", "paused"];
  return (Array.isArray(assignments) ? assignments : []).some(
    a =>
      a &&
      str(a.coach_id) === cid &&
      str(a.athlete_id) === aid &&
      LIVE.includes(str(a.status))
  );
}

/*
 * Validate a proposed assignment before it is created. Returns
 * { ok, reason }. Enforces the invariants the spec requires at the app layer
 * (the DB migration enforces them again): a coach cannot be assigned to
 * themselves, ids must be present, and no duplicate live pair.
 */
export function validateNewAssignment(assignments, coachId, athleteId) {
  const cid = str(coachId);
  const aid = str(athleteId);
  if (!cid || !aid) return { ok: false, reason: "missing_ids" };
  if (cid === aid) return { ok: false, reason: "coach_is_athlete" };
  if (wouldDuplicateLiveAssignment(assignments, coachId, athleteId)) {
    return { ok: false, reason: "duplicate_active_assignment" };
  }
  return { ok: true, reason: null };
}

export const COACH_ASSIGNMENTS_VERSION = "coach-assignments-v1";
