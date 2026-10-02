# Fuel V1 — QA execution guide (Mac, in order)

QA only. Fuel stays globally OFF. Do not merge `qa/fuel-v1`, do not touch Production, do not build a release.
Full flow checklist lives in `docs/fuel-device-qa.md`; this page is the order of operations plus the release-blocking subset.

Branch `qa/fuel-v1` = Fuel work up to `89d2c7c` + this guide. Prerequisite: a disposable QA account (email + password).

---

## PHASE 1 — DATABASE

1. Supabase Dashboard → SQL Editor → New query → paste all of `migrations/2026-09-30_fuel_tracking.sql` → Run.
   (Idempotent: safe to run again.)
2. New query → paste all of `docs/fuel-migration-verify.sql` → Run.
3. Required: `>>> ALL CHECKS PASSED = true`.
   **If false: STOP. Do not continue QA.**

Never paste a Supabase key anywhere in this process.

## PHASE 2 — QA BRANCH / VERCEL PREVIEW

```bash
cd "/Users/deanvincentcastro/Desktop/Athlevo ai"
git switch qa/fuel-v1          # already checked out if `git branch --show-current` says qa/fuel-v1
git push origin qa/fuel-v1     # pushes ONLY the QA branch
```

Vercel Dashboard → Project → Deployments → the deployment for branch `qa/fuel-v1` (Environment: Preview) → copy the URL.
It must look like `https://something.vercel.app`.

- Do NOT alias it to athlevo.org. Do NOT "Promote to Production".
- Settings → Deployment Protection: if Vercel Authentication is on for Preview, the phone's `fetch` calls get an HTML sign-in page. For this temporary QA, set Preview protection to off (or "Only Production"), or create a Protection Bypass for Automation secret and use it only for the smoke script (`VERCEL_BYPASS_SECRET`, the phone cannot use it). Do not change any production-domain setting.

**Preview env check** — Settings → Environment Variables, filter scope *Preview*. Record only PRESENT / MISSING (never copy values):

| Variable | Status |
|---|---|
| `SUPABASE_URL` | PRESENT / MISSING |
| `SUPABASE_SERVICE_ROLE_KEY` (or the project's current equivalent secret key) | PRESENT / MISSING |
| `OPENAI_API_KEY` | PRESENT / MISSING |
| `FUEL_ANALYSIS_MODEL` (optional) | PRESENT / MISSING |

Any required one MISSING → **STOP before device QA**; add it, then redeploy the branch.

## PHASE 3 — API SMOKE TEST

```bash
FUEL_QA_BASE=https://<preview>.vercel.app \
FUEL_QA_EMAIL='<qa-email>' \
FUEL_QA_PASSWORD='<qa-password>' \
node scripts/fuel-qa-smoke.mjs
```

(Protected preview only: also add `VERCEL_BYPASS_SECRET='<secret>'`.)

Expected: 7 `PASS` lines and the final line

`FUEL QA SMOKE PASSED`

covering: unauthenticated meals request rejected; unauthenticated analysis rejected; QA user signs in; meal read succeeds; one manual test meal created; test meal deleted; second delete returns 404 (nothing left behind). The script never calls OpenAI with an image, and never prints the password or tokens.
`FUEL QA SMOKE FAILED` / `INCOMPLETE` (or a missing credentials SKIP) = not passed. Stop and fix.

## PHASE 4 — ANDROID QA BUILD

```bash
ATHLEVO_QA_API_ORIGIN=https://<preview>.vercel.app npm run android:qa
```

Expected: `QA build: /api requests will go to https://<preview>.vercel.app` early, `BUILD SUCCESSFUL` at the end.
APK: `android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed; no release signing, no keystore).

Verify the origin was baked in, **before** restoring the tracked file:

```bash
grep -o '__ATHLEVO_QA_API_ORIGIN__="[^"]*"' dist/index.html
```

It must print your preview origin. Then immediately:

```bash
git restore dist/index.html
```

(Native preparation rewrites that tracked file; never commit it.)

## PHASE 5 — DEVICE INSTALL

Phone on USB, USB debugging ON:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

If you get `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: an Athlevo signed with the release key is already installed and the debug signature differs. Uninstalling it removes that app's local data on the phone (cloud data in your account stays). This is your own QA device, so that's fine, but only do it knowingly: `adb uninstall org.athlevo.app`, then install again. QA only; never do this on anyone else's phone.

## PHASE 6 — ENABLE FUEL (this device only)

1. Open Athlevo on the phone and sign in with the QA account.
2. Mac Chrome → `chrome://inspect/#devices` → find the Athlevo WebView → **inspect** → **Console**:

```js
localStorage.setItem("athlevo_ff_fuel_tracking_v1","1");
location.reload();
```

3. Verify: **You → Fuel** card appears.

Disable again:

```js
localStorage.removeItem("athlevo_ff_fuel_tracking_v1");
location.reload();
```

Fuel remains OFF globally; nothing here affects other users.

## PHASE 7 — REAL DEVICE TEST

Details for each flow: `docs/fuel-device-qa.md` §3. Release-blocking subset — mark each:

```
QA RESULT   device: ________  Android: ____  build: debug @ <preview>  date: ______
 1  [ ] PASS [ ] FAIL  manual meal logs successfully
 2  [ ] PASS [ ] FAIL  camera opens
 3  [ ] PASS [ ] FAIL  gallery opens
 4  [ ] PASS [ ] FAIL  note ("two cups of rice") survives analysis
 5  [ ] PASS [ ] FAIL  consent v2 appears correctly
 6  [ ] PASS [ ] FAIL  AI returns a real meal estimate
 7  [ ] PASS [ ] FAIL  edit the estimate
 8  [ ] PASS [ ] FAIL  log edited values (saved = edited, not original)
 9  [ ] PASS [ ] FAIL  totals update
10  [ ] PASS [ ] FAIL  no duplicate on double tap
11  [ ] PASS [ ] FAIL  edit meal
12  [ ] PASS [ ] FAIL  repeat meal
13  [ ] PASS [ ] FAIL  delete meal
14  [ ] PASS [ ] FAIL  withdraw AI consent
15  [ ] PASS [ ] FAIL  manual logging still works after withdrawing
16  [ ] PASS [ ] FAIL  activity energy truthfully labelled (not total burn)
17  [ ] PASS [ ] FAIL  training context displays correctly
18  [ ] PASS [ ] FAIL  Android Back closes the sheet (not the app)
19  [ ] PASS [ ] FAIL  dark mode works
20  [ ] PASS [ ] FAIL  logout/login preserves meals
```

### STOP RELEASE if any of these happen

- app crashes opening Fuel
- camera crashes or fails to return
- AI analysis cannot complete
- meal logs without explicit confirmation
- duplicate meal created from one submission
- meals disappear after login/relaunch
- another user's meals become visible
- AI consent can be bypassed
- manual logging stops working when AI is declined
- activity calories are shown as total daily expenditure
- totals do not update after edit/delete
- account deletion leaves Fuel data (check `fuel_meals` for the user id = 0 rows)
- QA build accidentally uses the production API while a QA origin was supplied (check: Vercel Preview logs show the requests, athlevo.org logs don't)

Minor cosmetic issues: document separately; they don't block.

## PHASE 8 — CLEANUP

- Optional: remove the Fuel override (command in Phase 6).
- Optional: uninstall the debug build (`adb uninstall org.athlevo.app`).
- Delete only the disposable QA meals / QA account. Do not delete any other production data.
- Keep branch `qa/fuel-v1` and its Vercel Preview until the release build no longer needs QA. Do not merge it automatically.
- `git status` must not show `dist/index.html`; if it does: `git restore dist/index.html`.

---

## versionCode note

The working tree currently has an **uncommitted** `versionCode 6` in `android/app/build.gradle`. Do NOT commit it as part of QA. After Fuel passes real-device QA, the final public Fuel build will likely move to `versionCode 7`; that change is made then, not now.

## Release path after QA (reference, nothing here is executed by this guide)

Fuel QA PASS
→ enable Fuel for the intended launch cohort
→ commit versionCode 7
→ production native build / AAB
→ Google Play processing
→ obtain the Play-signed universal APK for versionCode 7
→ verify signer
→ host the APK
→ wire `/download/android`
→ fix PWA landing blockers
→ activate the landing page
→ deploy / push
