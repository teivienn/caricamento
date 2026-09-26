# AGENTS.md

Guidance for AI agents working in this repo. Read this before changing code.
`README.md` is the user-facing front page; `docs/` holds the long-form reference.
`CONTRIBUTING.md` is the human contributor guide (setup, checks, invariants).
Keep it in sync when those rules change.

## What this is

`caricamento` is a Node CLI (`bin: dist/cli/index.js`) that builds, signs,
verifies and publishes Android and iOS releases to Firebase App Distribution,
Google Play (incl. Internal App Sharing) and App Store Connect / TestFlight.
It talks to store APIs directly over REST (no `firebase-tools`, `googleapis`,
fastlane). Supports native Android, native iOS, React Native CLI and Expo
(bare/prebuilt) projects.

## Layout

```
src/
  core/          config schema (zod), pipeline, ports, versioning, detector, errors
  application/   use cases: build, upload, release, apk, detect, doctor, status
  infra/         builders (gradle, xcode), signing, publishers/{firebase,googleplay,appstoreconnect}, system/*
  cli/           commander entry (cli/index.ts), commands/*, render/renderer.ts
  container.ts   composition root
  index.ts       public library exports (defineConfig etc.)
tests/           vitest unit tests (msw for HTTP), one file per area
fixtures/        real sample projects for manual e2e runs (see fixtures/README.md)
```

## Architecture boundaries (do not break)

- Dependency direction: `core` <- `application` <- `infra` / `cli`.
  - `core` depends on nothing but `zod` (plus a few `node:` builtins).
  - `application` imports only `core`.
  - `infra` implements `core` ports; never imports `application` or `cli`.
  - `cli` may import everything.
  - Enforced by `no-restricted-imports` in `eslint.config.js`. Don't weaken
    those rules to make an import compile — move the code instead.
- Progress is reported as `AsyncIterable<RunEvent>` (`src/core/pipeline/types.ts`).
  Steps use `ctx.log()` / `ctx.progress()`. **Never `console.log` in core or
  application.** Only `src/cli/render/` writes to the terminal (text or `--json`).
- `src/container.ts` is the composition root: a plain factory, no DI framework.
  New adapters (builders, publishers, secret stores, version-code providers)
  are wired there, per platform.
- Errors: throw subclasses of `CaricamentoError` (`src/core/errors.ts`) with a
  `code`, `hint` and `exitCode`; the CLI entry maps them to exit codes/JSON.
- Code comments reference "SPEC §x.y". Those are historical labels; there is
  no spec file in the repo. Do not create or commit a `SPEC.md`. Code, tests
  and `docs/` are authoritative.

## How to verify

Node >= 20. Run all four before declaring a change done:

```bash
npm test            # vitest run; no Android SDK, Xcode or store accounts needed
npm run typecheck   # tsc --noEmit
npm run lint        # eslint incl. layer-boundary rules
npm run build       # tsup -> dist/
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck and `npm run test:coverage`
on PRs and never builds.

HTTP clients are tested with `msw`; add/adjust handlers in the matching
`tests/*.test.ts` when you touch a publisher. Manual e2e: `npm run build`, then
`node ../../dist/cli/index.js <cmd>` from inside a fixture.

## Conventions

- TypeScript `strict`, ESM (`"type": "module"`), relative imports end in `.js`.
- Conventional commits in English (`feat:`, `fix:`, `docs:`, `chore:` ...).
- Secrets appear in configs only as `secret:<name>` refs (e.g.
  `secret:android/keystore-password`), resolved by the chain env vars ->
  macOS Keychain -> registry `.env` -> project `.env`. Never inline values.
- Never commit `.caricamento/`, keystores, `.p12`/`.p8`, service-account JSON
  or `.env` files. Exception: `fixtures/android-native/keystore/test-upload.keystore`
  is a throwaway test keystore committed on purpose (documented in
  `fixtures/README.md` and `.gitignore`). Don't delete it; don't add others.
- No real customer package names (e.g. `com.depalm*`) anywhere in the repo.
  Use `com.caricamento.fixture` / `com.example.*`. Real project configs live in
  the registry (`~/.caricamento/projects/*.config.ts`) and are never committed.

## Hard-won invariants

These have been broken before. Check here before "fixing" them.

**Firebase App Distribution**
- Media upload uses the API host itself under `/upload/...`
  (`https://firebaseappdistribution.googleapis.com/upload/v1/<app>/releases:upload`).
  `upload.firebaseappdistribution.googleapis.com` does not work (TLS failure).
- The path is `/releases:upload` (slash before `releases`).
- `groupAliases` are bare aliases (`"qa"`), not `groups/qa`.

**Google Play**
- Media upload is on `androidpublisher.googleapis.com` under
  `/upload/androidpublisher/v3/...`. No `upload.` subdomain.
- Internal App Sharing is part of androidpublisher v3
  (`internalappsharingartifacts`, path `/upload/androidpublisher/v3/applications/internalappsharing/<pkg>/artifacts/<apk|bundle>`),
  not a separate discovery API.
- Play requires `targetSdk 36` for updates. The error
  `Target SDK of artifact is too low: N` prints the **versionCode** as N; the
  real cause is targetSdk, not the version.

**Android build / signing**
- The generated Gradle init script (`src/infra/builders/gradle-init-script.ts`)
  must only touch modules with the `com.android.application` plugin; library
  modules reject `applicationId`.
- `applicationId`, signing config and versionCode/versionName are injected via
  the init script, so project files stay untouched and `npx expo prebuild --clean`
  remains safe. Don't switch to editing `build.gradle`.
- AAB verification uses `jarsigner -verify` + `keytool -printcert -jarfile`, not
  `apksigner` (it rejects AABs). APKs use `apksigner`. `jarsigner` exits 0 on
  unsigned jars and prints `jar is unsigned.` — check the output, not just the
  exit code.
- bundletool's GitHub asset is versioned (`bundletool-all-<ver>.jar`);
  `releases/latest/download/...` 404s. Resolve the URL via
  `api.github.com/repos/google/bundletool/releases/latest`.

**CLI / versioning**
- `--version` is positional. The root program (`src/cli/program.ts`) calls
  `.enablePositionalOptions()` **before** `.version()`: `caricamento --version`
  / `-V` prints the package.json version, `build`/`release --version <name>`
  sets versionName. Without positional options the root `--version` handler
  fires anywhere on the line and swallows `build --version`. Don't remove it or
  rename the per-command flag. Covered by `tests/cli.test.ts`.
- Because of positional options, `--config`/`--verbose`/`--json`/`--dry-run`
  are also registered on every leaf command and forwarded to the root
  (`forwardGlobalOptions`), so `build --dry-run` keeps working. A leaf's own
  flag of the same name wins (`projects add --config`).
- `version.source` default (`resolveVersionSource` in `src/core/versioning`):
  `play` if Android and `targets.play`; `appstore` if iOS and `targets.appstore`;
  else `firebase` if `targets.firebase`; else none.
- A variant's `version` block **replaces** the base `version` entirely (no deep
  merge) — see `src/core/config/variants.ts`.

## iOS status

- `fixtures/ios-native` builds locally unsigned (`ios.signing.mode: 'none'` ->
  `CODE_SIGNING_ALLOWED=NO`) on any Mac with Xcode, no Apple account.
- TestFlight / App Store Connect publishing is implemented and unit-tested but
  needs a paid Apple Developer account and has **not** been verified end to end.
  Don't claim otherwise in docs.

## Docs map

`README.md` is short; details go in `docs/`:

- `commands.md` — every command, flag, default, exit code, known issues
- `configuration.md` — `caricamento.config.ts`, secret refs, registry mode
- `signing.md` — Android init script vs `-P` properties; iOS automatic/manual/none
- `versioning.md` — manual, timestamp, auto-increment, version sources
- `variants.md` — qa/prod, applicationId/bundle ID injection, `--variant all`
- `secrets.md` — env vars, Keychain, `.env` files
- `firebase.md`, `google-play.md`, `internal-app-sharing.md`, `app-store.md` — per-target setup
- `apk.md` — AAB -> universal APK via bundletool
- `changelog.md` — release notes the CLI generates from the target project's git history (not the package history; that is root `CHANGELOG.md`)
- `roadmap.md` — backlog / not-yet-implemented features
- `fixtures/README.md` — how to build and run each fixture

When behavior changes, update the matching `docs/` page in the same change.

## Git rules

- Do not force-push `main`. Do not rewrite published history.
- Do not change git config.
- Commit only when asked.
