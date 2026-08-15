/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach roles   ·   authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The single place role logic lives. Roles are SERVER-AUTHORITATIVE: they are
 *  read from profiles.role (loaded via the service role in the API) and checked
 *  here. The browser UI is never the security boundary — the API re-derives the
 *  role on every request from the authenticated user's own profile row.
 *
 *  Roles: athlete (default) · coach · admin.
 */

export const ROLES = ["athlete", "coach", "admin"];
export const DEFAULT_ROLE = "athlete";

/*
 * Resolve a role from a profile row. Unknown / missing / malformed values
 * collapse to the least-privileged role. A role is NEVER inferred from email.
 */
export function resolveRole(profileRow) {
  const raw = profileRow && profileRow.role;
  const role = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return ROLES.includes(role) ? role : DEFAULT_ROLE;
}

export function isCoach(profileRow) {
  return resolveRole(profileRow) === "coach";
}
export function isAdmin(profileRow) {
  return resolveRole(profileRow) === "admin";
}

/*
 * Can this user open the coach dashboard? Coaches and admins only. Athletes —
 * the default — are always denied. This is what the API gate and the client
 * route guard both consult (the client only for UX; the API for security).
 */
export function canAccessCoachDashboard(profileRow) {
  const role = resolveRole(profileRow);
  return role === "coach" || role === "admin";
}

/*
 * Can this user MANAGE assignments/roles (create/end assignments, promote)?
 * Admins only in this sprint. Coaches manage athletes they are assigned, but
 * cannot create assignments themselves.
 */
export function canManageAssignments(profileRow) {
  return resolveRole(profileRow) === "admin";
}

/*
 * Narrow invitation permission. A coach/admin may manage only invite rows
 * scoped to their own authenticated id; this does not grant assignment-write
 * authority and must never be reused as canManageAssignments().
 */
export function canManageOwnCoachInvites(profileRow) {
  return canAccessCoachDashboard(profileRow);
}

export const COACH_ROLES_VERSION = "coach-roles-v1";
