/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Plan authority   ·   authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The rules that decide who may write a training session and how an
 *  AI/athlete-originated change is treated. Used by the plan-write endpoints
 *  (generate-plan, weekly-analysis, coach-action apply) so a human coach's plan
 *  can never be silently overwritten.
 *
 *  Ownership / source categories:
 *    · athlete_ai   — generated/adjusted by Athlevo AI (today's default)
 *    · human_coach  — authored by the assigned human coach (authoritative when
 *                     the athlete is human_coached)
 *    · athlete      — created by the athlete themselves
 *    · system       — system/default rows
 */

export const OWNER_TYPES = ["athlete_ai", "human_coach", "athlete", "system"];

function str(v) { return v == null ? "" : String(v); }

// Resolve a session's owner_type, tolerating older rows that only carry
// `source`. Unknown → athlete_ai (the historical default), never human_coach
// (so we never fabricate coach authority).
export function sessionOwnerType(session) {
  const s = session || {};
  const owner = str(s.owner_type).toLowerCase();
  if (OWNER_TYPES.includes(owner)) return owner;
  const source = str(s.source).toLowerCase();
  if (source === "human_coach" || source === "coach") return "human_coach";
  if (source === "athlete") return "athlete";
  if (source === "system") return "system";
  return "athlete_ai";
}

export function isCoachOwned(session) {
  return sessionOwnerType(session) === "human_coach";
}

/*
 * Can the AI (or an athlete-triggered AI action) DIRECTLY write/overwrite this
 * session right now?
 *   · self_guided  → always yes (unchanged behaviour)
 *   · human_coached→ only when the target session is NOT coach-owned; a
 *     coach-owned session is authoritative and must not be overwritten.
 */
export function canAIDirectlyWriteSession(mode, session) {
  if (mode !== "human_coached") return true;
  return !isCoachOwned(session);
}

/*
 * Given the whole set of sessions an AI write would touch, return the ones that
 * are coach-owned (i.e. the writes that must become proposals instead).
 */
export function coachOwnedTargets(mode, sessions) {
  if (mode !== "human_coached") return [];
  return (Array.isArray(sessions) ? sessions : []).filter(isCoachOwned);
}

/*
 * How an incoming change should be treated for a human_coached athlete.
 *   origin: "ai" | "athlete"
 * Returns "direct" (self_guided, apply now) | "ai_proposal" | "athlete_request".
 */
export function classifyWriteIntent(mode, origin) {
  if (mode !== "human_coached") return "direct";
  return origin === "athlete" ? "athlete_request" : "ai_proposal";
}

/*
 * Decide whether a plan-write request is allowed to apply directly, or must be
 * converted to a proposal/request. `sessions` = the sessions the write targets
 * (each may carry owner_type/source). Pure — the endpoint supplies loaded data.
 */
export function evaluatePlanWrite({ mode, origin, sessions }) {
  if (mode !== "human_coached") {
    return { allowed: true, intent: "direct", coachOwned: [], reason: null };
  }
  const coachOwned = coachOwnedTargets(mode, sessions);
  const intent = classifyWriteIntent(mode, origin);
  if (coachOwned.length > 0) {
    return {
      allowed: false,
      intent,
      coachOwned,
      reason: origin === "athlete" ? "athlete_request_required" : "coach_approval_required"
    };
  }
  // Human-coached, but none of the targets are coach-owned (e.g. a not-yet
  // adopted AI plan): the write may proceed but is recorded as athlete_ai.
  return { allowed: true, intent: "direct", coachOwned: [], reason: null };
}

/*
 * SERVER-AUTHORITATIVE ownership stamp for a session about to be written. The
 * client can NEVER set owner_type/source directly — this ignores any
 * client-supplied ownership and derives it from the authenticated actor + mode.
 */
export function stampOwnership({ mode, actorRole, actorId }) {
  let owner_type = "athlete_ai";
  if (actorRole === "coach" || actorRole === "admin") owner_type = "human_coach";
  else if (mode === "human_coached" && actorRole === "athlete") owner_type = "athlete";
  return {
    owner_type,
    source: owner_type === "human_coach" ? "human_coach" : "ai_generated",
    updated_by: actorId || null,
    requires_coach_approval: owner_type === "human_coach"
  };
}

// Strip any client-supplied ownership/authority fields from an inbound payload
// so they can never override server authorization.
export function stripClientAuthorityFields(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = Array.isArray(payload) ? payload.slice() : { ...payload };
  ["owner_type", "source", "created_by", "updated_by", "requires_coach_approval", "coach_id", "role"]
    .forEach(k => { if (k in clone) delete clone[k]; });
  return clone;
}

/*
 * Authorship label for Today/Train. Coaching language; never medical. Returns
 * one of the sanctioned labels.
 */
export function authorshipLabel(session, coachName, opts) {
  const o = opts || {};
  const owner = sessionOwnerType(session);
  const coach = coachName || "your coach";
  if (o.pendingProposal) return "Suggested by Athlevo — pending coach approval";
  if (o.awaitingReview) return "Awaiting coach review";
  if (owner === "human_coach") {
    return session && session.updated_by && o.recentlyUpdated
      ? `Updated by ${coach}`
      : `Prescribed by ${coach}`;
  }
  return null; // self-guided / AI sessions carry no coach-authorship label
}

export const PLAN_AUTHORITY_VERSION = "plan-authority-v1";
