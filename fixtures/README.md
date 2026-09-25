# Fixtures

Minimal projects used by unit tests and for manual end-to-end checks (SPEC.md §12).

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

## flutter/ and react-native/

These are **marker fixtures only** — `pubspec.yaml` / `package.json` plus
`ios/` and `android/` directories, just enough for `ProjectDetector` unit tests
(SPEC.md §4). They are not runnable Flutter/React Native apps; generating real
ones was deemed too heavy for this milestone.
