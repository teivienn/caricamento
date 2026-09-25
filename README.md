# caricamento

CLI tool to build, sign and distribute mobile app releases. See [SPEC.md](SPEC.md)
for the full architecture and roadmap.

**Status: MVP (Phase 0–2)** — Android builds (Gradle) with injected signing and
post-build signature verification, uploaded to Firebase App Distribution via its
REST API. iOS and Google Play are designed for (ports & adapters, SPEC.md §3)
but intentionally not implemented yet.

## Quickstart

```bash
npm install
npm run build

# inside your Android project
caricamento init                 # generate caricamento.config.ts
caricamento doctor               # check java / gradlew / apksigner / firebase creds
caricamento detect               # show the detected project descriptor

caricamento build   --platform android
caricamento upload  --target firebase
caricamento release --platform android --targets firebase

caricamento runs                 # history
caricamento status <runId>       # summary of one run
```

Global flags: `--config <path>`, `--verbose`, `--json`, `--dry-run`.

## Configuration

`caricamento.config.ts` in the target project (typed via `defineConfig`).
Secrets are referenced as `secret:<name>` and resolved through the chain
**env vars → macOS Keychain → .env** (SPEC.md §3.5); a name like
`android/keystore-password` maps to the env var `ANDROID_KEYSTORE_PASSWORD`.

The Android project's `build.gradle` must read the injected signing properties
(`CARICAMENTO_STORE_FILE`, `CARICAMENTO_STORE_PASSWORD`, `CARICAMENTO_KEY_ALIAS`,
`CARICAMENTO_KEY_PASSWORD`, plus `CARICAMENTO_VERSION_CODE` /
`CARICAMENTO_VERSION_NAME`) — see `fixtures/android-native/app/build.gradle`
for a working example.

## Development

```bash
npm run build       # tsup -> dist/
npm test            # vitest unit tests (no Android SDK / Firebase required)
npm run typecheck
npm run lint        # eslint incl. layer-boundary rules (SPEC.md §3.1)
```

`fixtures/` contains a real (minimal) Gradle Android project plus marker
fixtures for Flutter/React Native detection tests — see
[fixtures/README.md](fixtures/README.md).
