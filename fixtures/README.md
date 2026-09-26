# Fixtures

Minimal projects used by unit tests and for manual end-to-end checks.

## android-native/

A minimal but **real** Gradle Android project (`com.android.application` 8.5.2, Java,
one `MainActivity`, minSdk 24, targetSdk 35).

### Gradle wrapper

`gradle/wrapper/gradle-wrapper.properties` is committed, but `gradle-wrapper.jar`
is **not** (it is a binary and no Gradle installation was available when this
fixture was created). Before building the fixture, run once inside
`fixtures/android-native/`:

```bash
gradle wrapper   # requires a local Gradle install, e.g. `brew install gradle`
```

Alternatively copy `gradle-wrapper.jar` + `gradlew` + `gradlew.bat` from any
existing Android project using Gradle 8.9.

### Signing

`app/build.gradle` reads the signing properties injected by caricamento
(`-PCARICAMENTO_STORE_FILE`, `-PCARICAMENTO_STORE_PASSWORD`,
`-PCARICAMENTO_KEY_ALIAS`, `-PCARICAMENTO_KEY_PASSWORD`) plus
`-PCARICAMENTO_VERSION_CODE` / `-PCARICAMENTO_VERSION_NAME` for versioning.

When no properties are injected it falls back to the committed
`keystore/test-upload.keystore` so the fixture builds out of the box.

### Test keystore — TEST ONLY

`keystore/test-upload.keystore` is a throwaway keystore generated with:

```bash
keytool -genkeypair -keystore test-upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass android -keypass android \
  -dname "CN=Caricamento Test, OU=Test, O=Caricamento, L=Test, ST=Test, C=US"
```

Credentials: alias `upload`, store password `android`, key password `android`.
It is committed to git **on purpose** so integration can be exercised locally.
Never use it (or these passwords) for a real application.

## react-native-cli/

A real React Native CLI project (`@react-native-community/cli init`,
RN 0.87). The Android project lives in `android/` — caricamento detects the
`react-native` project type and builds inside that subdirectory.

**Zero-touch signing:** `android/app/build.gradle` is the vanilla template —
signing and versioning are injected externally via a generated Gradle init
script (`android.signing.injection: 'init-script'`, the default).
`applicationId` is `com.caricamento.fixture` to match the shared test
Firebase app.

```bash
npm install   # required once — the RN Gradle plugin needs node_modules
export ANDROID_KEYSTORE_PATH=<abs path to android-native/keystore/test-upload.keystore>
export ANDROID_KEYSTORE_PASSWORD=android ANDROID_KEY_PASSWORD=android
caricamento release --platform android --targets firebase
```

## react-native-expo/

A real Expo project (`create-expo-app --template blank`) ejected to the bare
workflow via `expo prebuild --platform android`. The Android package
`com.caricamento.fixture` comes from `app.json` → `expo.android.package` and
survives re-prebuilds; signing does not depend on `android/` contents at all
(init-script injection), so `npx expo prebuild --clean` is safe to run.

Note: `create-expo-app` refuses a directory literally named `expo` (npm
dependency name conflict) — hence `react-native-expo`.

```bash
npm install   # if node_modules is missing
export ANDROID_KEYSTORE_PATH=<abs path to android-native/keystore/test-upload.keystore>
export ANDROID_KEYSTORE_PASSWORD=android ANDROID_KEY_PASSWORD=android
caricamento release --platform android --targets firebase
```

## ios-native/

A minimal but **real** SwiftUI app: `CaricamentoFixture.xcodeproj` (one app
target, iOS 16.0, bundle ID `com.caricamento.fixture`, generated Info.plist
with `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`,
`ITSAppUsesNonExemptEncryption = NO`) and a **shared** scheme
`CaricamentoFixture` in `xcshareddata/xcschemes/`.

`caricamento.config.ts` uses `ios.signing.mode: 'none'`, so the fixture builds
on any Mac with Xcode — no Apple account, certificate or profile needed:

```bash
npm run build   # in the repo root
cd fixtures/ios-native
node ../../dist/cli/index.js build --platform ios
# → build/caricamento/ipa/CaricamentoFixture.ipa (unsigned)
#   build/caricamento/CaricamentoFixture.xcarchive/dSYMs/
```

The unsigned .ipa cannot be installed on a device or uploaded. For a real
TestFlight run switch to `mode: 'automatic'` with your `teamId`, change the
bundle ID to one registered in your App Store Connect account (variant
`bundleId` or `ios.signing.bundleId`), and uncomment `targets.appstore`.

## flutter/

A **marker fixture only** — `pubspec.yaml` plus `ios/` and `android/`
directories, just enough for `ProjectDetector` unit tests. Not a
runnable app. (React Native detection is tested against the real
`react-native-cli` / `react-native-expo` fixtures above — detection only
checks file existence, so no `npm install` is needed.)
