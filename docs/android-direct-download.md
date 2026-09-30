# Android direct download (athlevo.org → APK)

Status: **prepared, not deployed, not activated.** Nothing is uploaded and no APK is stored in this repo.

## Signing decision

- Google Play app uses **Play App Signing**. `android/keystore.properties` points at an *upload* key
  (`athlevo-upload.jks`). Play re-signs installs with Google's separate *app signing key*.
- An APK signed with the upload key would not be update-compatible with the Play install (Android
  refuses a signature change; the user would have to uninstall first).
- **Decision:** the direct-download APK is the **Play-signed universal APK** downloaded from Play Console.
  It carries the app-signing certificate, so Play installs and direct installs can update each other.
- Do **not** build or sign a release APK locally with the upload key. There is deliberately no
  `assembleRelease` npm script for APKs. Do not rotate keys.

## Getting the APK (Play Console, versionCode 6)

Menu names shift between Console redesigns; go by the labels.

1. Open Play Console → **Athlevo** app.
2. **Test and release → Latest releases and bundles** (older UI: **Release → App bundle explorer**).
   Open the App bundle explorer and choose the **versionCode 6** bundle (`1.0.0`) from the version selector.
   If 6 is not listed, it has not been uploaded/processed yet — do not use another version.
3. Open the **Downloads** tab.
4. Under *Assets*, choose **Signed, universal APK** → download it (rename nothing).
   Available because the app uses Play App Signing.
5. Get the expected certificate: **Test and release → App integrity → App signing** (older UI:
   **Setup → App integrity**) → copy **App signing key certificate → SHA-256**. This is the fingerprint
   the APK must carry (not the *upload key certificate*).
6. On the Mac with the Android SDK, from the repo:
   `npm run android:apk:wire -- ~/Downloads/<file>.apk --expected-cert-sha256 <SHA-256 from step 5>`
   It verifies (apksigner + aapt2): signature valid, cert equals the Play app signing key, package
   `org.athlevo.app`, versionCode 6, versionName 1.0.0, not debuggable. Only then does it record
   size / SHA-256 in `distribution/android-release.json` and fill the landing page metadata.
7. Upload the same file (unchanged) to hosting (below), then `npm run android:release-check`.

## Hosting plan

Recommended: **Supabase Storage**, a new *public* bucket `releases`, object
`android/athlevo-android-v1.0.0.apk`. `/download/android` (vercel.json, 302) redirects to
`…/storage/v1/object/public/releases/android/athlevo-android-v1.0.0.apk?download=athlevo-android-v1.0.0.apk`
(`?download=` forces a save-as with the right filename).

Why not Vercel static files first: the project deploys from GitHub. An APK that is not committed
disappears at the next git-triggered deploy; committing a ~30–60 MB binary bloats the repo (and was
ruled out). Storage is independent of deploys. Adding a bucket is additive: no change to existing
buckets, tables, auth or RLS. Confirm the Supabase plan's per-object size limit fits the APK before
uploading (universal APKs are larger than the AAB's per-device downloads).

Fallback if Storage is unsuitable: serve `/downloads/<file>.apk` from Vercel with a
`Content-Type: application/vnd.android.package-archive` header — requires the file to be in the
deployment (commit, or CLI-only deploys that every later deploy must repeat).

`/download/android` is a *302*, so future versions only change the redirect destination.
Marketing links never change.

## Trust / install UX

Landing shows version, size and SHA-256 (in an expandable "Technical details"). Copy says only that
Android may ask to allow installs from the browser. The page never suggests disabling Play Protect or
system security, and never tries to bypass the "Install unknown apps" permission.

## Updates (V1 = manual)

No custom updater. Future releases must keep `applicationId org.athlevo.app`, be the Play-signed
universal APK for the new bundle, and use a **higher versionCode**. Users install the new file over
the old one; data is kept. Because the signature matches Play's, a user may later switch to the Play
version without uninstalling. Direct-download users get no automatic updates until they move to Play.
Bump the filename, manifest, redirect and landing version together, then run `npm run android:release-check`.

## Known interaction (not changed here)

`service-worker.js` caches *any* successful navigation response as `/index.html`. The download
redirect is not cached (redirect responses are not `ok`), but the same behaviour matters for the
`/` activation — see `docs/landing-activation-proposal.md`.
