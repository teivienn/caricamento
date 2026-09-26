# Versioning

caricamento sets the build number (Android `versionCode`, iOS
`CFBundleVersion`) and optionally the version name (Android `versionName`, iOS
`CFBundleShortVersionString`) at build time, without editing project files.

```typescript
version: {
  strategy: 'auto-increment', // manual (default) | timestamp | auto-increment
  source: 'play',             // auto-increment only: play | appstore | firebase
  buildNumber: 42,            // manual only
  name: '1.4.0',              // versionName / CFBundleShortVersionString
},
```

## Strategies

| Strategy | Android versionCode | iOS CFBundleVersion |
|---|---|---|
| `manual` (default) | `--build <n>`, else `version.buildNumber` | same |
| `timestamp` | Unix time in seconds | `YYYYMMDDHHMM` (UTC) |
| `auto-increment` | highest existing build number + 1 | same |

`manual` fails with a validation error if neither `--build` nor
`version.buildNumber` is set. `--build` is ignored by the other strategies.

## auto-increment sources

`auto-increment` asks a store API for the current highest build number and adds
one (the first build is `1`).

| Source | What is queried |
|---|---|
| `play` | Highest versionCode across all Play tracks (the source of truth for Android) |
| `appstore` | Highest numeric `CFBundleVersion` among the app's builds in App Store Connect; non-numeric values such as `1.2.3` are ignored |
| `firebase` | Highest `buildVersion` among releases uploaded to Firebase App Distribution (sees only builds uploaded there) |

How the source is chosen:

1. An explicit `version.source` always wins, on any platform (e.g. to share one
   numbering between Android and iOS). The matching target must be configured,
   otherwise a config error is raised.
2. Otherwise, by priority **play > appstore > firebase**, among configured
   targets native to the platform being built: `targets.play` for Android,
   `targets.appstore` for iOS, `targets.firebase` for both.

Defaults in practice:

| Platform | Configured targets | Source |
|---|---|---|
| Android | `play` (+ anything) | `play` |
| Android | `firebase` only | `firebase` |
| iOS | `appstore` (+ anything) | `appstore` |
| iOS | `firebase` only | `firebase` |

If nothing applicable is configured, the run fails with a hint to configure a
target or change `version.source`.

> The `appstore` source is implemented and unit-tested but has not yet been
> exercised against a live App Store Connect account.

## versionName

The version name is never computed: it comes from `version.name` in the
config. The CLI flag `--version <name>` is meant to override it, but is
currently shadowed by the global `--version` flag (see the known issue in
[commands.md](commands.md#global-options)), so use `version.name`.

To follow `package.json`, read it in the config via
[`CARICAMENTO_PROJECT_DIR`](configuration.md#caricamento_project_dir).

## How versions are applied

- **Android**: through the generated Gradle init script, or as
  `-PCARICAMENTO_VERSION_CODE` / `-PCARICAMENTO_VERSION_NAME` in `properties`
  mode (see [signing.md](signing.md#android)).
- **iOS**: passed to `xcodebuild archive` as `CURRENT_PROJECT_VERSION` and
  `MARKETING_VERSION`. Your Info.plist must reference
  `$(CURRENT_PROJECT_VERSION)` / `$(MARKETING_VERSION)` (the default in Xcode
  13+ and React Native templates). After archiving, caricamento checks the
  values in the archive and fails with a hint if they were not applied.

Re-running with the same build number is safe: already-uploaded builds are
detected and skipped (see [google-play.md](google-play.md#idempotent-re-runs),
[firebase.md](firebase.md#idempotent-re-runs), [app-store.md](app-store.md)).
There is no `--force`; to re-upload, bump the build number.
