# Managed Athlete Experience — Implementation Plan

**Status:** Plan only. No code changes. No commits.
**Date:** 2026-08-14

---

## 1. CURRENT-STATE PROBLEMS

### P1 — Critical: Coach tab replacement targets wrong element

`athleteMode.js` `renderCoachTab()` writes to `document.getElementById("screen-coach")`. **This element does not exist.** The actual AI coach screen is `id="screen-coachai"`. The bottom nav Coach tab points to `data-screen="screen-coachai"`. Result: `renderCoachTab()` silently no-ops. Managed athletes see the full AI Coach chat screen — the exact problem described.

### P2 — No athlete-side messaging UI exists

The human coach messaging system (`coach_messages` table, `coachMessaging.js`, `actionCoachingDashboardMessages`) is exclusively coach-dashboard-facing. There is no athlete-side endpoint to read or send messages to the assigned coach. The athlete has no way to message their coach from within the app.

### P3 — Coach Memory section always visible

`screen-you` has a hardcoded "Coach memory — What I know about you" section (line 4574 of `index.html`). This renders for all athletes regardless of coaching mode. For managed athletes this implies the AI coach is still learning about them, which is conceptually confusing when a human coach owns the relationship.

### P4 — Daily Brief has no mode awareness

`dailyBrief.js` calls `/api/daily-brief` unconditionally. It never checks `AthlevoAthleteMode`. The daily brief contains AI-generated coaching observations and recommendations ("Coach's note") that can directly conflict with a human coach's programming. No server-side guard exists either — the `/api/daily-brief` endpoint doesn't check coaching mode.

### P5 — AI Coach conversation accessible for managed athletes

`go()` handles `screen-coachai` by calling `renderConversationHistory()` — no coaching-mode check. A managed athlete tapping the Coach tab gets the full AI conversation UI. `coach.js` `askCoach()` has no mode gate — managed athletes can chat with the AI coach, generating potentially conflicting advice.

### P6 — Coach action proposals can conflict

`coach.js` `applyCoachAction()` POSTs `intent: "apply_coach_action"` to the plan endpoint. The server-side `guardPlanWrite` blocks writes to coach-owned sessions, but AI-generated sessions are not protected. A managed athlete could receive AI action proposals and apply them to AI-generated days even while a human coach is managing the rest of their plan.

### P7 — No assignment lifecycle handling on the client

`athleteMode.js` fetches mode once at boot and caches it. If an assignment is created or revoked mid-session, the athlete's UI doesn't update. `clearOnLogout()` resets state but there's no assignment change subscription.

---

## 2. AUTHORITATIVE ASSIGNMENT SOURCE

**Server-authoritative chain:**

1. **Table:** `coach_athlete_assignments` — columns: `id`, `coach_id`, `athlete_id`, `status`, `permission_level`, `assigned_at`, `created_at`
2. **Status enum:** `invited` → `active` → `paused` → `ended`. Only `active` grants managed mode.
3. **Resolution:** `lib/server/coachingMode.js` → `resolveCoachingMode(assignments, athleteId)`
   - No active rows → `{ mode: "self_guided" }`
   - One or more active rows → `{ mode: "human_coached", coachId, assignment, ambiguous }`
   - Multiple active coaches → `ambiguous: true`, primary = earliest `assigned_at`
4. **API endpoint:** `GET /api/providers?action=athlete_coaching_mode` — authenticates via JWT, queries assignments with service role, returns `{ coaching_mode, coach, transition, ambiguous }`
5. **Client consumer:** `js/athleteMode.js` `fetchMode()` — calls the endpoint, sets `_mode` to `self_guided`, `human_coached`, or `unknown`

**Fail-safe design:** `managedPlan.js` `guardPlanWrite` defaults to `human_coached` (blocks writes) if assignment lookup fails. `athleteMode.js` defaults to `unknown` (hides both AI and coach identity) if the server call fails.

**No additional flags needed.** The infrastructure is correct and well-designed. The bugs are purely in the client UI layer.

---

## 3. RECOMMENDED STATE MODEL

Use the existing model. No new state concept needed.

```
coachingMode = "self_guided" | "human_coached" | "unknown"
```

Derived from `AthlevoAthleteMode.mode()` which is sourced from `resolveCoachingMode()` on the server.

**Do not confuse with:**
- `coachMode.js` workspace: `coach_workspace` vs `athlete_workspace` (for users with role=coach/admin)
- `profiles.role`: `athlete`, `coach`, `admin` (who the user IS, not how they're coached)
- `permission_level`: `read` vs `read_write` (coach's write access to athlete, not athlete's mode)

---

## 4. EXACT SCREENS/COMPONENTS TO CHANGE

| Screen/Component | Current State | Change for `human_coached` |
|---|---|---|
| **Bottom nav Coach tab** (`#tabbar`, `data-screen="screen-coachai"`) | Always points to AI chat | Re-target to `screen-coachai` but with messaging content; or swap `data-screen` to a new `screen-coach-thread` |
| **`screen-coachai`** (AI Coach chat) | Always renders AI chat UI | Replace inner content with human coach messaging thread |
| **Coach Memory section** (`div.memory` in `screen-you`) | Always visible | Hide when `human_coached` |
| **Assigned Coach card** (`am-assigned-coach` in `screen-you`) | Injected by `athleteMode.js` | Keep (it's already correct), but remove the memory section above it |
| **Daily Brief** (`#dailyBriefCard` area in `screen-today`) | AI coach observations render unconditionally | Hide AI coaching copy (observation, recommendation, coaching note) when `human_coached` |
| **Coach's Note** (`#todayCoachNote` in `screen-today`) | AI-generated note | Hide when `human_coached` |
| **Coach starter prompts** (`.coach-starter` buttons in `screen-coachai`) | AI conversation starters | Hidden/replaced by messaging UI |
| **AI action proposal chips** (`#chips` in `screen-coachai`) | AI suggestions | Hidden/replaced by messaging UI |

---

## 5. FILES INVOLVED

### Client-side (changes required):

| File | Changes |
|---|---|
| `js/athleteMode.js` | **Fix `renderCoachTab()` target** from `screen-coach` → `screen-coachai`. Add coach messaging renderer. Add memory section hide/show. Add daily brief suppression. |
| `js/coach.js` | Add early return in `askCoach()` and `renderConversationHistory()` when `AthlevoAthleteMode.isManaged()` |
| `js/dailyBrief.js` | Check `AthlevoAthleteMode.isManaged()` before rendering AI coaching copy |
| `index.html` | Add `id` or class to memory section for easy hide/show. No structural changes needed. |

### Client-side (may need minor touch):

| File | Why |
|---|---|
| `js/accessGuard.js` | `guardTab()` needs to know managed athletes don't need AI coach paywall — they get messaging instead |
| `js/renderCoachResponse.js` | No changes if AI chat is hidden for managed athletes |
| `js/coachMode.js` | No changes — this is coach-workspace-only |

### Server-side (new endpoint required):

| File | Changes |
|---|---|
| `api/providers/index.js` | Add `athlete_messages` action — athlete-facing read/send for their assigned coach thread. Re-uses `loadCoachMessageThread()` and `buildCoachThread()` from `lib/server/coachMessaging.js` |
| `lib/server/coachMessaging.js` | Already handles thread building; add `validateAthleteMessage()` if message validation differs for athlete sender |
| `api/daily-brief.js` | Add coaching mode check — return neutral/reduced brief for managed athletes (no AI coaching recommendations) |

### Server-side (no changes needed):

- `lib/server/coachingMode.js` — correct as-is
- `lib/server/coachAssignments.js` — correct as-is
- `lib/server/planAuthority.js` — correct as-is
- `lib/server/managedPlan.js` — correct as-is
- `lib/server/coachRoles.js` — correct as-is

---

## 6. BOTTOM NAV BEHAVIOR

### Current athlete nav (hardcoded in `index.html`, restored by `coachMode.js`):

```
Today  |  Coach  |  Train  |  Trends  |  You
         ↓
    screen-coachai (AI Chat)
```

### AI Athlete (no change):

```
Today  |  Coach  |  Train  |  Trends  |  You
         ↓
    screen-coachai → AI Coach conversation
```

### Human-Coached Athlete:

```
Today  |  Coach  |  Train  |  Trends  |  You
         ↓
    screen-coachai → Human coach messaging thread
```

**Recommended label: "Coach"** (not "Messages"). Rationale: the athlete has a coach, the tab represents that relationship. "Messages" implies a generic inbox. "Coach" is already the label. The content changes, not the label.

**Implementation:** `athleteMode.js` `renderCoachTab()` already intends to replace the Coach tab content. The fix is changing the target from `#screen-coach` (nonexistent) to `#screen-coachai` (actual). The entire `screen-coachai` inner HTML gets replaced with a messaging UI when `human_coached`.

**Do not add a sixth tab or rearrange tab order.**

---

## 7. AI SURFACES TO SUPPRESS (for `human_coached` athletes)

| Surface | Location | Action |
|---|---|---|
| AI Coach conversation UI | `screen-coachai` inner HTML | Replace with human coach messaging thread |
| AI Coach starter prompts | `.coach-starter` buttons in `screen-coachai` | Replaced by messaging UI |
| AI suggestion chips | `#chips` in `screen-coachai` | Replaced by messaging UI |
| AI Coach action proposals | Rendered by `renderCoachResponse.js` | Not rendered (chat is replaced) |
| Coach Memory section | `div.memory` in `screen-you` | Hide (`display:none`) |
| Daily Brief coaching advice | `#dailyBriefObservation`, `#dailyBriefRecommendation` | Hide or replace with "Your coach manages your training" |
| Coach's Note on Today | `#todayCoachNote` | Hide |
| `askCoach()` function | `js/coach.js` | Early return if `isManaged()` |

### AI surfaces to PRESERVE (not suppress):

| Surface | Reason |
|---|---|
| Plan generation backend | Human coach may use AI to generate plans via coach dashboard |
| `planAuthority.js` / `managedPlan.js` | These protect coach-owned content — essential |
| `coachBrain.js` insights engine | Data-only module, never renders to athlete directly |
| `athleteEngine.js` | Infrastructure, not coaching advice |
| Training load / readiness calculations | Factual metrics, not coaching opinions |

---

## 8. YOU / PROFILE CHANGES

### Current state:
- "Coach memory — What I know about you" section: always visible, hardcoded in `index.html` at line 4574
- `am-assigned-coach` card: injected by `athleteMode.js` when `human_coached` — shows coach avatar/initials, name, title

### Problem:
For managed athletes, both appear. The memory section implies an active AI coach relationship. The assigned coach card is correct but sits below the confusing memory section.

### Recommendation:

**For `human_coached`:**
- Hide the entire `div.memory` section (coach memory)
- Keep `am-assigned-coach` card (it's already well-positioned and useful)
- No additional "Your coach" button or card needed — the Coach tab handles the messaging relationship

**For `self_guided`:**
- Keep memory section as-is
- No `am-assigned-coach` card (already not injected)

**Implementation:** Add `id="coachMemorySection"` to the `div.memory` element. In `athleteMode.js` `init()` for `human_coached`: `document.getElementById("coachMemorySection").style.display = "none"`. In `clearOnLogout()`: restore `display`.

---

## 9. ASSIGNMENT LIFECYCLE

| Scenario | Expected Behavior | Implementation |
|---|---|---|
| **A. No assignment** | AI mode. Full AI coach. Memory visible. | Default behavior, no changes needed. |
| **B. Active assignment** | Human mode. Coach messaging replaces AI chat. Memory hidden. Authorship labels. Train restrictions. | `athleteMode.js` `init()` path when `human_coached` (with bug fix). |
| **C. Assignment revoked/ended** | AI mode restored on next boot or mode re-fetch. | `clearOnLogout()` clears all managed UI. Next `init()` will get `self_guided` from server. |
| **D. Account switching** | No stale mode. | `clearOnLogout()` is already called on logout. `init()` re-fetches on authenticated boot. |
| **E. Multiple historical assignments** | Only `active` counts. `ended`/`paused`/`invited` are ignored by `resolveCoachingMode()`. | Already handled server-side. |
| **F. Multiple active assignments** | `resolveCoachingMode()` picks earliest `assigned_at`, flags `ambiguous: true`. Client uses primary coach. | Already handled. Consider logging `ambiguous` for ops visibility. |

### Mid-session assignment change:
Currently not handled. The mode is fetched once at boot and cached. Options:

1. **Recommended (minimal):** Re-fetch mode when the Coach tab is tapped. If mode changed, re-render. Low complexity, covers the most important moment.
2. **Optional (future):** Supabase realtime subscription on `coach_athlete_assignments` filtered to the athlete's ID. Higher complexity, real-time updates.

---

## 10. LOADING / FLICKER RISKS

### Current boot sequence:
1. Auth resolves → authenticated routing runs
2. `AthlevoCoachDashboard.init()` (no-op for athletes)
3. `AthlevoAthleteMode.init()` — async, fires `fetchMode()` which is a network call

### Problem:
`AthlevoAthleteMode.init()` is called without `await`. It runs asynchronously after the authenticated routing has already shown screens. The AI coach screen is already in the DOM. If the athlete navigates to the Coach tab before `fetchMode()` resolves, they see the AI chat briefly.

### Recommendations:

1. **Cache last-known mode in `localStorage`:** On confirmed mode, write `{ mode, coach, ts }` to `localStorage.athlevo_coaching_mode`. On next boot, read this cache immediately and apply the UI before `fetchMode()`. Then `fetchMode()` validates/updates. This eliminates flash for returning users.

2. **Bottom nav defers Coach tab content:** Don't render AI chat or messaging until the mode is confirmed. Show a neutral loading state (coach avatar skeleton or spinner) for the 200-400ms while `fetchMode()` runs.

3. **`go()` function gate:** When `screen-coachai` is navigated to and mode is `unknown` (still loading), show a brief "Loading…" state rather than the AI chat. Once mode resolves, render the correct content.

4. **Do NOT block the entire app boot on mode resolution.** Today/Train/Trends/You should load immediately. Only the Coach tab content and AI-sensitive elements need to wait.

---

## 11. SECURITY CONSIDERATIONS

### Already solid:
- JWT-authenticated mode resolution
- Server-authoritative assignment validation
- `planAuthority.js` blocks AI overwrites of coach-owned sessions
- `managedPlan.js` fails safe (defaults to blocked)
- `stripClientAuthorityFields()` removes authority fields from client payloads
- RLS on `coach_athlete_assignments` (implied by service-role-only queries)

### New concerns for athlete messaging:

1. **New `athlete_messages` endpoint must validate:**
   - Athlete has a valid JWT
   - Athlete has an `active` assignment
   - Messages are scoped to the athlete's own `coach_id` from the resolved assignment
   - Athlete cannot read/send to any coach they're not assigned to
   - `sender_role` is always server-stamped as `"athlete"` (never trusted from client)

2. **Message body sanitization:**
   - Re-use `validateCoachMessage()` from `coachMessaging.js`
   - Same 4000 char limit, same sanitization

3. **No cross-athlete leakage:**
   - Thread lookup: `coach_messages WHERE coach_id = {resolved.coachId} AND athlete_id = {authenticated_user_id}`
   - Athlete can never specify a different `athlete_id`

4. **Local spoofing prevention:**
   - Athlete cannot spoof `human_coached` mode locally — the mode only controls UI rendering
   - All authority checks (plan writes, messaging, adjustments) re-resolve mode server-side per request
   - Even if an athlete forces the messaging UI to appear, the `athlete_messages` endpoint validates the assignment independently

---

## 12. IMPLEMENTATION SEQUENCE

### Phase 1: Fix the critical bug (1 file, ~5 lines)

1. **`js/athleteMode.js`** — Change `renderCoachTab()` target from `"screen-coach"` to `"screen-coachai"`. This immediately makes the existing human-coach info panel render correctly for managed athletes, replacing the AI chat.

**Validates:** Managed athlete Coach tab shows coach identity instead of AI chat.

### Phase 2: Suppress AI surfaces (3 files, ~30 lines)

2. **`js/coach.js`** — Add mode check at top of `askCoach()`:
   ```js
   if (window.AthlevoAthleteMode && window.AthlevoAthleteMode.isManaged()) {
     return;  // AI coach disabled for managed athletes
   }
   ```
   Same for `renderConversationHistory()`.

3. **`js/dailyBrief.js`** — In `renderDailyBrief()`, check `AthlevoAthleteMode.isManaged()`. If true, hide AI coaching observations/recommendations. Keep factual training summary if it doesn't contain coaching advice.

4. **`index.html`** — Add `id="coachMemorySection"` to the memory `div` at line 4574.

5. **`js/athleteMode.js`** — In the `human_coached` path of `init()`, add:
   ```js
   var mem = document.getElementById("coachMemorySection");
   if (mem) mem.style.display = "none";
   ```
   In `clearOnLogout()`:
   ```js
   var mem = document.getElementById("coachMemorySection");
   if (mem) mem.style.display = "";
   ```

**Validates:** No AI coaching surfaces visible for managed athletes.

### Phase 3: Athlete messaging (1 server file, 1 client file, ~150 lines)

6. **`api/providers/index.js`** — Add `athlete_messages` action:
   - GET: authenticate athlete, resolve coaching mode, if `human_coached` load thread via `loadCoachMessageThread(resolved.coachId, userId, canSend=true)`, return thread
   - POST: authenticate, resolve mode, validate `human_coached`, validate message body, insert with `sender_role: "athlete"`, `sender_user_id: userId`, return updated thread

7. **`js/athleteMode.js`** — Rewrite `renderCoachTab()` to render a full messaging UI instead of a static info panel:
   - Coach identity header (initials, name, title)
   - Message thread (scrollable, loaded from `athlete_messages` endpoint)
   - Composer (textarea + send button)
   - Empty state: "Send your first message to {coach name}"
   - Send function: POST to `athlete_messages`, re-render thread

**Validates:** Managed athlete can view and send messages to assigned coach.

### Phase 4: Loading / flicker prevention (~20 lines)

8. **`js/athleteMode.js`** — Add localStorage cache of confirmed mode. Read at init before fetch. Apply cached mode immediately for instant render, then validate with server.

9. **`index.html` `go()` function** — When `screen-coachai` is navigated to and `AthlevoAthleteMode.isUnknown()`, show a brief neutral loading state.

**Validates:** No AI flash for managed athletes on cold load.

### Phase 5: Re-fetch on tab tap (optional, ~10 lines)

10. **`index.html` `go()` function** — When Coach tab tapped and mode was last confirmed >5 minutes ago, trigger `AthlevoAthleteMode.fetchMode(true)` and re-render if mode changed.

---

## 13. TESTS

### Unit / integration tests to add:

**Mode resolution:**
- Self-guided athlete: `fetchMode()` → `self_guided`, AI chat renders, no coach card
- Managed athlete: `fetchMode()` → `human_coached`, messaging renders, no AI chat
- Unknown mode: `fetchMode()` fails → `unknown`, neutral state, retry available
- Assignment removed: `fetchMode()` on re-check → `self_guided`, AI chat restored

**Bottom nav:**
- AI athlete: Coach tab → `screen-coachai` shows AI chat
- Human athlete: Coach tab → `screen-coachai` shows coach messaging thread
- Tab label stays "Coach" in both modes

**AI suppression:**
- `askCoach()` returns early when `isManaged()`
- `renderConversationHistory()` returns early when `isManaged()`
- Daily brief hides coaching observations when `isManaged()`
- Coach's Note hidden when `isManaged()`
- Coach Memory section hidden when `isManaged()`

**Messaging:**
- Managed athlete with no messages → empty state with composer
- Managed athlete with existing messages → thread renders, newest at bottom
- Managed athlete sends message → appears in thread, `sender_role: "athlete"`
- Self-guided athlete → messaging endpoint returns 400 (no active assignment)
- Athlete tries messaging a different coach → 403

**You section:**
- Self-guided: Coach Memory visible, no assigned coach card
- Managed: Coach Memory hidden, assigned coach card visible
- After logout: all managed UI cleared

**Today/Train:**
- Authorship labels appear for coach-owned sessions
- Edit/modify/skip disabled on coach-owned sessions
- Request Adjustment button available on coach-owned sessions
- Non-coach-owned sessions remain editable

**Security:**
- `athlete_messages` endpoint rejects unauthenticated requests
- `athlete_messages` endpoint rejects `self_guided` athletes
- Athlete can only read their own thread (not other athletes')
- `sender_role` is server-stamped, never client-supplied
- Message body validated (≤4000 chars, sanitized)

**Lifecycle:**
- Assignment created mid-session → next Coach tab tap re-fetches and shows messaging
- Assignment revoked → next boot shows AI coach
- Account switch → clean state, no stale coach identity
- Ambiguous (multiple coaches) → primary coach used, no error

**Loading:**
- Cold load for managed athlete → no AI chat flash
- Cached mode → instant render, server validates
- Coach tab tapped before mode resolves → loading state, not AI chat

**Reduced motion / accessibility:**
- Screen transitions respect `prefers-reduced-motion`
- Messaging thread accessible via keyboard
- Coach identity header has appropriate ARIA labels
