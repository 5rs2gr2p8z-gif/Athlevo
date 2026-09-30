# Fuel V1 — release checklist

Flag: `fuel_tracking_v1` (default **OFF**). Nothing here enables it globally.

## BEFORE QA

- [ ] **Apply the Supabase migration** `migrations/2026-09-30_fuel_tracking.sql`
  - Supabase Dashboard → SQL Editor → New query → paste the whole file → Run. Safe to run twice (idempotent).
  - Do this on the same project the app/API point at. Run it *before* enabling the flag.
  - Verify: Table Editor shows `fuel_meals`, `fuel_meal_items`, `fuel_preferences`, each with RLS ON; and
    `select proname from pg_proc where proname = 'fuel_save_meal';` returns one row.
- [ ] **Enable the flag locally** (browser/WebView console, then reload):
  `localStorage.setItem("athlevo_ff_fuel_tracking_v1", "1")`
  or open the app with `?ff_fuel_tracking_v1=1` (persists). Turn off: `localStorage.removeItem("athlevo_ff_fuel_tracking_v1")`.
- [ ] Server env: `OPENAI_API_KEY` present (already used by Coach). Optional `FUEL_ANALYSIS_MODEL` (default `gpt-5.5`).

## MANUAL QA

- [ ] **Flag off:** no Fuel card on You; app behaves as before.
- [ ] **Photo flow:** You → Fuel → Add meal → Take photo / Upload → add a note → Analyze → review → edit values → Log meal.
  Totals update as you edit; the logged values are your edited ones; nothing is saved until "Log meal".
- [ ] **Manual flow:** Add manually → name + calories (macros optional) → Log meal.
- [ ] **Edit / repeat / delete:** open a meal → Edit → Save; "Log again" → edit → Log; Delete → confirm.
- [ ] **Double tap** "Analyze" and "Log meal": exactly one analysis, exactly one meal.
- [ ] **Consent (existing user with consent v1):** first photo analysis shows the updated AI disclosure once.
  Continue → analysis runs. Not now → photo analysis unavailable, manual logging still works.
- [ ] **Consent withdrawn** (Settings → AI features off): history still visible, manual logging works, photo analysis asks for consent again.
- [ ] **Offline:** analyze/log/edit/delete each show an honest message, keep what you typed, Retry works after reconnecting.
- [ ] **Empty states:** brand-new account = first-run card; a day without meals reads "No logged meals" (never "0 kcal").
- [ ] **Light + dark**, 320 px and 390 px widths, no horizontal scroll, nothing hidden under the bottom nav.
- [ ] **Activity energy:** with a Strava/Garmin/Intervals activity that reports calories → "Activity energy ~N kcal"; without → "Daily expenditure isn't available from your current training data."
- [ ] **Training context:** rest day, easy run, interval, long run, nothing planned, two sessions in one day.
- [ ] **Android real device:** Take photo (system camera opens, photo returns), Upload from gallery, Back button closes the sheet.
- [ ] **iOS camera (later, TestFlight/device):** permission prompt shows the Fuel wording; Upload uses the system photo picker.
- [ ] **Account deletion** on a test account with Fuel data: meals/items/preferences are gone.

## BEFORE PUBLIC ENABLE

- [ ] Migration confirmed applied in production (see above).
- [ ] Updated AI consent (v2) is live in the shipped web + Android build (`js/aiConsent.js` `CONSENT_VERSION = "2"`).
- [ ] Privacy route verified: `/privacy` shows "Nutrition and Meal Information" and the Fuel AI paragraph.
- [ ] Feature-flag decision made (PostHog flag `fuel_tracking_v1`: who gets it first).
- [ ] Real-device Android QA passed (camera + gallery + back button).
- [ ] Decide plan gating / monthly AI limits (none applied in V1; see `fuel-analyze` in `lib/server/rateLimit.js`, currently 30 analyses/hour/user).
