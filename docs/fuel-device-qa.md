# Fuel V1 — real-device QA (Android debug build)

QA only. Not a release build: debug-signed, Fuel stays default OFF for everyone.

## 0. One-time setup

1. **Apply the migration** — Supabase Dashboard → SQL Editor → New query → paste all of
   `migrations/2026-09-30_fuel_tracking.sql` → Run.
2. **Verify it** — new query → paste all of `docs/fuel-migration-verify.sql` → Run.
   Every row must be `true`, and the last row `>>> ALL CHECKS PASSED` must be `true`.
3. Make sure the deployed API (the one the app talks to) contains the Fuel endpoints
   (`/api/fuel/analyze-meal`, `/api/fuel/meals`). The app cannot use Fuel against an API without them.

## 1. Build the QA APK (on your Mac)

```bash
cd "/Users/deanvincentcastro/Desktop/Athlevo ai"
npm run android:debug      # = npm run android:prepare && cd android && ./gradlew assembleDebug
```

- Success looks like `BUILD SUCCESSFUL` at the end of the Gradle output.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- Debug signing only — no keystore or `keystore.properties` needed. This does not change applicationId, versionCode or versionName.
- `npm run android:prepare` rewrites `dist/` (git-ignored) **and the one tracked file `dist/index.html`**. Do not commit that change (`git restore dist/index.html`).
- Your working tree currently has an uncommitted `versionCode 6` in `android/app/build.gradle`; the QA build simply uses whatever is there.

Install (phone on USB, USB debugging ON):

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

If it says `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (a Play/release-signed Athlevo is installed), uninstall Athlevo first, then install.

## 2. Turn Fuel on — this device only (recommended: WebView remote debugging)

Debug builds have WebView debugging enabled automatically.

1. Phone: open Athlevo once and sign in. USB debugging ON, phone connected.
2. Mac Chrome: open `chrome://inspect/#devices` → under the Athlevo WebView click **inspect**.
3. In the DevTools **Console**, run:
   ```js
   localStorage.setItem("athlevo_ff_fuel_tracking_v1", "1"); location.reload();
   ```
4. Fuel card now appears on **You**. The override survives logout/login and app restarts.
5. Turn off again: `localStorage.removeItem("athlevo_ff_fuel_tracking_v1"); location.reload();`

(No dev toggle exists in the app, and `?ff_fuel_tracking_v1=1` can't be typed into a native app, so this is the reliable route. Nothing here enables Fuel for other users.)

To test the **consent v2** re-prompt, use a test account whose consent is still v1 — SQL Editor:
`update public.ai_consent set consent_version = '1' where user_id = '<test user id>';`

## 3. Flows (one real Android phone)

Tick each. "✔" = expected.

1. **Flag OFF** — launch: no Fuel card; Calendar, Coach and You all work.
2. **Enable Fuel** — set the flag (section 2), reload: Fuel card under You; tapping opens Fuel.
3. **Manual meal** — Add meal → Add manually → name, calories (carbs/protein/fat optional) → Log meal. ✔ Logged intake total and history update.
4. **Photo** — Add meal → Take photo → system camera opens → capture → returns to Athlevo → add note "two cups of rice" → Analyze meal.
   ✔ consent v2 prompt if the account is on v1 (once) ✔ one analysis ✔ note visible in the result (2 cups) ✔ screen says it's an estimate to review; nothing logged yet.
5. **Review** — change quantity, calories, carbs, protein, fat; Add food; Remove food. ✔ totals update instantly. Log meal → ✔ saved values are the edited ones.
6. **Double tap** — rapid-tap Analyze, then Log meal. ✔ one analysis, one meal.
7. **CRUD** — open a meal → Edit → Save; Log again → change → Log; Delete → confirm. ✔ totals/history update.
8. **Consent** — Settings → turn AI features off. ✔ history stays ✔ manual logging works ✔ photo analysis asks for consent again ✔ nothing disappears.
9. **Camera / gallery** — Take photo ✔; Upload photo ✔; pick a non-image file ✔ friendly message; a large photo (12 MP+) ✔ works.
10. **Activity energy** — with a synced activity that has calories: "Activity energy ~N kcal" (not total burn). Without: "Daily expenditure isn't available from your current training data."
11. **Training context** — today's / tomorrow's workout, and a rest day if you have one. ✔ no nutrition advice appears.
12. **Dark mode** — summary, sheets, review form, history, weekly chart all readable.
13. **Offline** (airplane mode) — Analyze, manual Log, Edit, Delete each show an honest error and keep what you typed. Turn network on → Retry works. ✔ no fake success, ✔ one meal after retry.
14. **Account deletion** (disposable account with Fuel data) — delete account; in SQL Editor check `select count(*) from public.fuel_meals where user_id = '<id>'` is `0`.
15. **Persistence** — log out and back in, and force-close/reopen: ✔ meals still there, totals recompute.
16. **Back button** — with the Add-meal sheet open, Android Back closes the sheet (not the app).


---

# Real-device QA against a Vercel Preview (Android debug build)

Nothing here touches production: the debug APK talks to a **Preview** deployment of branch `qa/fuel-v1`. Fuel stays default OFF.

## One-time setup (Mac)

1. Confirm the migration: run `docs/fuel-migration-verify.sql` in Supabase SQL Editor → must end with `>>> ALL CHECKS PASSED = true`.
2. Push the QA branch (never `main`, never merge it): `git push origin HEAD:refs/heads/qa/fuel-v1`. Vercel builds a Preview.
3. Vercel → Project → Deployments → the `qa/fuel-v1` one → copy its URL (`https://<name>-git-qa-fuel-v1-<team>.vercel.app`).
4. Preview needs env vars (Settings → Environment Variables, scope *Preview*): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`), `OPENAI_API_KEY`, plus whatever Coach already uses. Redeploy after adding.
5. Settings → Deployment Protection: the app makes plain `fetch` calls, so **Vercel Authentication must not block the preview** for this test (set it to "Only Production" / disabled for previews, or use a Protection Bypass secret for the smoke script only). A protected preview returns an HTML sign-in page and the phone will fail.
6. Use a disposable test account (email + password). Never real customer data.

## Smoke test (no OpenAI call)

    FUEL_QA_BASE=https://<preview>.vercel.app FUEL_QA_EMAIL=you+qa@example.com FUEL_QA_PASSWORD='…' \
      node scripts/fuel-qa-smoke.mjs

Expect all PASS: unauth rejected ×2, sign-in, meal read, create, delete. It leaves no meal behind.

## Build the debug APK (Mac)

    cd "Athlevo ai"
    ATHLEVO_QA_API_ORIGIN=https://<preview>.vercel.app npm run android:qa
    git restore dist/index.html      # dist/index.html is tracked; undo the generated copy

`BUILD SUCCESSFUL` → `android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed, not a release). `npm run android:debug` (no `--qa`) still targets production.

## Phone steps

1. Enable USB debugging, `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
2. Open Athlevo, sign in with the test account (email/password).
3. On the Mac: Chrome → `chrome://inspect` → inspect Athlevo → Console:
   `localStorage.setItem("athlevo_ff_fuel_tracking_v1","1"); location.reload();`
4. You → Fuel.
5. Add meal → Add manually → name + calories → Log meal. Check total + history.
6. Add meal → Take photo (system camera opens, returns to Athlevo).
7. Note: `two cups of rice`.
8. Analyze meal.
9. Consent v2 sheet → Continue.
10. Review: edit quantity/calories/macros, add/remove a food; totals update live.
11. Log meal.
12. Verify the logged totals are your edited values.
13. Log again / edit / delete a meal; totals update.
14. Settings → AI features off (withdraw consent).
15. Manual logging still works; photo analysis asks for consent again.
16. Test Upload from gallery and Take photo.
17. Test dark mode (summary, sheets, review, history).
18. Test the Android back button (closes sheets, doesn't exit mid-flow).

Turn Fuel off again: `localStorage.removeItem("athlevo_ff_fuel_tracking_v1")`.
