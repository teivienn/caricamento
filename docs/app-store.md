# App Store Connect / TestFlight

caricamento builds an `.ipa` with Xcode (`xcodebuild archive` +
`-exportArchive`), signs it, uploads it to App Store Connect and distributes it
to TestFlight beta groups. Native Xcode projects and React Native (project in
`ios/`) are supported.

> **Status:** the iOS build, signing and App Store Connect publisher are
> implemented and covered by unit tests with mocked APIs, but **have not yet
> been verified end to end against a real Apple Developer account**. Unsigned
> local builds are verified. Expect rough edges on the first real run and see
> [the checklist below](#first-real-account-run).

## What you need

| Item | Why | Paid account ($99/year)? |
|---|---|---|
| macOS + full Xcode (`sudo xcode-select -s /Applications/Xcode.app`) | `xcodebuild`, `security`, `codesign` | No |
| Unsigned build (`signing.mode: 'none'`) | Check that the project builds | **No** |
| Apple Distribution certificate + App ID | Signed `.ipa` | Yes (Apple Developer Program) |
| App record in App Store Connect | TestFlight, auto-increment from ASC | Yes |
| App Store Connect API key (`.p8`) | Automatic signing without an Xcode login, upload, TestFlight | Yes |
| CocoaPods (`pod install` in `ios/`) | React Native | No (you run it; caricamento does not) |

**Works locally without an account:** `build --platform ios` with
`signing.mode: 'none'` (unsigned archive → unsigned `.ipa` + dSYMs), `doctor`,
`detect`, and `--dry-run` of any command. Anything that signs or talks to App
Store Connect needs a paid account.

## 1. Apple Developer account and App ID

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/).
2. Note your **Team ID** (10 characters) under
   [developer.apple.com/account](https://developer.apple.com/account) →
   Membership details. It becomes `ios.signing.teamId`.
3. Register an **App ID** with your bundle ID (e.g. `com.example.app`) under
   Certificates, Identifiers & Profiles → Identifiers. With automatic signing,
   Xcode can create it for you.

## 2. Create the app record in App Store Connect

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** →
**+** → **New App**: platform iOS, name, primary language, the bundle ID from
step 1, and a SKU. caricamento cannot create the app record; uploads fail with
`No app with bundle ID ...` until it exists.

## 3. Create an App Store Connect API key

1. App Store Connect → **Users and Access** → **Integrations** → **App Store
   Connect API** → **Team Keys** → **Generate API Key**. Role **App Manager**
   is enough for upload and TestFlight; automatic signing that creates
   certificates/profiles may need **Admin**.
2. Download `AuthKey_<KEY_ID>.p8`. It can be downloaded **only once**.
3. Note the **Key ID** (in the key's row) and the **Issuer ID** (above the
   table).
4. Store the key:

```bash
caricamento secrets set asc/private-key   # path to AuthKey_XXXX.p8 (or the PEM itself)
```

## 4. Prepare the Xcode project

- The scheme must be **Shared** (Xcode → Product → Scheme → Manage Schemes →
  *Shared*), i.e. present in `xcshareddata/xcschemes`.
- Info.plist must use `$(MARKETING_VERSION)` and `$(CURRENT_PROJECT_VERSION)`
  (the default in Xcode 13+ and React Native templates) so caricamento can set
  the version at build time.
- Add `ITSAppUsesNonExemptEncryption = NO` to Info.plist if applicable;
  otherwise TestFlight shows "Missing Compliance" until you answer the export
  compliance question in App Store Connect (caricamento warns about this but
  does not declare it via the API).
- React Native: run `pod install` in `ios/` and point `ios.workspace` at the
  `.xcworkspace`.

## 5. Configure

```typescript
export default {
  project: { type: 'ios' },             // or 'react-native' / 'auto'

  ios: {
    project: 'App.xcodeproj',           // exactly one of project / workspace
    // workspace: 'App.xcworkspace',    // CocoaPods / React Native
    scheme: 'App',
    configuration: 'Release',
    destination: 'generic/platform=iOS',
    signing: {
      mode: 'automatic',                // automatic | manual | none
      method: 'app-store',              // app-store | ad-hoc | development | enterprise
      teamId: 'ABCDE12345',
      bundleId: 'com.example.app',      // optional PRODUCT_BUNDLE_IDENTIFIER override
      // automatic: optional; falls back to targets.appstore, then Xcode accounts
      // apiKeyRef: 'secret:asc/private-key', keyId: '...', issuerId: '...',
    },
  },

  version: { strategy: 'auto-increment', name: '1.4.0' }, // source defaults to appstore

  targets: {
    appstore: {
      apiKeyRef: 'secret:asc/private-key',
      keyId: 'XYZ123ABCD',
      issuerId: '69a6de7e-0000-0000-0000-000000000000',
      bundleId: 'com.example.app',
      distributeTo: 'testflight',
      betaGroups: ['QA'],
      whatToTest: 'Check the login screen',
      locale: 'en-US',
      upload: 'api',                    // api | altool
      processingTimeoutMinutes: 30,
    },
  },
};
```

A version name is required for publishing: App Store Connect needs a
`CFBundleShortVersionString`. Set `version.name` in the config or pass
`release --version <name>`.

### Configuration reference

**`ios` block**

| Field | Type | Default | Description |
|---|---|---|---|
| `project` / `workspace` | string | — | **Exactly one.** Resolved from `<root>/ios` (React Native) or the project root |
| `scheme` | string | — | **Required.** Must be a shared scheme |
| `configuration` | string | `Release` | Build configuration |
| `destination` | string | `generic/platform=iOS` | `-destination` for the archive |
| `signing.mode` | `automatic` \| `manual` \| `none` | `automatic` | See [signing.md](signing.md#ios) |
| `signing.method` | `app-store` \| `ad-hoc` \| `development` \| `enterprise` | `app-store` | Export method |
| `signing.teamId` | string | — | `DEVELOPMENT_TEAM` and export `teamID`; compared with the signed `.ipa` |
| `signing.bundleId` | string | — | `PRODUCT_BUNDLE_IDENTIFIER` override (usually via a [variant](variants.md)) |
| `signing.apiKeyRef` / `keyId` / `issuerId` | secret / string | — | Automatic signing API key; all three together |
| `signing.certificateRef` | `secret:<name>` | — | Manual: `.p12` (path or base64) |
| `signing.certificatePasswordRef` | `secret:<name>` | — | Required with `certificateRef` |
| `signing.profileRefs` | `secret:<name>[]` | — | **Required for manual.** `.mobileprovision` (path or base64) |

**`targets.appstore` block**

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKeyRef` | `secret:<name>` | — | **Required.** `.p8` (path or PEM) |
| `keyId` / `issuerId` | string | — | **Required.** From Users and Access → Integrations |
| `bundleId` | string | — | **Required.** Must match the app record and the `.ipa`'s Info.plist |
| `distributeTo` | `testflight` \| `appstore` | `testflight` | `appstore` (review submission) is not implemented and fails with a validation error |
| `betaGroups` | string[] | `[]` | TestFlight group names, checked **before** upload |
| `whatToTest` | string | — | "What to Test"; overridden by `--release-notes`, falls back to the [git changelog](changelog.md) |
| `locale` | string | `en-US` | Locale of "What to Test" |
| `upload` | `api` \| `altool` | `api` | Binary upload mechanism |
| `processingTimeoutMinutes` | number | `30` | How long to wait for processing |

## Signing: automatic vs manual

- **Automatic** is the easiest start: with the API key, Xcode creates and
  updates certificates and profiles via `-allowProvisioningUpdates`; no Xcode
  login needed.
- **Manual** is for CI with a fixed Apple Distribution certificate (`.p12`) and
  App Store provisioning profiles, imported into a temporary keychain and
  cleaned up after the build.

Details: [signing.md](signing.md#ios).

## The TestFlight flow

`caricamento release --platform ios --targets appstore` (alias `asc`):

1. Build and sign the `.ipa`, verify the signature (`codesign`, Team ID).
2. Look up the app by `bundleId` and resolve the TestFlight groups; a typo in a
   group name fails immediately, not after the processing wait.
3. If a build with the same `CFBundleVersion` already exists, the upload is
   skipped (re-runs are safe).
4. Upload the binary:
   - `upload: 'api'` — App Store Connect Build Uploads API
     (`POST /v1/buildUploads` → `POST /v1/buildUploadFiles` → PUT parts to
     presigned URLs → `PATCH /v1/buildUploadFiles/{id}`); no Xcode needed at
     upload time;
   - `upload: 'altool'` — `xcrun altool --upload-app` with the same API key.
5. Wait for processing until `VALID` (polls every 30 s, bounded by
   `processingTimeoutMinutes`); `FAILED` / `INVALID` fail with Apple's details.
6. Set "What to Test" (`--release-notes` → `whatToTest` → git changelog).
7. Add the build to each group in `betaGroups`.

The result includes a link to the app's TestFlight page in App Store Connect.

Upload an existing `.ipa` without building:

```bash
caricamento upload --target appstore --artifact build/caricamento/ipa/App.ipa
```

## Not implemented yet

- App Store review submission (`distributeTo: 'appstore'`)
- Beta App Review submission for external groups (the build is added to the
  group; start the review manually in App Store Connect)
- Declaring export compliance through the API
- Running `pod install` automatically
- Extension-safe bundle ID overrides (`PRODUCT_BUNDLE_IDENTIFIER` applies to
  every target in the scheme)

See [roadmap.md](roadmap.md).

## Local unsigned build (no account)

Set `ios.signing.mode: 'none'` and build:

```bash
caricamento doctor
caricamento build --platform ios     # → build/caricamento/ipa/<Scheme>.ipa + dSYMs
```

The repository fixture does this out of the box:

```bash
cd fixtures/ios-native
node ../../dist/cli/index.js doctor
node ../../dist/cli/index.js build --platform ios   # → build/caricamento/ipa/CaricamentoFixture.ipa
```

## First real-account run

Once the account, app record and API key exist, go step by step:

```bash
# 1. Store the key and verify credentials
caricamento secrets set asc/private-key
caricamento doctor myapp                     # expect "app store connect key" OK

# 2. See the plan without executing anything
caricamento release myapp --platform ios --targets appstore --dry-run --verbose

# 3. Signed build only (no upload)
caricamento build myapp --platform ios --verbose

# 4. Upload the .ipa from step 3 to TestFlight
caricamento upload myapp --target appstore --verbose

# 5. Full pipeline
caricamento release myapp --platform ios --targets appstore --verbose
```

If something fails, `caricamento status <runId>` and
`~/.caricamento/runs/<runId>.jsonl` contain the full xcodebuild output and
App Store Connect error bodies.

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `xcodebuild not found` / `requires Xcode` | Only Command Line Tools installed: `sudo xcode-select -s /Applications/Xcode.app` |
| `scheme ... is not currently configured` | Scheme not shared: Manage Schemes → *Shared* |
| `No profiles for '...' were found` / `SigningError` | Automatic: check `teamId` and the API key role; manual: the profile does not match the bundle ID or certificate |
| Version in the archive does not match | Info.plist hardcodes values; use `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` |
| ASC `401` | Wrong `keyId` / `issuerId`, or the key was revoked |
| `No app with bundle ID ...` | App record missing or `targets.appstore.bundleId` differs |
| Upload `FAILED` / `already been used` | `CFBundleVersion` was already uploaded; use `auto-increment` |
| TestFlight "Missing Compliance" | Add `ITSAppUsesNonExemptEncryption = NO` to Info.plist or answer in App Store Connect |
