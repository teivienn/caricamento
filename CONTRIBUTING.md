# Contributing

Setup, checks and the rules a change has to follow. User docs live in
[README.md](README.md) and [docs/](docs/).

## Setup

Node.js 22 or 24. The package declares `engines.node >= 20`, but the test
runner (vitest 5) needs `^22.12` or `^24`, so Node 20 cannot run `npm test`.

```bash
git clone https://github.com/teivienn/caricamento.git
cd caricamento
npm install
```

`npm run build` writes `dist/`. `npm link` puts the `caricamento` command on
your PATH. Unit tests do not need a build, an Android SDK, Xcode or store
accounts.

Manual end-to-end runs do. Android needs JDK 17, `ANDROID_HOME` and a Gradle
wrapper. iOS needs full Xcode on macOS. See [fixtures/README.md](fixtures/README.md).

## Checks

Run these before opening a pull request:

```bash
npm test              # vitest
npm run test:coverage # same, plus a v8 report in coverage/
npm run typecheck     # tsc --noEmit
npm run lint          # eslint, including layer-boundary rules
npm run build         # tsup -> dist/
```

CI (`.github/workflows/ci.yml`) runs on pull requests to `main` and on pushes
to `main`:

- lint and typecheck on Node 24
- unit tests on Node 22 and 24
- coverage on Node 24: totals in the job summary, full report uploaded as the
  `coverage` artifact (kept 14 days)

CI does not run `npm run build`, fixture builds, or Android / iOS builds.

## Tests

Tests are in `tests/`, one file per area. HTTP clients use `msw`. When you
change a publisher, add or adjust handlers in the matching `tests/*.test.ts`.

From a fixture, after `npm run build`:

```bash
node ../../dist/cli/index.js <cmd>
```

`fixtures/android-native/keystore/test-upload.keystore` is a throwaway test
keystore committed on purpose. Do not delete it and do not add another
keystore, `.p12`, `.p8`, service-account JSON or `.env`.

## Layout

```
src/
  core/          config schema (zod), pipeline, ports, versioning, detector, errors
  application/   use cases: build, upload, release, apk, detect, doctor, status
  infra/         builders (gradle, xcode), signing, publishers, system
  cli/           commander entry, commands, terminal renderer
  container.ts   composition root
  index.ts       public library exports (defineConfig and the rest)
tests/           vitest
fixtures/        sample projects for manual runs
```

Dependency direction is `core` ← `application` ← `infra` / `cli`:

- `core` depends on `zod` and a few `node:` builtins.
- `application` imports only `core`.
- `infra` implements `core` ports and does not import `application` or `cli`.
- `cli` may import everything.

`no-restricted-imports` in `eslint.config.js` enforces this. If an import fails
the rule, move the code. Do not weaken the rule.

Other boundaries:

- Progress is an `AsyncIterable<RunEvent>` (`src/core/pipeline/types.ts`).
  Steps call `ctx.log()` and `ctx.progress()`. Do not `console.log` in `core`
  or `application`. Only `src/cli/render/` writes to the terminal (text or
  `--json`).
- `src/container.ts` is a plain factory, not a DI framework. Wire new builders,
  publishers, secret stores and version-code providers there, per platform.
- Throw a subclass of `CaricamentoError` (`src/core/errors.ts`) with a `code`,
  `hint` and `exitCode`. The CLI maps those to exit codes and JSON.
- Comments that say `SPEC §x.y` are historical labels. There is no spec file.
  Do not add one. Code, tests and `docs/` are the source of truth.

## Conventions

- TypeScript `strict`, ESM (`"type": "module"`). Relative imports end in `.js`.
- Commit messages are [Conventional Commits](https://www.conventionalcommits.org/)
  in English: `feat:`, `fix:`, `docs:`, `chore:`, and so on.
- Secrets in config are `secret:<name>` refs (for example
  `secret:android/keystore-password`). Resolution order is env vars, then macOS
  Keychain, then the registry `.env`, then the project `.env`. Never inline a
  secret value.
- Do not commit `.caricamento/`, keystores, `.p12` / `.p8`, service-account JSON
  or `.env` files. The one exception is the fixture keystore above.
- No real customer package names in the repo. Use `com.caricamento.fixture` or
  `com.example.*`. Real project configs live in
  `~/.caricamento/projects/*.config.ts` and stay uncommitted.
- When behavior changes, update the matching page under `docs/` in the same
  change. `README.md` stays a short front page.

## Invariants

These have been broken before.

**Firebase App Distribution**

- Media upload uses the API host under `/upload/...`
  (`https://firebaseappdistribution.googleapis.com/upload/v1/<app>/releases:upload`).
  `upload.firebaseappdistribution.googleapis.com` fails TLS.
- The path is `/releases:upload` (slash before `releases`).
- `groupAliases` are bare aliases (`"qa"`), not `groups/qa`.

**Google Play**

- Media upload is on `androidpublisher.googleapis.com` under
  `/upload/androidpublisher/v3/...`. There is no `upload.` subdomain.
- Internal App Sharing is androidpublisher v3
  (`internalappsharingartifacts`, path
  `/upload/androidpublisher/v3/applications/internalappsharing/<pkg>/artifacts/<apk|bundle>`),
  not a separate discovery API.
- Play requires `targetSdk 36` for updates. The error
  `Target SDK of artifact is too low: N` prints the **versionCode** as N. The
  cause is targetSdk, not the version.

**Android build and signing**

- The generated Gradle init script (`src/infra/builders/gradle-init-script.ts`)
  may only touch modules that apply `com.android.application`. Library modules
  reject `applicationId`.
- `applicationId`, signing and versionCode / versionName are injected by that
  init script, so project files stay untouched and `npx expo prebuild --clean`
  stays safe. Do not switch to editing `build.gradle`.
- AAB checks use `jarsigner -verify` and `keytool -printcert -jarfile`.
  `apksigner` rejects AABs. APKs use `apksigner`. `jarsigner` exits 0 on an
  unsigned jar and prints `jar is unsigned.` Check the output, not only the
  exit code.
- bundletool's GitHub asset is versioned (`bundletool-all-<ver>.jar`).
  `releases/latest/download/...` returns 404. Resolve the URL via
  `api.github.com/repos/google/bundletool/releases/latest`.

**CLI and versioning**

- `--version` is positional. The root program (`src/cli/program.ts`) calls
  `.enablePositionalOptions()` before `.version()`. `caricamento --version` and
  `-V` print the package version. `build` / `release --version <name>` sets
  versionName. Without positional options the root handler runs anywhere on the
  line and swallows `build --version`. Do not remove it or rename the
  per-command flag. Covered by `tests/cli.test.ts`.
- Because of positional options, `--config`, `--verbose`, `--json` and
  `--dry-run` are also registered on every leaf command and forwarded to the
  root (`forwardGlobalOptions`), so `build --dry-run` works. A leaf's own flag
  of the same name wins (`projects add --config`).
- Default `version.source` (`resolveVersionSource` in `src/core/versioning`):
  `play` when the platform is Android and `targets.play` is set; `appstore`
  when the platform is iOS and `targets.appstore` is set; otherwise `firebase`
  when `targets.firebase` is set; otherwise none.
- A variant's `version` block replaces the base `version` entirely. There is
  no deep merge. See `src/core/config/variants.ts`.

## iOS

`fixtures/ios-native` builds unsigned locally (`ios.signing.mode: 'none'` sets
`CODE_SIGNING_ALLOWED=NO`) on a Mac with Xcode and no Apple account.

TestFlight and App Store Connect publishing is implemented and unit-tested. It
needs a paid Apple Developer account and has not been verified end to end. Do
not claim otherwise in docs.

## Releases

`CHANGELOG.md` in the repo root is the package history. Do not record package
releases in `docs/changelog.md`; that page documents the CLI's git release-note
feature.

When cutting a version, move notes from `## [Unreleased]` into a new
`## [x.y.z] - YYYY-MM-DD` section and set the same version in `package.json`.
User-visible changes go in the changelog in the same change. `0.1.0` is the
first version published to npm.

## Pull requests

Open the pull request against `main`. GitHub fills the description from
[`.github/pull_request_template.md`](.github/pull_request_template.md): a short
summary, how you checked the change, and whether docs or `CHANGELOG.md` need an
update. Do not force-push `main` or rewrite published history.
