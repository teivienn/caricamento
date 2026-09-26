# Configuration

caricamento is configured with a TypeScript file, `caricamento.config.ts`,
validated against a zod schema at load time. Generate a template with
`caricamento init` (in-project) or `caricamento projects add` (registry).

## Where the config comes from

Without a project name, the config is `--config <path>` or
`<cwd>/caricamento.config.ts`.

With a registered project name (`caricamento release myapp`), resolution is:

1. `--config <path>`
2. the explicit config stored in the registry entry (`projects add --config`)
3. `~/.caricamento/projects/<name>.config.ts`
4. `<project>/caricamento.config.ts`

Registry mode ("command center") keeps everything in `~/.caricamento/`:
`registry.json`, `projects/<name>.config.ts`, `projects/<name>.env`,
`runs/<runId>.jsonl` and `tools/`. Combined with the default Android
[init-script signing](signing.md#init-script-default), nothing is written into
the target project.

In-project configs can import the typed helper:

```typescript
import { defineConfig } from 'caricamento';

export default defineConfig({ /* ... */ });
```

Registry configs are loaded from outside any project, where the package may
not resolve, so they export a plain object (validated by the same schema).

## Full example

```typescript
export default {
  project: { type: 'auto' }, // auto | android | ios | react-native | flutter

  android: {
    module: 'app',            // Gradle module, default 'app'
    flavor: 'prod',           // optional product flavor
    buildType: 'release',     // default 'release'
    // applicationId: 'com.example.app', // optional, usually set per variant
    signing: {
      injection: 'init-script',          // default; or 'properties'
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
      expectedCertificateSha256: 'F4:40:2B:55:...', // optional, 32 hex pairs
    },
  },

  ios: {
    project: 'App.xcodeproj',  // exactly one of project / workspace
    scheme: 'App',
    signing: { mode: 'automatic', teamId: 'ABCDE12345' },
  },

  version: { strategy: 'timestamp' }, // manual | timestamp | auto-increment

  changelog: { source: 'git', maxCommits: 20 },

  targets: {
    firebase: { appIdAndroid: '1:123456789:android:abc123', groups: ['qa'] },
    play: {
      serviceAccountRef: 'secret:play/service-account',
      packageName: 'com.example.app',
      track: 'internal',
    },
  },

  // variants: { qa: { ... }, prod: { ... } },
};
```

## Blocks

| Block | Documented in |
|---|---|
| `project.type` | Default `auto` (detected, see [commands.md#detect](commands.md#detect)) |
| `android` | Fields below; signing in [signing.md](signing.md) |
| `ios` | [app-store.md](app-store.md#configuration-reference), [signing.md](signing.md#ios) |
| `version` | [versioning.md](versioning.md) |
| `changelog` | [changelog.md](changelog.md) |
| `targets.firebase` | [firebase.md](firebase.md) |
| `targets.play` | [google-play.md](google-play.md) |
| `targets.playsharing` | [internal-app-sharing.md](internal-app-sharing.md) |
| `targets.appstore` | [app-store.md](app-store.md) |
| `variants` | [variants.md](variants.md) |

### `android`

| Field | Type | Default | Description |
|---|---|---|---|
| `module` | string | `app` | Gradle module to build |
| `flavor` | string | — | Product flavor (e.g. `prod` → `:app:assembleProdRelease`) |
| `buildType` | string | `release` | Build type |
| `applicationId` | string | — | applicationId injected at build time (see [variants.md](variants.md)) |
| `signing` | object | — | See [signing.md](signing.md#android) |

## Secret references

Config files never contain secret values, only references of the form
`secret:<name>`. The schema rejects any `*Ref` field that does not start with
`secret:`. References are resolved at run time through env vars → Keychain →
`.env` files; see [secrets.md](secrets.md).

## `CARICAMENTO_PROJECT_DIR`

The config is executable TypeScript. Before it is evaluated,
`process.env.CARICAMENTO_PROJECT_DIR` is set to the absolute project path, so a
config can read project files even when it lives in `~/.caricamento/projects/`.
A common use is taking versionName from `package.json`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(process.env.CARICAMENTO_PROJECT_DIR!, 'package.json'), 'utf8'),
);

export default {
  version: { strategy: 'auto-increment', name: pkg.version },
  // ...
};
```

For an in-project config, `new URL('./package.json', import.meta.url)` also
works, but `CARICAMENTO_PROJECT_DIR` works in both modes.
