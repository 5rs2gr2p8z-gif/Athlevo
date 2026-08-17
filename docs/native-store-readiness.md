# Native store readiness (P0)

Athlevo uses Capacitor 8.4.2 for both native shells. The checked-in Android
project is the source project; generated web assets and native build outputs
remain ignored.

## Required local tools

- Node.js supported by Capacitor 8 and `npm install`.
- Android Studio with Android SDK Platform 36 and its matching build tools.
- JDK 21. Capacitor Android compiles with Java 21.
- The checked-in Gradle 8.14.3 wrapper and Android Gradle Plugin 8.13.0.
- Xcode 26 or later with the iOS 26 SDK for App Store Connect uploads. The
  deployment target remains iOS 15; it does not need to be iOS 26.

## Reproducible commands

```sh
npm install
npm run native:sync
npm run android:debug
npm run android:bundle
npm run android:open
npm run ios:open
```

`android:debug` creates a debug APK. `android:bundle` builds an unsigned
release AAB until release signing is configured locally. `ios:open` opens the
project for device selection, signing, archive, and TestFlight preparation.

## Android configuration

- Application ID / namespace: `org.athlevo.app`
- Version: `0.6.0` (`versionCode` 1)
- minSdk 24, compileSdk 36, targetSdk 36
- Cleartext traffic and app backup are disabled.
- The app manifest declares internet plus foreground coarse/fine location.
  Location is requested only after the athlete taps **Use local weather**;
  there is no background location. Capacitor's WebView geolocation bridge
  requests both foreground permissions and accepts approximate location on
  Android 12 and later. Athlevo rounds coordinates to two decimals before
  sending them and does not persist them.
- `athlevo://auth/callback` and `athlevo://provider/callback` are handled by
  the exported single-task launch activity. No HTTP app links are claimed.
- The Network plugin contributes `ACCESS_NETWORK_STATE` during manifest merge.
- Launcher density, adaptive, round, and Android 13 monochrome resources are
  derived from the existing Athlevo icon. Splash resources use the existing
  icon and `#eeeeec` brand background.

No signing key is checked in. `android/.gitignore` excludes keystores,
`local.properties`, APKs, AABs, and build output. For the first upload, create
an upload key outside the repository, configure its path/passwords through an
uncommitted local Gradle properties file or CI secrets, then enroll the app in
Play App Signing.

## iOS configuration and privacy

- Bundle ID: `org.athlevo.app`
- Version: `0.6.0` (build 1), deployment target iOS 15
- Automatic signing is enabled. No Apple Team ID, certificate, or provisioning
  profile is committed. Select the Athlevo target in Xcode, choose Dean's team,
  and keep **Automatically manage signing** enabled.
- The obsolete `armv7` required-device capability is removed.
- `PrivacyInfo.xcprivacy` is included in the app target. It declares the
  account, training/health, optional coarse location, user content, purchase
  history, and linked product analytics evidenced in the app. Athlevo's app
  code does not directly call a required-reason native API, and the installed
  Capacitor 8 packages bundle manifests with empty required-reason arrays, so
  no reason code is guessed.
- Meta Pixel is disabled in both native runtimes until Athlevo intentionally
  implements ATT/consent. Its existing browser behavior is unchanged. Native
  first-party PostHog product analytics remains enabled and is declared as
  linked product interaction data used for analytics, not cross-app tracking.
- The foreground location usage description remains because local weather is
  a user-initiated native feature. No location prompt is shown at first launch.

## Account and store work not performed in P0

Apple developer-account work still required:

1. Install/select Xcode 26+ and an iOS 26 SDK.
2. Register `org.athlevo.app` if needed, select the Apple Developer team, and
   let Xcode create the development/distribution provisioning profiles.
3. Create the App Store Connect app, archive, validate the privacy report and
   App Privacy answers, then upload to TestFlight.

Google developer-account work still required:

1. Install Android Studio, JDK 21, and SDK Platform 36.
2. Create the Play Console app for `org.athlevo.app` and enroll in Play App
   Signing.
3. Create and securely store an upload key, configure local/CI release signing,
   upload the AAB, and start the applicable closed-test track.

Apple IAP, Google Play Billing, store-specific payment UI, purchase
reconciliation, and external-payment region gating are intentionally deferred.
Whop, PayMongo, pricing, and entitlements are unchanged. The future native
payment work starts in `js/accessGuard.js` and its upgrade/payment sheets.

Sign in with Apple is also intentionally deferred. It will require the Sign in
with Apple capability/entitlement, an App ID and Services ID, key management,
Supabase provider configuration, and enabling the existing gated Apple button.
