import { z } from 'zod';

const secretRef = z
  .string()
  .regex(/^secret:.+/, 'secret references must look like "secret:<name>" — never put raw secrets in config');

export const projectTypeSchema = z.enum(['auto', 'ios', 'android', 'react-native', 'flutter']);
export type ProjectType = z.infer<typeof projectTypeSchema>;

export const platformSchema = z.enum(['ios', 'android']);
export type Platform = z.infer<typeof platformSchema>;

const androidSigningSchema = z.object({
  keystoreRef: secretRef,
  keystorePasswordRef: secretRef,
  keyAlias: z.string().min(1),
  keyPasswordRef: secretRef,
  /** Expected SHA-256 of the upload certificate; verified post-build via apksigner (SPEC §6.2). */
  expectedCertificateSha256: z.string().regex(/^([0-9a-fA-F]{2}:?){32}$/).optional(),
  /**
   * How signing is applied to the build:
   * - 'init-script' (default): zero-touch — a generated Gradle init script
   *   overrides the release signingConfig externally (`gradlew -I`), the
   *   project files are never modified and may even be regenerated
   *   (e.g. `expo prebuild --clean`).
   * - 'properties': signing is passed via -PCARICAMENTO_* properties and the
   *   project's build.gradle must read them (SPEC §5.1).
   */
  injection: z.enum(['init-script', 'properties']).default('init-script'),
});

const androidSchema = z.object({
  module: z.string().default('app'),
  flavor: z.string().optional(),
  buildType: z.string().default('release'),
  /**
   * applicationId override, injected externally at build time (init script or
   * -PCARICAMENTO_APPLICATION_ID) — project files are never modified.
   * Usually set per variant (see `variants`).
   */
  applicationId: z.string().min(1).optional(),
  signing: androidSigningSchema.optional(),
});

export const iosExportMethodSchema = z.enum(['app-store', 'ad-hoc', 'development', 'enterprise']);
export type IosExportMethod = z.infer<typeof iosExportMethodSchema>;

const iosSigningSchema = z
  .object({
    /**
     * - 'automatic' (default): xcodebuild manages profiles itself
     *   (-allowProvisioningUpdates), authenticated with the ASC API key below.
     * - 'manual': the .p12 is imported into a temporary keychain and the
     *   profiles are installed for the duration of the build (SPEC §6.1).
     * - 'none': unsigned local build (CODE_SIGNING_ALLOWED=NO); the .app is
     *   packaged into an unsigned .ipa without exportArchive. Cannot be published.
     */
    mode: z.enum(['automatic', 'manual', 'none']).default('automatic'),
    method: iosExportMethodSchema.default('app-store'),
    teamId: z.string().min(1).optional(),
    /**
     * Bundle identifier override, injected as PRODUCT_BUNDLE_IDENTIFIER at
     * build time (project files are never modified). Usually set per variant.
     */
    bundleId: z.string().min(1).optional(),
    /** automatic: secret ref resolving to the ASC API .p8 key (file path or inline PEM). */
    apiKeyRef: secretRef.optional(),
    keyId: z.string().min(1).optional(),
    issuerId: z.string().min(1).optional(),
    /** manual: secret ref resolving to a .p12 (file path or base64 content). */
    certificateRef: secretRef.optional(),
    certificatePasswordRef: secretRef.optional(),
    /** manual: secret refs resolving to .mobileprovision files (path or base64). */
    profileRefs: z.array(secretRef).optional(),
  })
  .superRefine((signing, ctx) => {
    const apiKeyFields = [signing.apiKeyRef, signing.keyId, signing.issuerId].filter((v) => v !== undefined);
    if (apiKeyFields.length > 0 && apiKeyFields.length < 3) {
      ctx.addIssue({
        code: 'custom',
        message: 'ios.signing.apiKeyRef, keyId and issuerId must be set together',
        path: ['apiKeyRef'],
      });
    }
    if (signing.mode === 'manual') {
      if (!signing.profileRefs || signing.profileRefs.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'manual signing requires ios.signing.profileRefs', path: ['profileRefs'] });
      }
      if (signing.certificateRef && !signing.certificatePasswordRef) {
        ctx.addIssue({
          code: 'custom',
          message: 'ios.signing.certificateRef requires certificatePasswordRef',
          path: ['certificatePasswordRef'],
        });
      }
    }
  });

const iosSchema = z
  .object({
    /** .xcworkspace (CocoaPods / RN) — exactly one of workspace/project is required. */
    workspace: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    scheme: z.string().min(1),
    configuration: z.string().default('Release'),
    /** xcodebuild -destination for the archive. */
    destination: z.string().default('generic/platform=iOS'),
    signing: iosSigningSchema.default({ mode: 'automatic', method: 'app-store' }),
  })
  .refine((ios) => (ios.workspace === undefined) !== (ios.project === undefined), {
    message: 'exactly one of ios.workspace or ios.project must be set',
    path: ['workspace'],
  });

const versionSchema = z.object({
  strategy: z.enum(['manual', 'timestamp', 'auto-increment']).default('manual'),
  /**
   * Which API backs `auto-increment`: Google Play (max versionCode across
   * tracks), App Store Connect (max CFBundleVersion among builds) or Firebase
   * App Distribution (uploaded releases). Default: play > appstore > firebase,
   * among the configured targets native to the platform being built.
   */
  source: z.enum(['play', 'appstore', 'firebase']).optional(),
  /** Used by the manual strategy; can be overridden with --build. */
  buildNumber: z.number().int().positive().optional(),
  /** versionName / CFBundleShortVersionString; can be overridden with --version. */
  name: z.string().optional(),
});

const firebaseTargetSchema = z.object({
  appIdIos: z.string().optional(),
  appIdAndroid: z.string().optional(),
  groups: z.array(z.string()).default([]),
  testers: z.array(z.string()).default([]),
  /**
   * Secret ref resolving to a service-account JSON (inline JSON or a file path).
   * Falls back to GOOGLE_APPLICATION_CREDENTIALS when omitted (SPEC §7.3).
   */
  serviceAccountRef: secretRef.optional(),
  releaseNotes: z.string().optional(),
});

const playTargetSchema = z.object({
  /**
   * Secret ref resolving to a service-account JSON (inline JSON or a file path)
   * with access to the Play Developer API (SPEC §7.2).
   */
  serviceAccountRef: secretRef,
  /** applicationId of the app, as registered in Play Console. */
  packageName: z.string().min(1),
  track: z.enum(['internal', 'alpha', 'beta', 'production']).default('internal'),
  releaseNotes: z.string().optional(),
  /** Release status; 'draft' keeps the release unpublished on the track. */
  status: z.enum(['completed', 'draft']).default('completed'),
});

const playSharingTargetSchema = z.object({
  /** Secret ref resolving to a service-account JSON with Play API access. */
  serviceAccountRef: secretRef,
  packageName: z.string().min(1),
});

const appStoreTargetSchema = z.object({
  /** Secret ref resolving to the ASC API private key (.p8 file path or inline PEM). */
  apiKeyRef: secretRef,
  keyId: z.string().min(1),
  issuerId: z.string().min(1),
  /** Bundle ID of the app as registered in App Store Connect. */
  bundleId: z.string().min(1),
  /** 'appstore' (review submission) is on the roadmap and currently rejected. */
  distributeTo: z.enum(['testflight', 'appstore']).default('testflight'),
  /** TestFlight beta group names the processed build is added to. */
  betaGroups: z.array(z.string().min(1)).default([]),
  /** TestFlight "What to Test" text (the iOS counterpart of releaseNotes). */
  whatToTest: z.string().optional(),
  /** Locale of the "What to Test" localization. */
  locale: z.string().default('en-US'),
  /**
   * Binary upload mechanism: 'api' — App Store Connect Build Uploads REST API
   * (no Xcode needed at upload time); 'altool' — `xcrun altool --upload-app`.
   */
  upload: z.enum(['api', 'altool']).default('api'),
  /** Upper bound for waiting until ASC finishes processing the build. */
  processingTimeoutMinutes: z.number().positive().default(30),
});

const changelogSchema = z.object({
  /** 'git': release notes from commits since the last git tag. */
  source: z.enum(['git']),
  /** Fallback commit count when the repo has no tags. */
  maxCommits: z.number().int().positive().default(20),
});

const targetsSchema = z.object({
  firebase: firebaseTargetSchema.optional(),
  play: playTargetSchema.optional(),
  playsharing: playSharingTargetSchema.optional(),
  appstore: appStoreTargetSchema.optional(),
});

/**
 * A build variant: one app published under several applicationIds
 * (e.g. qa/prod). Overrides are applied by resolveVariantConfig:
 * flavor/applicationId merge into `android`, bundleId into `ios.signing`,
 * while `targets` and `version` REPLACE the base blocks entirely
 * (predictable, no deep merge).
 */
const variantSchema = z.object({
  /** Gradle product flavor, for projects that define variants in Gradle. */
  flavor: z.string().optional(),
  /** Tool-injected applicationId override — works on vanilla/regenerated projects. */
  applicationId: z.string().min(1).optional(),
  /** Tool-injected iOS bundle ID override (PRODUCT_BUNDLE_IDENTIFIER + exportOptions). */
  bundleId: z.string().min(1).optional(),
  targets: targetsSchema.optional(),
  version: versionSchema.optional(),
});

export const configSchema = z.object({
  project: z.object({ type: projectTypeSchema.default('auto') }).default({ type: 'auto' }),
  android: androidSchema.optional(),
  ios: iosSchema.optional(),
  version: versionSchema.default({ strategy: 'manual' }),
  targets: targetsSchema.default({}),
  changelog: changelogSchema.optional(),
  variants: z.record(z.string(), variantSchema).optional(),
});

export type CaricamentoConfig = z.infer<typeof configSchema>;
export type AndroidSigningConfig = z.infer<typeof androidSigningSchema>;
export type FirebaseTargetConfig = z.infer<typeof firebaseTargetSchema>;
export type PlayTargetConfig = z.infer<typeof playTargetSchema>;
export type PlaySharingTargetConfig = z.infer<typeof playSharingTargetSchema>;
export type AppStoreTargetConfig = z.infer<typeof appStoreTargetSchema>;
export type IosConfig = z.infer<typeof iosSchema>;
export type IosSigningConfig = z.infer<typeof iosSigningSchema>;
export type ChangelogConfig = z.infer<typeof changelogSchema>;
export type VariantConfig = z.infer<typeof variantSchema>;
