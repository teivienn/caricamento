# Signing

## Android

```typescript
android: {
  signing: {
    injection: 'init-script', // default; or 'properties'
    keystoreRef: 'secret:android/keystore-path',
    keystorePasswordRef: 'secret:android/keystore-password',
    keyAlias: 'upload',
    keyPasswordRef: 'secret:android/key-password',
    expectedCertificateSha256: 'F4:40:2B:55:...', // optional
  },
},
```

| Field | Required | Description |
|---|---|---|
| `keystoreRef` | yes | Secret resolving to the keystore file path |
| `keystorePasswordRef` | yes | Keystore password |
| `keyAlias` | yes | Key alias (plain string) |
| `keyPasswordRef` | yes | Key password |
| `injection` | no | `init-script` (default) or `properties` |
| `expectedCertificateSha256` | no | Expected signer SHA-256 fingerprint, checked after the build |

After every build the signature is verified: APKs with `apksigner verify`,
AABs with `jarsigner` / `keytool`. If `expectedCertificateSha256` is set, the
signer fingerprint must match, otherwise the run fails with a signing error
(exit code 4).

### `init-script` (default)

caricamento generates a Gradle init script that overrides the release build
type's `signingConfig`, the version (and optionally the applicationId, see
[variants.md](variants.md)) from outside, then runs `./gradlew -I <script>`.
**The project is not modified at all**: it works with vanilla React Native and
Expo templates and survives regenerating `android/` (e.g.
`expo prebuild --clean`).

The script contains passwords in plain text, so it is written to a temporary
file with mode `0600` and deleted right after the build.

### `properties`

Signing and versioning are passed as Gradle properties and the project's
`build.gradle` must read them itself:

| Property | Value |
|---|---|
| `CARICAMENTO_STORE_FILE` | Keystore path |
| `CARICAMENTO_STORE_PASSWORD` | Keystore password |
| `CARICAMENTO_KEY_ALIAS` | Key alias |
| `CARICAMENTO_KEY_PASSWORD` | Key password |
| `CARICAMENTO_VERSION_CODE` | versionCode |
| `CARICAMENTO_VERSION_NAME` | versionName |
| `CARICAMENTO_APPLICATION_ID` | applicationId (variants) |

Use this if you prefer explicit configuration in the project. A working
example is `fixtures/android-native/app/build.gradle`.

### Creating an upload keystore

```bash
keytool -genkeypair -v -keystore upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore and its passwords outside the repository. With Play App
Signing enabled, this key is only your upload key.

## iOS

`ios.signing.mode` selects one of three modes.

| Mode | Use case | Apple account |
|---|---|---|
| `automatic` (default) | Local builds, getting started | Paid Apple Developer Program |
| `manual` | CI with a fixed certificate and profiles | Paid Apple Developer Program |
| `none` | Verify the project builds; unsigned `.ipa` | Not needed |

### `automatic`

Runs `xcodebuild -allowProvisioningUpdates` so Xcode creates or updates
certificates and profiles. If an App Store Connect API key is available
(`ios.signing.apiKeyRef` / `keyId` / `issuerId`, or falling back to
`targets.appstore`), it is passed via `-authenticationKeyPath`,
`-authenticationKeyID` and `-authenticationKeyIssuerID`; the `.p8` is written
to a temporary `0600` file and deleted afterwards. Without a key, the accounts
signed in to Xcode → Settings → Accounts are used.

### `manual`

- `certificateRef` (optional): a `.p12` as a file path or base64. It is
  imported into a **temporary keychain** (`security create-keychain` →
  `import` → `set-key-partition-list` → added to the search list). Without it,
  identities already in your keychain are used.
- `certificatePasswordRef`: required together with `certificateRef`.
- `profileRefs` (required): `.mobileprovision` files as paths or base64. They
  are decoded (`security cms -D`), checked (expiry, bundle ID) and installed
  into the Provisioning Profiles directory.

`exportOptions.plist` gets `provisioningProfiles` (bundle ID → UUID) and the
certificate's SHA-1. After the build everything is rolled back: the keychain
search list is restored, and the temporary keychain and installed profiles are
removed. In CI, pass files as base64 env vars:

```bash
export IOS_CERTIFICATE=$(base64 -i dist.p12)
export IOS_CERTIFICATE_PASSWORD=...
export IOS_PROFILE_APP=$(base64 -i App.mobileprovision)
```

```typescript
signing: {
  mode: 'manual',
  teamId: 'ABCDE12345',
  certificateRef: 'secret:ios/certificate',
  certificatePasswordRef: 'secret:ios/certificate-password',
  profileRefs: ['secret:ios/profile-app'],
},
```

### `none`

Builds with `CODE_SIGNING_ALLOWED=NO` and packages the `.app` into an unsigned
`.ipa` (plus dSYMs) without `-exportArchive`. Useful to check that a project
builds on a machine without an Apple account. `release` to `appstore` is
rejected in this mode.

### Verification

After export, the `.ipa` is checked with `codesign --verify --deep --strict`
and its TeamIdentifier is compared with `signing.teamId`.

The export method (`signing.method`: `app-store`, `ad-hoc`, `development`,
`enterprise`) is written to `exportOptions.plist` using the current Xcode names
(`app-store-connect`, `release-testing`, `debugging`, `enterprise`).

See [app-store.md](app-store.md) for the full iOS setup.
