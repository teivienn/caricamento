# Build variants

One project can be published under several application IDs, e.g.
`com.example.app.qa` for internal testing and `com.example.app` for release.
Variants are declared in the `variants` block:

```typescript
export default {
  // ...base android / ios / signing / version...

  targets: {
    firebase: { appIdAndroid: '1:123:android:base', groups: ['qa'] },
  },

  variants: {
    qa: {
      applicationId: 'com.example.app.qa',   // injected into the build externally
      targets: {                             // REPLACES the base targets entirely
        firebase: { appIdAndroid: '1:123:android:qa', groups: ['qa'] },
      },
    },
    prod: {
      applicationId: 'com.example.app',
      targets: {
        play: {
          serviceAccountRef: 'secret:play/service-account',
          packageName: 'com.example.app',
          track: 'internal',
        },
      },
      version: { strategy: 'auto-increment' }, // REPLACES the base version block
    },
  },
};
```

## Variant fields

| Field | Effect |
|---|---|
| `applicationId` | Android applicationId, injected at build time |
| `flavor` | Gradle product flavor (merged into `android`) |
| `bundleId` | iOS bundle ID; overrides `ios.signing.bundleId` (ignored without an `ios` block) |
| `targets` | Replaces the base `targets` entirely |
| `version` | Replaces the base `version` block entirely |

Merging is intentionally simple (no deep merge): a variant publishes exactly
where its own `targets` say.

## Running

```bash
caricamento release myapp --variant qa     # one variant
caricamento release myapp --variant all    # every variant, sequentially
caricamento build --variant prod --artifact-type aab
caricamento upload myapp --variant qa --target firebase
```

`--variant all` runs each variant as a separate pipeline with its own run ID,
secrets, targets and version. A failing variant does not stop the others; a
summary of all variants is printed at the end, and the exit code is non-zero if
any variant failed. It fails with a validation error if no variants are
defined.

## How the applicationId is injected

- **`init-script` signing mode (default)**: the generated Gradle init script
  sets `android.defaultConfig.applicationId` in `afterEvaluate`. Project files
  are not modified, so variants work on vanilla templates and survive
  `expo prebuild --clean` without re-running prebuild.
- **`properties` mode**: `-PCARICAMENTO_APPLICATION_ID=...` is passed and your
  `build.gradle` must read it (like `CARICAMENTO_VERSION_CODE`).

On iOS, `bundleId` is passed to `xcodebuild` as `PRODUCT_BUNDLE_IDENTIFIER`.
This applies to **all** targets in the scheme, so apps with extensions should
use the project's own build configurations instead. A TestFlight variant
usually has its own `targets.appstore` with the same `bundleId`.

## When to use `flavor` instead

If the project already defines product flavors with their own
`applicationId` / `applicationIdSuffix`, don't duplicate them: set only
`flavor: 'qa'` in the variant and caricamento builds `:app:assembleQaRelease`.
applicationId injection is for projects without flavors (typical React Native
and Expo apps).

Each application ID must exist on the store side: a separate Firebase app
(its own `appIdAndroid`) and/or a separate Play Console app (its own
`packageName`).
