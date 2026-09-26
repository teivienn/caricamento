# Command reference

```
caricamento [global options] <command> [project] [options]
```

Most commands take an optional `[project]` argument. Without it, the current
directory is the project and `caricamento.config.ts` is read from it. With it,
the project is looked up in the registry (see [projects](#projects) and
[configuration](configuration.md#where-the-config-comes-from)).

## Global options

| Flag | Default | Description |
|---|---|---|
| `--config <path>` | — | Explicit path to a config file (relative paths resolve from the current directory) |
| `--verbose` | `false` | Stream step logs (Gradle, xcodebuild, API calls) to the terminal |
| `--json` | `false` | Machine-readable output; errors are written to stderr as `{"error": {...}}` |
| `--dry-run` | `false` | Print the plan (steps, Gradle/xcodebuild commands, targets) without executing |
| `-V`, `--version` | — | Print the caricamento version |
| `-h`, `--help` | — | Help for the program or a command |

Global options can be placed before or after the command name.

> **Known issue:** because the program-level `--version` flag is recognized
> anywhere on the command line, `build --version <name>` and
> `release --version <name>` currently print the caricamento version and exit
> instead of overriding versionName. Set `version.name` in the config instead
> (see [versioning](versioning.md#versionname)).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unexpected error; also a failing `doctor` check or `status` of a failed run |
| `2` | Validation error (bad flags, missing build number, unknown target or group, ...) |
| `3` | Build error (Gradle / xcodebuild) |
| `4` | Signing error (keystore, certificates, profiles, signature verification) |
| `5` | Upload / publish error (store API failures) |
| `6` | Configuration error (missing or invalid config, unregistered project) |

With `--variant all`, the exit code is that of the first failed variant.

## init

```
caricamento init [--force]
```

Writes a commented `caricamento.config.ts` template to the current directory.

| Flag | Default | Description |
|---|---|---|
| `--force` | `false` | Overwrite an existing `caricamento.config.ts` |

To keep the project clean, use `projects add` instead: it stores the config in
`~/.caricamento/projects/`.

## projects

Manages the registry at `~/.caricamento/registry.json`.

```
caricamento projects add <name> --path <dir> [--config <path>]
caricamento projects list
caricamento projects remove <name>
```

| Subcommand | Description |
|---|---|
| `add <name>` | Register a project. `--path <dir>` (required) is the project root; `--config <path>` stores an explicit config path in the entry. If no config exists (neither `--config`, nor `~/.caricamento/projects/<name>.config.ts`, nor `<dir>/caricamento.config.ts`), a starter config is created at `~/.caricamento/projects/<name>.config.ts`. The detected project type is printed. |
| `list` | List registered projects (name, path, explicit config). Honors `--json`. |
| `remove <name>` | Remove the entry. The project and its config file are not touched. |

## secrets

Manages secrets in the macOS login Keychain (service `caricamento/<name>`).
See [secrets.md](secrets.md).

```
caricamento secrets set <name> [--value <value>]
caricamento secrets get <name>
caricamento secrets delete <name>
caricamento secrets list
```

| Subcommand | Description |
|---|---|
| `set <name>` | Store a secret. Prompts without echo; `--value <value>` sets it non-interactively (visible in shell history). Empty values are rejected. |
| `get <name>` | Print the value to stdout. Exit code 2 if not found. |
| `delete <name>` | Remove the secret. Exit code 2 if not found. |
| `list` | List secret names, never values. Honors `--json`. |

`<name>` may be given with or without the `secret:` prefix.

## doctor

```
caricamento doctor [project]
```

Checks the environment and, when a config is found, the credentials it
references. Works without a config too.

Checks: `java`, `gradle wrapper` (`./gradlew` or `./android/gradlew`),
`apksigner` (PATH or `$ANDROID_HOME/build-tools`), `firebase credentials`
(`serviceAccountRef` or `GOOGLE_APPLICATION_CREDENTIALS`), `xcode`,
`codesign identities`, and `app store connect key` when `targets.appstore` is
configured. iOS checks only fail (instead of warn) when the config has an `ios`
block. Exit code `1` if any check fails. Honors `--json`.

## detect

```
caricamento detect [project]
```

Prints the detected project type, platforms and root / `ios` / `android`
paths. Works without a config. Honors `--json`.

| Type | Detected by |
|---|---|
| Native Android | `settings.gradle` |
| Native iOS | `*.xcodeproj` / `*.xcworkspace` |
| React Native CLI | `package.json` + `android/` (builds run in `android/` / `ios/`) |
| Expo (bare / prebuilt) | same + `app.json` |
| Flutter | `pubspec.yaml` (detection only; building is not supported yet) |

Expo managed projects (no `android/`) need a one-time
`npx expo prebuild --platform android`.

## build

```
caricamento build [project] [--platform android|ios] [--artifact-type apk|aab]
                  [--variant <name>|all] [--build <n>] [--version <name>]
```

Builds and signs an artifact, then verifies the signature. Nothing is uploaded.

| Flag | Default | Description |
|---|---|---|
| `--platform <p>` | `android` | `android` or `ios` |
| `--artifact-type <t>` | `apk` | `apk` or `aab` (Android only; iOS always produces an `.ipa`) |
| `--variant <name>` | — | Build variant from the config; `all` runs every variant ([variants.md](variants.md)) |
| `--build <n>` | — | versionCode / CFBundleVersion; used by the `manual` strategy only |
| `--version <name>` | — | versionName / CFBundleShortVersionString (see the known issue above) |

iOS outputs go to `build/caricamento/ipa/` (dSYMs alongside).

## upload

```
caricamento upload [project] --target <target> [--artifact <path>]
                   [--artifact-type apk|aab] [--platform android|ios]
                   [--variant <name>|all] [--release-notes <text>]
```

Uploads an existing artifact to one target without building.

| Flag | Default | Description |
|---|---|---|
| `--target <t>` | required | `firebase`, `play`, `playsharing`, `appstore` (alias `asc`) |
| `--artifact <path>` | newest build output | Artifact to upload |
| `--artifact-type <t>` | `aab` for `play`, else `apk`; `ipa` on iOS | Which build output to pick when `--artifact` is omitted |
| `--platform <p>` | `ios` for `appstore` or an `.ipa` artifact, else `android` | Platform |
| `--variant <name>` | — | Build variant from the config; `all` runs every variant |
| `--release-notes <text>` | — | Release notes / TestFlight "What to Test" override |

## release

```
caricamento release [project] [--platform android|ios] [--targets <list>]
                    [--artifact-type apk|aab] [--variant <name>|all]
                    [--build <n>] [--version <name>] [--release-notes <text>]
```

Build → sign → verify → publish to every target in one run.

| Flag | Default | Description |
|---|---|---|
| `--platform <p>` | `android` | `android` or `ios` |
| `--targets <list>` | all configured targets usable on the platform | Comma-separated: `firebase`, `play`, `playsharing`, `appstore` (alias `asc`) |
| `--artifact-type <t>` | `apk` | Android only. Forced to `aab` when `play` is among the targets |
| `--variant <name>` | — | Build variant; `all` runs every variant |
| `--build <n>` | — | versionCode / CFBundleVersion (`manual` strategy) |
| `--version <name>` | — | versionName (see the known issue above) |
| `--release-notes <text>` | — | Overrides target `releaseNotes` / `whatToTest` and the git changelog |

Default targets: Android — `firebase`, `play`, `playsharing`; iOS — `appstore`,
`firebase` (only those configured). Releasing to `appstore` with
`ios.signing.mode: 'none'` is rejected.

Examples:

```bash
caricamento release --platform android --targets firebase --dry-run --verbose
caricamento release myapp --targets firebase,play
caricamento release myapp --release-notes "Fix crash on launch"
caricamento release myapp --platform ios --targets appstore
caricamento release myapp --variant all
```

## apk

```
caricamento apk [project] [--artifact <aab>] [--out <apk>]
```

Converts an AAB into a universal APK via bundletool. See [apk.md](apk.md).

| Flag | Default | Description |
|---|---|---|
| `--artifact <path>` | newest AAB in the build outputs | Input AAB |
| `--out <path>` | `<name>-universal.apk` next to the AAB | Output APK |

## runs

```
caricamento runs
```

Lists previous runs (`runId`, status, start time). Honors `--json`.

## status

```
caricamento status <runId>
```

Shows a run's steps with durations, artifacts and the error with its hint.
Exit code `1` if the run failed. Honors `--json`.

Every run writes an event journal to `~/.caricamento/runs/<runId>.jsonl`,
including full Gradle / xcodebuild logs and API error bodies.
