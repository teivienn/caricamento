/**
 * Starter config templates. The typed variant imports `defineConfig` from the
 * installed package; the plain variant is for configs loaded from outside a
 * project (~/.caricamento/projects/), where the package may not resolve.
 */
export function configTemplate(options: { typed: boolean }): string {
  const body = `{
  project: { type: 'auto' }, // auto | ios | android | react-native | flutter

  android: {
    module: 'app',
    // flavor: 'prod',
    buildType: 'release',
    signing: {
      // injection: 'init-script' (default, zero-touch) | 'properties'
      // Values are NAMES of secrets, never the secrets themselves (SPEC §3.5).
      // Resolution chain: env var (ANDROID_KEYSTORE_PATH etc.) -> macOS Keychain -> .env
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
      // Optional: expected SHA-256 of the upload certificate, verified post-build.
      // expectedCertificateSha256: 'AA:BB:...',
    },
  },

  // ios: {
  //   project: 'App.xcodeproj',     // or workspace: 'App.xcworkspace' (exactly one)
  //   scheme: 'App',                // must be a shared scheme
  //   signing: {
  //     mode: 'automatic',          // automatic | manual | none (unsigned local build)
  //     teamId: 'ABCDE12345',
  //   },
  // },

  version: {
    strategy: 'timestamp', // manual | timestamp | auto-increment
    // source: 'play',     // auto-increment source: play | appstore | firebase
    // buildNumber: 1,     // required for strategy 'manual'
    // name: '1.0.0',
  },

  targets: {
    firebase: {
      appIdAndroid: '1:1234567890:android:abcdef', // from the Firebase console
      groups: ['qa'],
      // serviceAccountRef: 'secret:firebase/service-account', // or set GOOGLE_APPLICATION_CREDENTIALS
      // releaseNotes: 'Default release notes',
    },
    // appstore: {                   // TestFlight (--platform ios)
    //   apiKeyRef: 'secret:asc/private-key',
    //   keyId: 'XYZ123ABCD',
    //   issuerId: '00000000-0000-0000-0000-000000000000',
    //   bundleId: 'com.example.app',
    //   betaGroups: ['QA'],
    // },
  },
}`;

  return options.typed
    ? `import { defineConfig } from 'caricamento';\n\nexport default defineConfig(${body});\n`
    : `// Plain-object export: this config is loaded from outside any project,\n// so the caricamento package is not importable here. It is validated\n// against the same zod schema either way.\nexport default ${body};\n`;
}
