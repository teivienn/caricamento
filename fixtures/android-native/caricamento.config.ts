// Plain-object export (no `defineConfig` import) so the file loads without
// caricamento being installed as a dependency of the fixture.
// The loader validates it against the same zod schema either way.
export default {
  project: { type: 'android' as const },

  android: {
    module: 'app',
    buildType: 'release',
    signing: {
      // This fixture exercises the 'properties' injection mode (SPEC §5.1):
      // its app/build.gradle reads the -PCARICAMENTO_* properties.
      // The RN/Expo fixtures use the default zero-touch 'init-script' mode.
      injection: 'properties' as const,
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
      releaseNotes: 'Caricamento end-to-end test release',
      // Auth: GOOGLE_APPLICATION_CREDENTIALS points at .caricamento/firebase-sa.json
    },
  },
};
