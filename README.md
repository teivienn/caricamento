# caricamento

**caricamento** builds, signs and publishes Android and iOS apps in one command:
Firebase App Distribution, Google Play (including Internal App Sharing) and
App Store Connect / TestFlight. It talks to the store APIs over REST and injects
signing and versioning without editing project files. Works with native Android,
native iOS, React Native CLI and Expo (bare / prebuilt).

TestFlight upload is implemented and unit-tested. It has not been verified
against a real Apple Developer account. Unsigned iOS builds do not need one.

## Requirements

- macOS (Keychain secrets and iOS builds are macOS-only)
- Node.js >= 20
- Android: JDK 17, Android SDK (`ANDROID_HOME`) and a Gradle wrapper in the project
- iOS: full Xcode, not Command Line Tools

`caricamento doctor` checks the toolchain and credentials.

## Install

```bash
npm install -g caricamento
```

Release history: [CHANGELOG.md](CHANGELOG.md).

## Quickstart

Register the app once. The config stays in `~/.caricamento/projects/`, outside
the app repo:

```bash
caricamento projects add myapp --path ~/work/myapp
# edit ~/.caricamento/projects/myapp.config.ts

caricamento secrets set android/keystore-path
caricamento secrets set android/keystore-password
caricamento secrets set android/key-password
caricamento secrets set play/service-account

caricamento doctor myapp
caricamento release myapp --dry-run
caricamento release myapp
```

To keep the config in the repo, run `caricamento init` in the project root and
omit the project name.

In CI, the same config reads secrets from environment variables
(`secret:android/keystore-password` → `ANDROID_KEYSTORE_PASSWORD`). See
[Secrets](docs/secrets.md).

## Commands

| Command | Purpose |
|---|---|
| `caricamento init` | Write `caricamento.config.ts` in the current directory |
| `caricamento projects add\|list\|remove` | Manage the project registry |
| `caricamento secrets set\|get\|delete\|list` | Manage secrets in the macOS Keychain |
| `caricamento doctor [project]` | Check the toolchain and credentials |
| `caricamento detect [project]` | Show the detected project type and paths |
| `caricamento build [project]` | Build a signed APK, AAB or IPA |
| `caricamento upload [project]` | Upload an existing artifact |
| `caricamento release [project]` | Build, sign and publish |
| `caricamento apk [project]` | Convert an AAB into a universal APK |
| `caricamento runs` / `status <runId>` | Run history and a single run summary |

Flags that work on every command: `--config <path>`, `--verbose`, `--json`,
`--dry-run`. Full reference: [Commands](docs/commands.md).

## Documentation

- [Commands](docs/commands.md) — flags, defaults, exit codes
- [Configuration](docs/configuration.md) — `caricamento.config.ts` and the registry
- [Signing](docs/signing.md) — Android and iOS
- [Versioning](docs/versioning.md)
- [Build variants](docs/variants.md) — qa / prod
- [Secrets](docs/secrets.md) — env vars, Keychain, `.env`
- [Firebase App Distribution](docs/firebase.md)
- [Google Play](docs/google-play.md)
- [Internal App Sharing](docs/internal-app-sharing.md)
- [App Store Connect / TestFlight](docs/app-store.md)
- [AAB → APK](docs/apk.md)
- [Release notes from git](docs/changelog.md)
- [Roadmap](docs/roadmap.md)

Development setup and review rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
