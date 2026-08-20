# Coach Mode Sprint Report

## 1. Existing Shell Conflicts Found
- The existing `screen-coachmode` section in `index.html` (line ~4542) is a hardcoded mockup with fake athlete data (RJ Gomez, Herma Joy, Carlo Panton). It was already `hidden` with `display:none` and no athlete entry point. **No conflict** — the new Coach Mode uses entirely separate screen IDs (`screen-coach-today`, `screen-coach-messaging`, `screen-coach-train`, `screen-coach-trends`, `screen-coach-you`).
- The existing `AthlevoCoachDashboard` (`js/coachDashboard.js`) uses `#coach` hash routing and renders into `screen-coach`. The new Coach Mode does **not** reuse `#coach` — it intercepts at the auth flow level before any hash routing. Both can coexist; the old dashboard remains functional as a fallback entry from the You tab.

## 2. Coach Mode Resolution
- **Three states**: `athlete_mode`, `coach_mode`, `unknown`
- Resolution reuses the existing `coaching_dashboard_roster` server endpoint — no new Vercel function
- Server returns `role` in the roster response; `coach`/`admin` → `coach_mode`, `403` → `athlete_mode`, any error → `unknown` with retry
- Role is never inferred from email; unknown is never cached as confirmed
- Client-side spoofing cannot activate Coach Mode (non-standard role strings resolve to `athlete`)

## 3. Navigation Behavior
- For `coach`/`admin` users, the bottom tab bar is **rewritten** to five coach-specific screens
- Tab labels remain: Today, Coach, Train, Trends, You
- Tab icons reuse existing SVGs
- Each tab routes to `screen-coach-*` sections
- Athlete users are completely unaffected — the rewrite only runs after server-confirmed coach role
- The intercept is at the post-auth initialization; if `isCoachMode()` returns true, the entire athlete data flow (refreshAthleteUI, daily brief, weekly plan) is skipped

## 4. Coach Today Sections
- **Header**: "Good morning/afternoon/evening, Coach {firstName}" + attention count
- **Summary cards**: Active athletes, Needs attention, Training today, Completed today, No recent data
- **Needs attention**: Athletes with `needs_attention` status, showing severity, categorical reasons, View athlete + Mark reviewed buttons
- **Monitor**: Athletes with `monitor` status
- **Training today**: Athletes with a planned session today, showing sport-aware title/duration/distance
- **Recent activity**: Latest completed activities across roster, sport-aware summaries, newest first
- **Upcoming events**: Athletes with `target_event` from their profile
- **Roster status**: Full roster with search, showing all metrics per athlete

## 5. Attention Behavior
- Reuses the existing deterministic `classifyAttention()` from `lib/server/attentionClassifier.js`
- Each attention item shows: athlete name, initials, severity badge, categorical reason, View athlete, Mark reviewed
- Reasons include: pain_reported, illness_reported, very_low_readiness, low_recovery, missed sessions, no_recent_activity, provider_sync_failed, event_approaching, etc.
- Sort: high severity → medium → low → none
- Mark reviewed calls `coaching_dashboard_review` via existing API — does not erase the underlying condition

## 6. Training Today Behavior
- Shows athletes whose `today_planned` is non-null
- Each card: athlete name/initials, sport label, workout title, duration/distance where available, readiness status
- Sport-aware units: run (distance, pace), ride (duration, distance, power), strength (duration), generic fallback
- Missing metrics show "—", never fabricated

## 7. Recent Activity Behavior
- Pulls `latest_activity` from each roster entry
- Sorted newest first, limited to 10
- Each entry: athlete name, sport-aware summary (sport · duration · distance), date/time
- No raw provider payloads, tokens, or emails in output

## 8. Roster Behavior
- Full athlete list sorted by operational priority (needs_attention → monitor → no_recent_data → on_track)
- Each card: initials/avatar, name, status badge, sport, goal, today's session, readiness, recovery, 7d load, adherence, last active
- Search by athlete name (client-side filter)
- Clicking opens the athlete detail drawer

## 9. Placeholder Tabs
- **Coach (Messaging)**: Athlete list with "No messages yet" placeholders. Clicking an athlete shows "Human coach messaging will appear here." — clearly not the AI Coach conversation.
- **Train**: Roster with status, goal, today's workout, adherence, last activity. Clicking opens athlete drawer. "Coming soon" placeholder for Calendar, Plan, Activities, Feedback.
- **Trends**: Athlete selector dropdown. After selection, shows readiness, recovery, 7d load, adherence cards with "Detailed coach trends are coming next" placeholder.
- **You**: Coach name, role, active athlete count, capacity placeholder, pending invitations placeholder, offers placeholder, settings links, support, logout.

## 10. Privacy and Analytics
**Events added** (all categorical only):
- `coach_mode_resolved` — `{coach_mode}`
- `coach_today_viewed` — `{coach_mode, source_surface, roster_size_band}`
- `coach_today_attention_opened` — `{coach_mode, source_surface, attention_reason, attention_severity}`
- `coach_today_athlete_opened` — `{coach_mode, source_surface}`
- `coach_tab_viewed` — `{coach_mode, source_surface, tab_name}`
- `coach_train_viewed`, `coach_trends_viewed`, `coach_you_viewed` — same shape

**Never sent**: athlete name, coach name, email, UUID, workout title, message text, pain notes, readiness values, health metrics, activity metrics, provider IDs, raw errors

**Safe props added** to `SAFE_PROPS` allowlist: `coach_mode`, `dashboard_surface`, `attention_reason`, `attention_severity`, `athlete_sport`, `roster_size_band`, `tab_name`

**Approved values added** to `APPROVED_HANDOFF_VALUES` for each new prop with explicit categorical allowlists

## 11. Files Changed
| File | Change |
|------|--------|
| `js/coachMode.js` | **NEW** — Coach Mode shell, navigation, Today, placeholder tabs |
| `js/analytics.js` | Added coaching SAFE_PROPS + APPROVED_HANDOFF_VALUES |
| `js/analyticsRegistry.js` | Added 8 coach mode events |
| `index.html` | Added `<script>` tag + Coach Mode intercept in auth flow |
| `dist/js/coachMode.js` | Synced from source |
| `dist/js/analytics.js` | Synced from source |
| `dist/js/analyticsRegistry.js` | Synced from source |
| `dist/index.html` | Synced from source |
| `ios/App/App/public/js/coachMode.js` | Synced from source |
| `ios/App/App/public/js/analytics.js` | Synced from source |
| `ios/App/App/public/js/analyticsRegistry.js` | Synced from source |
| `ios/App/App/public/index.html` | Synced from source |
| `tests/coach-mode.test.mjs` | **NEW** — 54 tests |

**No new Vercel functions created. No server-side files modified. No SQL applied.**

## 12. Tests and Failures
**New tests**: 54 tests in `tests/coach-mode.test.mjs` — **all 54 pass**

**Existing test results** (120 total across all suites):
- **113 pass**, 7 fail
- All 7 failures are **pre-existing** (not introduced by this sprint):
  - `consistency-pass` — raw radius literals in landing page mockup CSS
  - `layout-system` — pre-existing gap/shadow/radius literals
  - `oauth-persistence` — token field allowlist issue
  - `paywall` — CTA label mismatch
  - `training-data-ux` — connection blocking + direction button count
  - `typography` — font-size micro-cluster literals
  - `ux-polish` — build call + ownership guard issue

**Key targeted suites — all pass**:
- `coach-dashboard.test.mjs` ✓
- `managed-athlete.test.mjs` ✓
- `security-isolation.test.mjs` ✓
- `routing.test.mjs` ✓
- `posthog-analytics.test.mjs` ✓
- `sport-classification.test.mjs` ✓
- `coach-limit.test.mjs` ✓
- `vercel-function-count.test.mjs` ✓ (12/12)

## 13. Remaining Gaps
1. **Messaging**: Coach tab is placeholder only — no message storage, sending, or display
2. **Calendar editing**: Train tab shows roster but no calendar or plan editing
3. **Detailed trends**: Trends tab shows summary metrics but no time-series charts
4. **Revenue/payments**: You tab has no revenue, offers, or payment data
5. **Upcoming events dates**: The `profiles.target_race` field stores a text string, not a date — events display but "days remaining" cannot be computed from the current schema
6. **Refresh**: Coach Today doesn't auto-refresh; requires tab re-entry to reload
7. **Hash routing**: Coach Mode doesn't use hash-based routing for individual screens (tabs switch via JS only)
8. **The old `screen-coachmode` mockup**: Still present in HTML (hidden) — could be removed in a future cleanup

## 14. Whether Safe to Commit
**Yes — safe to commit.** The sprint:
- Creates no new Vercel functions (stays at 12/12)
- Modifies no server-side code
- Applies no SQL migrations
- Does not affect athlete users (Coach Mode activates only after server-confirmed coach/admin role)
- All targeted tests pass
- All pre-existing failures are unchanged
- Syntax checks pass
- No `git diff --check` issues

## 15. Recommended Next Sprint
1. **Coach messaging** — real message storage (Supabase table), send/receive, unread badges
2. **Calendar editing** — read/write training sessions for assigned athletes
3. **Detailed trends** — time-series readiness, load, adherence charts per athlete
4. **Event date field** — add `target_event_date` column to profiles for "days until" computation
5. **Athlete overview deep-link** — hash routing for individual athlete views within coach screens
6. **Push notifications** — alert coaches when athletes report pain or miss key sessions
7. **Coach onboarding** — first-time coach setup flow
