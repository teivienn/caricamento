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

export const configSchema = z.object({
  project: z.object({ type: projectTypeSchema.default('auto') }).default({ type: 'auto' }),
  android: androidSchema.optional(),
  ios: iosSchema.optional(),
  version: versionSchema.default({ strategy: 'manual' }),
  targets: z
    .object({
      firebase: firebaseTargetSchema.optional(),
    })
    .default({}),
});

export type CaricamentoConfig = z.infer<typeof configSchema>;
export type AndroidSigningConfig = z.infer<typeof androidSigningSchema>;
export type FirebaseTargetConfig = z.infer<typeof firebaseTargetSchema>;
