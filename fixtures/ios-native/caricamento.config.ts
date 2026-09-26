// Plain-object export (no `defineConfig` import) so the file loads without
// caricamento being installed as a dependency of the fixture.
// The loader validates it against the same zod schema either way.
export default {
  project: { type: 'ios' as const },

  ios: {
    project: 'CaricamentoFixture.xcodeproj',
    scheme: 'CaricamentoFixture',
    configuration: 'Release',
    signing: {
      // 'none' builds an unsigned .ipa locally (CODE_SIGNING_ALLOWED=NO) —
      // no Apple account needed. For TestFlight switch to 'automatic' and set
      // teamId + bundleId (an app record with that bundle ID must exist in ASC).
      mode: 'none' as const,
      // mode: 'automatic' as const,
      // teamId: 'ABCDE12345',
      // bundleId: 'com.example.caricamento.fixture',
    },
  },

  version: { strategy: 'timestamp' as const, name: '1.0.0' },

  // targets: {
  //   appstore: {
  //     apiKeyRef: 'secret:asc/api-key',   // AuthKey_<KEYID>.p8 path or PEM
  //     keyId: 'XYZ123ABCD',
  //     issuerId: '00000000-0000-0000-0000-000000000000',
  //     bundleId: 'com.example.caricamento.fixture',
  //     betaGroups: ['QA'],
  //     whatToTest: 'Caricamento e2e build',
  //   },
  // },
};
