# Athlevo — Multi-Sport Activity Classification Foundation (Sprint Report)

**Date:** 2026-08-01
**Scope:** Cycling as the first expansion beyond running. Foundation only — not a full cycling training system.
**Status:** Implemented, reviewed, and tested. **Not committed / pushed / deployed. No SQL applied. No historical rows mutated.**

---

## 1. Root cause of sport confusion

There was no authoritative sport field. The wearable normalizer had a coarse `normalizeSport()` returning only `run | ride | swim | walk | other` (no `strength`, `hike`, `mobility`, `cross_training`, `rest`), so weight training, yoga, rowing, etc. all collapsed to `other`. Worse, after normalization the **Strava importer overwrote the canonical sport with the raw provider string** (`sync.js`: `row.sport_type = activity.sport_type; row.activity_type = activity.type`) and the Intervals importer overwrote `activity_type` too. Net effect: stored `sport_type`/`activity_type` were canonical lowercase for Terra but raw CamelCase (`Run`, `VirtualRide`, `WeightTraining`) for Strava/Intervals. Downstream code then guessed sport with `String(...).includes("run")`-style regexes, and several aggregates ignored sport entirely — so cycling/walking distance was summed into running mileage, a ride could "complete" a planned run, and the Coach received a per-km pace for rides.

## 2. Canonical sport model

New authoritative module (server + client mirror): `lib/server/sportClassification.js` and `js/sportClassification.js`.

Canonical top-level sports (exhaustive, 10): `run · ride · strength · swim · walk · hike · mobility · cross_training · rest · other`.

`classifyActivity({provider, providerActivityType, name, trainer})` returns `{ provider, providerActivityType (preserved raw), sport, subtype, indoor, classificationSource, mappingStatus }`. Provider type is the **primary** signal; a keyword heuristic is the fallback; unknown types are preserved and returned as `other` with `mappingStatus: "unmapped"`. `canonicalSportOf(row)` normalizes **on read** for any stored row (handles the provider-naming inconsistency) and never mutates history. Conservative subtypes only where the type justifies them (e.g. `trail_run`, `treadmill_run`, `indoor_ride`, `mountain_bike`).

## 3. Provider mappings

One table drives all providers. Examples: Strava/Intervals `Run/TrailRun/VirtualRun/Treadmill → run` (virtual/treadmill → indoor); `Ride/VirtualRide/MountainBikeRide/GravelRide/EBikeRide/IndoorCycling → ride` (virtual/indoor → indoor); `WeightTraining/StrengthTraining/Workout/Crossfit → strength`; `Swim → swim`; `Walk → walk`; `Hike → hike`; `Yoga/Pilates/Mobility → mobility`; `Rowing/Elliptical/StairStepper → cross_training`; unknown → `other` (raw preserved, logged categorically). The three mappers (`mapStrava`, `mapTerra`, `mapIntervals`) now call `applyClassification()` so every imported workout carries canonical `sport/subtype/indoor` plus provenance, and `toActivityRow` persists `raw_data.classification` and `raw_data.data_quality` (additive JSON — **no schema change**).

## 4. Run-metric fixes

- `weeklyAnalysis.isRunActivity()` now reads the canonical sport (rides/strength correctly excluded, even a ride titled "Threshold").
- `weeklyAnalysis.summarizeActivityTotals()` — `distanceKm` is now **run-only** running mileage; `rideDistanceKm` / `totalDistanceKm` added alongside.
- `brain.buildActivitySummary()` — `sevenDayDistanceKilometers` and `weeklyVolumes[].distanceKilometers` are **run-only**; ride/total companions added.
- `matchPlannedSessions()` — a planned run can only be auto-completed by a same-sport activity; a same-day ride no longer completes it. Adds `planned_sport` and `cross_sport_activity_present`.
- Comparable-run pace (`findComparableRuns`) already filtered `isRunActivity`, now authoritative — cycling speed never enters run pace/Trends.

Cycling distance is never added to running mileage; cycling speed is never treated as running pace; strength duration is never treated as aerobic mileage.

## 5. Cycling fields preserved

For rides the normalizer preserves duration, distance, average speed (derived), avg/max HR, average power, **normalized power** (Strava `weighted_average_watts`, Intervals `icu_weighted_avg_watts`), cadence, elevation, training load, indoor/outdoor, and provider source. Nothing is fabricated — missing power/cadence/load stays `null`. Data-quality flags (`power_available`, `heart_rate_available`, `cadence_available`, `load_available`) report availability only.

## 6. Load separation behavior

`athleteEngine.computeTrainingLoad()` (server + client) preserves total systemic load (`weekly_training_load`) and adds a 7-day per-sport split: `weekly_load_run / weekly_load_ride / weekly_load_strength / weekly_load_other` (+ `weekly_load_by_sport`). Items carry a canonical `sport`; buckets sum to the total. Ride load is never mislabeled as run load; lower-body strength is never counted as running volume. **No new scientific coefficients invented** — the existing session-RPE/intensity-factor model is unchanged; readiness/recovery still use total load (future sport-specific weighting is noted, not implemented).

## 7. Coach context changes

`brain.buildCoachingContext()` now sends per recent activity: explicit canonical `sport`, `subtype`, `indoor`, duration, distance, HR, and — pace **only for runs**; for rides it sends `averageSpeedKph`, `averagePowerWatts`, `averageCadence`, `trainingLoad`, and `dataQuality`. Athlete sport profile (`primarySport`, `secondarySport`, `goalSport`) added. `api/coach.js` system prompt gained a MULTI-SPORT AWARENESS section: a ride is not a run; cycling contributes cardiovascular fatigue but not run-specific impact prep; strength is not aerobic mileage; an easy ride may be recovery; and the truthful limitation — *"Athlevo can already understand and analyze cycling activities, but full cycling-specific plan generation is still being expanded."*

## 8. UI / history changes

`js/trainCalendar.js` history detail is sport-aware: canonical sport label for all 10 sports; **runs** show distance + pace (min/km); **rides** show duration + distance + speed (km/h) + power + cadence (rpm); **strength/mobility** show duration + category (no distance/pace); swim/walk/hike/cross-train show duration-first, never running pace. Existing components/styling reused; labels ≤ 12 chars (no mobile clipping). No interface redesign.

## 9. Onboarding changes

**None implemented** (correct per spec). Audit: onboarding hardcodes `profiles.primary_sport = "Running"` and is running-only, but a `primary_sport` column already exists and classification depends on **provider type, not onboarding**, so no schema change is required for safe classification now. The recommended future athlete-sport schema (secondary/goal sport, FTP, cycling threshold HR, power-meter/trainer availability, weekly riding hours, longest recent ride, preferred ride days, target event type/date) is documented as commented, **non-applied** SQL in the migration file for the future cycling sprint.

## 10. Analytics behavior

Three categorical events registered in `js/analyticsRegistry.js`: `activity_classified`, `activity_type_unmapped`, `sport_filter_viewed`, with only allowed props (`canonical_sport`, `provider`, `classification_source`, `mapping_status`). No distance, power, HR, titles, athlete IDs, tokens, health data, or raw payloads. `api/strava/sync.js` emits privacy-safe categorical **server logs** (aggregated counts by sport / unmapped type) — no PII.

**PostHog vs Supabase (verified):** the three new events are **client-side behavioural events** for the existing analytics registry/PostHog path. They are **not** written to the Supabase `activation_events` table by the application. Therefore the Supabase `CHECK` constraint does **not** need them for the app to function today. The migration `2026-08-01_sport_classification_analytics.sql` is provided **only** so the allow-list stays consistent **if** these names are ever persisted to `activation_events`; it is **not required** for this sprint and is **not applied**.

## 11. Files changed

**New (4):**
- `lib/server/sportClassification.js` — authoritative canonical model + provider map (server)
- `js/sportClassification.js` — client mirror (`window.SportClassification`)
- `tests/sport-classification.test.mjs` — 90-assertion suite
- `migrations/2026-08-01_sport_classification_analytics.sql` — analytics allow-list widening + commented future sport-profile schema (**NOT applied**)

**Modified (10):**
- `lib/server/wearable/normalizer.js` — classify on import; preserve NP + data-quality; store `raw_data.classification`
- `lib/server/weeklyAnalysis.js` — run-only mileage; sport-aware adherence; canonical `isRunActivity`
- `lib/server/athleteEngine.js` — per-item sport; per-sport load split
- `js/athleteEngine.js` — client mirror of the above
- `js/brain.js` — run-only volume; sport-aware Coach context; sport profile
- `js/trainCalendar.js` — sport-aware history units/labels
- `js/analyticsRegistry.js` — 3 categorical events
- `api/coach.js` — multi-sport prompt + truthful limitation
- `api/strava/sync.js` — privacy-safe categorical classification logging
- `index.html` — load `js/sportClassification.js` before `brain.js`

**Excluded from this sprint's commit (pre-existing, unrelated to cycling):** `tests/coach-limit.test.mjs` (modified) and `coach-web-diagnostic-report.md` (untracked) are from an earlier Coach-web-diagnostic session; `cyclist-sprint-wip.patch` is a scratch artifact. None should be staged.

## 12. Tests and failures

- **New suite `tests/sport-classification.test.mjs`: 90 passed, 0 failed** — covers classification, running-metric exclusion, cycling-data preservation, load separation, cross-sport adherence, Coach context, UI units, client/server parity, analytics privacy, and regression.
- **Regression (all pass):** provider-sync-routing (71), provider-log-privacy (14), intervals (59), intervals-response-shape (24), intervals-diagnostics (15), activity-loader (44), analytics (85), acquisition-activation-funnel (18), plan-generation (104), today-direction (88), today-plan-refresh (15), trends-analytics (62), adaptive-plan-v2 (65), adaptive-plan-wiring (57), coach-ui (29), morning-readiness (29), recovery-score (8), training-data-native-ux (47).
- **Pre-existing failures (identical at clean HEAD — NOT regressions):** `consistency-pass` (1), `layout-system` (3), `paywall` (1), `training-data-ux` (2), `typography` (4), `ux-polish` (3) — all design-system/token/CTA-copy checks unrelated to sport.
- **`coach-limit`:** 1 failure — the pre-existing (unrelated) `dist/js/analyticsRegistry.js` **matches** `js/analyticsRegistry.js` assertion. `dist/` is gitignored generated output; it is stale because this sprint edited the source registry. It resolves on the standard, already-documented host step `npm run build:native`. Not a code regression and not in this sprint's commit scope.
- `node --check` passes on all 12 changed/new JS files. `git diff --check` is clean.

## 13. Remaining cycling limitations

No cycling-specific plan generation, no FTP/power-curve/TSS analytics, no cycling training zones, no sport-specific load weighting in readiness/recovery (still total load), and onboarding does not yet capture cycling intent or a goal sport. Power normalization uses provider-supplied weighted/normalized power only (not recomputed from streams). These are intentionally deferred; the Coach truthfully states the limitation.

## 14. Whether safe to commit

**Yes — safe to commit the 14 sprint files.** Changes are additive and backward-compatible: no schema change, no historical-row mutation, run-only users see identical numbers (all their activities are runs), providers still import, plan generation/Today/Trends/Coach all pass. The migration is not applied and is not required for the app to run. The only "failure" touching this diff is the gitignored `dist/` parity check, resolved by the existing pre-deploy build step.

## 15. Exact commit scope if safe

Stage **only** these 14 files:

```
git add \
  lib/server/sportClassification.js \
  js/sportClassification.js \
  lib/server/wearable/normalizer.js \
  lib/server/weeklyAnalysis.js \
  lib/server/athleteEngine.js \
  js/athleteEngine.js \
  js/brain.js \
  js/trainCalendar.js \
  js/analyticsRegistry.js \
  api/coach.js \
  api/strava/sync.js \
  index.html \
  migrations/2026-08-01_sport_classification_analytics.sql \
  tests/sport-classification.test.mjs
```

Do **not** stage: `tests/coach-limit.test.mjs`, `coach-web-diagnostic-report.md`, `cyclist-sprint-wip.patch` (all pre-existing/unrelated).

**Suggested message:** `feat(activities): authoritative multi-sport classification foundation (cycling)`

**Before deploy (host):** run `npm run build:native` to regenerate `dist/` from source (restores the dist parity the coach-limit test checks). The migration is optional and only needed if the new events are ever persisted to `activation_events`.

*Not committed, pushed, or deployed by this session.*
