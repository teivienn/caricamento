# Roadmap

## Shipped

- Android build and signing (Gradle init script or `-P` properties), with signature and SHA-256 checks after the build
- iOS archive and export: automatic signing, manual signing, and unsigned local builds (no Apple account)
- Firebase App Distribution for Android and iOS: upload, release notes, groups and testers
- Google Play: AAB, tracks, draft or completed releases, `mapping.txt`, versionCode auto-increment
- Idempotent re-runs: Firebase, Play and App Store Connect skip a build that is already uploaded
- Release notes from git (commits since the last tag)
- Internal App Sharing (`playsharing`). Needs a one-time Terms of Service acceptance in Play Console; a live upload is not verified until then
- AAB → universal APK (`caricamento apk`) via bundletool
- Project registry, macOS Keychain secrets, and qa/prod variants with applicationId / bundle ID injection
- App Store Connect / TestFlight publisher (Build Uploads API or altool, beta groups, What to Test). Unit-tested, not yet verified against a real Apple Developer account. `auto-increment` from App Store Connect is in the same state

## Not yet

### Distribution

- **Notifications** — post release results (links, version, notes) to Slack and
  Telegram.
- **Tester management API** — add / remove testers and groups in Firebase App
  Distribution and TestFlight from the CLI.
- **Track promotion** — promote an existing Play build between tracks (e.g.
  internal → production) as a first-class command, without rebuilding.
- **Staged rollout** — percentage rollouts on the Play production track
  (`userFraction`), with halt / resume / complete.
- **Several Play tracks in one run.**
- **Localized release notes** — per-locale Play "What's new" (today only
  `en-US`).

### iOS

- **App Store review submission** — `targets.appstore.distributeTo: 'appstore'`
  (currently rejected with a validation error).
- **Beta App Review** for external TestFlight groups.
- **Export compliance** declaration through the API.
- **`pod install` automation** for React Native / CocoaPods projects.
- **Extension-safe bundle IDs** — per-target bundle ID overrides instead of a
  scheme-wide `PRODUCT_BUNDLE_IDENTIFIER`.
- **Live verification** of the App Store Connect publisher and the `appstore`
  auto-increment source against a real account.

### Build pipeline

- **Semver bump** — compute versionName (patch / minor / major) instead of
  setting it manually.
- **Pre-build hooks** — run commands before the build (e.g. `expo prebuild`,
  codegen, asset generation).
- **Flutter builds** — detection exists, building does not.
- **`doctor` credential probe** — actually call each store API with the
  configured credentials instead of only resolving the secrets.

### Store management

- **Store listing API** — descriptions, screenshots and metadata.
- **Reviews API** — read and reply to store reviews.
- **In-app purchases** — manage products and subscriptions.
- **Retention** — clean up old builds / releases and old run journals.

### Longer term

- Local HTTP API and UI on top of the same core.
