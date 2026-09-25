// Plain-object export (no `defineConfig` import) so the file loads without
// caricamento being installed as a dependency of the fixture.
// The loader validates it against the same zod schema either way.
export default {
  project: { type: 'android' as const },

  android: {
    module: 'app',
    buildType: 'release',
    signing: {
      // Test-only values matching fixtures/android-native/keystore/test-upload.keystore.
      // For local runs, put these in a .env file in THIS directory:
      //   ANDROID_KEYSTORE_PATH=<abs path to keystore/test-upload.keystore>
      //   ANDROID_KEYSTORE_PASSWORD=android
      //   ANDROID_KEY_PASSWORD=android
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
    },
  },

  version: { strategy: 'timestamp' as const },

  targets: {
    firebase: {
      // Placeholder — replace with a real Firebase app ID to actually upload.
      appIdAndroid: '1:1234567890:android:0000000000000000000000',
      groups: ['qa'],
    },
  },
};
