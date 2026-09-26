# caricamento

**caricamento** is a command-line tool that takes a mobile app from source to
testers in one command: it builds, signs, verifies and publishes Android and
iOS releases to Firebase App Distribution, Google Play and App Store Connect /
TestFlight. It talks to the store APIs directly over REST (no `firebase-tools`,
`googleapis` or fastlane), injects signing and versioning without modifying
your project files, and can run from a central "command center" so the target
project stays untouched. Works with native Android, native iOS, React Native
CLI and Expo (bare / prebuilt) projects.

## Status

| Area | State | Notes |
|---|---|---|
| Android build + signing (Gradle init script or `-P` properties) | Implemented | Post-build signature and SHA-256 verification |
| Firebase App Distribution | Implemented | Upload, release notes, groups/testers, Android and iOS |
| Google Play | Implemented | AAB, tracks, draft/completed, `mapping.txt`, auto-increment versionCode |
| Idempotent re-runs | Implemented | Firebase, Play and App Store Connect detect already-uploaded builds |
| Release notes from git | Implemented | Commits since the last tag |
| Internal App Sharing (`playsharing`) | Implemented | Requires a one-time Terms of Service acceptance in Play Console |
| AAB → universal APK (`caricamento apk`) | Implemented | Via bundletool, auto-downloaded if missing |
| Project registry + macOS Keychain secrets | Implemented | |
| Build variants (qa/prod) with applicationId / bundle ID injection | Implemented | |
| iOS archive/export, automatic/manual signing, unsigned local builds | Implemented | Unsigned builds work without an Apple account |
| App Store Connect / TestFlight publisher | Implemented | Build Uploads API or altool, beta groups, What to Test |
| iOS publishing end to end | Partial | Implemented and unit-tested, **not yet verified against a real Apple Developer account** |
| Internal App Sharing upload | Partial | Code path implemented; live verification blocked until the TOS is accepted |
| `auto-increment` from App Store Connect | Partial | Implemented, not tested live |
| App Store review submission, staged rollout | Not yet | |
| Slack / Telegram notifications, tester management API | Not yet | |
| Localized Play release notes, semver bump, pre-build hooks | Not yet | |
| Store listing / reviews APIs | Not yet | |

The full backlog is in [docs/roadmap.md](docs/roadmap.md).

## Requirements

- macOS (primary platform; Keychain and iOS builds are macOS-only)
- Node.js >= 20
- Android: JDK 17, Android SDK (`ANDROID_HOME`), a Gradle wrapper in the project
- iOS: full Xcode (not just Command Line Tools)

Run `caricamento doctor` to check your environment.

## Install

The package is not published to npm yet. Once it is, install it with:

```bash
npm install -g caricamento
```

Until then, install from source:

```bash
git clone https://github.com/teivienn/caricamento.git
cd caricamento
npm install
npm run build
npm link        # makes the `caricamento` command available globally
```

## Quickstart

Register a project once; its config lives in `~/.caricamento/projects/`, not in
your repo:

```bash
caricamento projects add myapp --path ~/work/myapp
# edit ~/.caricamento/projects/myapp.config.ts (a starter config is generated)

caricamento secrets set android/keystore-path       # hidden prompt, stored in Keychain
caricamento secrets set android/keystore-password
caricamento secrets set android/key-password
caricamento secrets set play/service-account        # path to the service account JSON

caricamento doctor myapp                            # check toolchain and credentials
caricamento release myapp --dry-run --verbose       # show the plan, execute nothing
caricamento release myapp                           # build, sign, verify, publish
```

Prefer a config inside the project? Run `caricamento init` in the project root
and use the commands without a project name.

## Documentation

- [Commands](docs/commands.md) — every command, flag, default and exit code
- [Configuration](docs/configuration.md) — `caricamento.config.ts`, secret refs, registry mode
- [Signing](docs/signing.md) — Android init script vs properties; iOS automatic / manual / unsigned
- [Versioning](docs/versioning.md) — manual, timestamp, auto-increment and version sources
- [Build variants](docs/variants.md) — qa/prod, applicationId injection, `--variant all`
- [Secrets](docs/secrets.md) — env vars, Keychain, `.env` files
- [Firebase App Distribution](docs/firebase.md)
- [Google Play](docs/google-play.md)
- [Internal App Sharing](docs/internal-app-sharing.md)
- [App Store Connect / TestFlight](docs/app-store.md)
- [AAB → APK](docs/apk.md)
- [Release notes from git](docs/changelog.md)
- [Roadmap](docs/roadmap.md)

## Commands

| Command | Purpose |
|---|---|
| `caricamento init` | Generate `caricamento.config.ts` in the current directory |
| `caricamento projects add\|list\|remove` | Manage the project registry |
| `caricamento secrets set\|get\|delete\|list` | Manage secrets in the macOS Keychain |
| `caricamento doctor [project]` | Check the toolchain and credentials |
| `caricamento detect [project]` | Show the detected project type and paths |
| `caricamento build [project]` | Build a signed APK / AAB / IPA |
| `caricamento upload [project] --target <t>` | Upload an existing artifact to one target |
| `caricamento release [project]` | Build, sign and publish in one run |
| `caricamento apk [project]` | Convert an AAB into a universal APK |
| `caricamento runs` / `caricamento status <runId>` | Run history and run summaries |

Global flags: `--config <path>`, `--verbose`, `--json`, `--dry-run`. Full
reference: [docs/commands.md](docs/commands.md).

## CI

Every secret can come from an environment variable (`secret:android/keystore-password`
→ `ANDROID_KEYSTORE_PASSWORD`), so the same config works in CI:

```bash
export ANDROID_KEYSTORE_PATH=$RUNNER_TEMP/upload.keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_PASSWORD=...
export GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/firebase-sa.json

caricamento release --platform android --targets firebase --json
```

## Development

```bash
npm install
npm test            # vitest; no Android SDK, Xcode or store accounts needed
npm run typecheck
npm run lint        # eslint, including architecture layer-boundary rules
npm run build       # tsup -> dist/
```

`fixtures/` contains real projects for manual end-to-end runs — see
[fixtures/README.md](fixtures/README.md).

## License

[MIT](LICENSE)
