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

const iosSchema = z.object({
  workspace: z.string(),
  scheme: z.string(),
  configuration: z.string().default('Release'),
  signing: z.object({
    method: z.enum(['app-store', 'development', 'ad-hoc', 'enterprise']).default('app-store'),
    mode: z.enum(['automatic', 'manual']).default('automatic'),
    teamId: z.string().min(1),
  }),
});

const versionSchema = z.object({
  strategy: z.enum(['manual', 'timestamp', 'auto-increment']).default('manual'),
  /**
   * Which API backs `auto-increment`: the current max versionCode is queried
   * from Google Play (all tracks) or Firebase App Distribution (uploaded
   * releases). Default: play when targets.play is configured, else firebase.
   */
  source: z.enum(['play', 'firebase']).optional(),
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
});

/**
 * A build variant: one app published under several applicationIds
 * (e.g. qa/prod). Overrides are applied by resolveVariantConfig:
 * flavor/applicationId merge into `android`, while `targets` and `version`
 * REPLACE the base blocks entirely (predictable, no deep merge).
 */
const variantSchema = z.object({
  /** Gradle product flavor, for projects that define variants in Gradle. */
  flavor: z.string().optional(),
  /** Tool-injected applicationId override — works on vanilla/regenerated projects. */
  applicationId: z.string().min(1).optional(),
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
export type ChangelogConfig = z.infer<typeof changelogSchema>;
export type VariantConfig = z.infer<typeof variantSchema>;
