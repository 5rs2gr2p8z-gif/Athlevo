import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

const read = path => readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const cap = JSON.parse(read("capacitor.config.json"));
const variables = read("android/variables.gradle");
const rootGradle = read("android/build.gradle");
const appGradle = read("android/app/build.gradle");
const wrapper = read("android/gradle/wrapper/gradle-wrapper.properties");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const strings = read("android/app/src/main/res/values/strings.xml");
const styles = read("android/app/src/main/res/values/styles.xml");
const privacy = read("ios/App/App/PrivacyInfo.xcprivacy");
const info = read("ios/App/App/Info.plist");
const project = read("ios/App/App.xcodeproj/project.pbxproj");
const metaPixel = read("js/metaPixel.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function pngSize(path) {
  const file = readFileSync(path);
  assert.equal(file.subarray(1, 4).toString(), "PNG");
  return [file.readUInt32BE(16), file.readUInt32BE(20)];
}

test("Capacitor Android is pinned to the core/CLI version", () => {
  assert.equal(pkg.devDependencies["@capacitor/android"], "8.4.2");
  assert.equal(pkg.devDependencies["@capacitor/cli"], "8.4.2");
  assert.equal(pkg.dependencies["@capacitor/core"], "8.4.2");
});

test("native identities and release versions are coherent", () => {
  assert.equal(pkg.version, "0.6.0");
  assert.equal(cap.appId, "org.athlevo.app");
  assert.equal(cap.appName, "Athlevo");
  assert.match(appGradle, /applicationId "org\.athlevo\.app"/);
  assert.match(read("android/app/src/main/java/org/athlevo/app/MainActivity.java"), /package org\.athlevo\.app;/);
  assert.match(read("android/app/src/androidTest/java/org/athlevo/app/ExampleInstrumentedTest.java"), /org\.athlevo\.app/);
  assert.match(appGradle, /versionCode 1/);
  assert.match(appGradle, /versionName "0\.6\.0"/);
  assert.equal((project.match(/MARKETING_VERSION = 0\.6\.0;/g) || []).length, 2);
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 1;/g) || []).length, 2);
});

test("Android 16 build levels and Capacitor 8 toolchain are explicit", () => {
  assert.match(variables, /minSdkVersion = 24/);
  assert.match(variables, /compileSdkVersion = 36/);
  assert.match(variables, /targetSdkVersion = 36/);
  assert.match(rootGradle, /com\.android\.tools\.build:gradle:8\.13\.0/);
  assert.match(wrapper, /gradle-8\.14\.3-all\.zip/);
});

test("Android manifest exposes only the launcher and exact OAuth callbacks", () => {
  assert.match(manifest, /android:exported="true"/);
  assert.match(manifest, /android:scheme="athlevo"/);
  assert.match(manifest, /android:host="auth"[\s\S]*?android:path="\/callback"/);
  assert.match(manifest, /android:host="provider"[\s\S]*?android:path="\/callback"/);
  assert.match(strings, /<string name="custom_url_scheme">athlevo<\/string>/);
  assert.doesNotMatch(manifest, /android:scheme="https?"/);
});

test("Android permissions are foreground-only and cleartext/backup are disabled", () => {
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.doesNotMatch(manifest, /BACKGROUND_LOCATION|CAMERA|RECORD_AUDIO|READ_|WRITE_/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
});

test("adaptive, round, themed, and density launcher assets use Athlevo resources", () => {
  const densitySizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, size] of Object.entries(densitySizes)) {
    assert.deepEqual(pngSize(`android/app/src/main/res/mipmap-${density}/ic_launcher.png`), [size, size]);
    assert.deepEqual(pngSize(`android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`), [size, size]);
  }
  assert.match(read("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), /adaptive-icon/);
  assert.match(read("android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml"), /<monochrome/);
  assert.ok(existsSync("android/app/src/main/res/drawable/ic_launcher_monochrome.xml"));
});

test("Android 12 splash uses existing branding and the post-splash app theme", () => {
  assert.match(styles, /windowSplashScreenBackground">@color\/splash_background/);
  assert.match(styles, /windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher_foreground/);
  assert.match(styles, /postSplashScreenTheme">@style\/AppTheme\.NoActionBar/);
  assert.deepEqual(
    pngSize("android/app/src/main/res/drawable-port-xxxhdpi/splash.png"),
    [1280, 1920]
  );
});

test("iOS uses automatic signing without stale identity or a hard-coded team", () => {
  assert.equal((project.match(/CODE_SIGN_STYLE = Automatic;/g) || []).length, 2);
  assert.doesNotMatch(project, /CODE_SIGN_IDENTITY|DEVELOPMENT_TEAM/);
  assert.doesNotMatch(info, /UIRequiredDeviceCapabilities|armv7/);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0/);
});

test("privacy manifest is target-bundled, evidence-based, and tracking-disabled", () => {
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
  assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeFitness/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeHealth/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeCoarseLocation/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeProductInteraction/);
  assert.match(privacy, /<key>NSPrivacyAccessedAPITypes<\/key>\s*<array\/>/);
});

test("Meta Pixel is disabled only for native runtimes", () => {
  function evaluate(native) {
    const inserted = [];
    const root = {
      AthlevoRuntime: { isNative: () => native },
      META_PIXEL_ID: "test-pixel",
      sessionStorage: { getItem: () => null, setItem() {} }
    };
    root.window = root;
    const document = {
      querySelector: () => null,
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore: node => inserted.push(node) } }]
    };
    vm.runInNewContext(metaPixel, { window: root, document, sessionStorage: root.sessionStorage, Date });
    return { api: root.AthlevoMetaPixel, inserted };
  }
  const native = evaluate(true);
  const web = evaluate(false);
  assert.equal(native.api.isReady(), false);
  assert.equal(native.inserted.length, 0);
  assert.equal(web.api.isReady(), true);
  assert.equal(web.inserted.length, 1);
});

test("reproducible native scripts cover sync, debug APK, and release AAB", () => {
  assert.match(pkg.scripts["native:sync"], /cap sync/);
  assert.match(pkg.scripts["android:debug"], /assembleDebug/);
  assert.match(pkg.scripts["android:bundle"], /bundleRelease/);
  assert.match(pkg.scripts["ios:prepare"], /cap sync ios/);
});

console.log(`\n${passed} native build-readiness tests passed.`);
