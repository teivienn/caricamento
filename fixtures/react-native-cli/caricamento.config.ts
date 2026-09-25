// Plain-object export (no `defineConfig` import) so the file loads without
// caricamento being installed as a dependency of the fixture.
// The loader validates it against the same zod schema either way.
export default {
  project: { type: 'auto' as const }, // detects react-native via package.json + android/

  android: {
    module: 'app',
    buildType: 'release',
    signing: {
      // Test-only values matching android/keystore/test-upload.keystore.
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
    },
  },

  version: { strategy: 'timestamp' as const },

  targets: {
    firebase: {
      appIdAndroid: '1:1083921360192:android:7fb11741b80075995fc6a5',
      groups: ['qa'],
      releaseNotes: 'Caricamento RN CLI fixture release',
      // Auth: GOOGLE_APPLICATION_CREDENTIALS points at .caricamento/firebase-sa.json
    },
  },
};
