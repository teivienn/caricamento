export { defineConfig } from './core/config/defineConfig.js';
export { configSchema } from './core/config/schema.js';
export { resolveVariantConfig } from './core/config/variants.js';
export type { CaricamentoConfig, Platform, PlayTargetConfig, ProjectType, VariantConfig } from './core/config/schema.js';
export type { Artifact, ArtifactKind } from './core/artifact/types.js';
export {
  CaricamentoError,
  ValidationError,
  ConfigError,
  BuildError,
  SigningError,
  UploadError,
  ExitCode,
} from './core/errors.js';
export { Pipeline } from './core/pipeline/pipeline.js';
export type {
  RunEvent,
  RunSummary,
  Step,
  StepContext,
  StepPlan,
  StepResult,
  UseCase,
} from './core/pipeline/types.js';
export { ProjectDetector } from './core/project/detector.js';
export type { ProjectDescriptor } from './core/project/types.js';
export { resolveAndroidVersion } from './core/versioning/index.js';
export type { ResolvedVersion } from './core/versioning/index.js';
export type {
  Builder,
  BuildRequest,
  ConfigLoader,
  ProcessRunner,
  Publisher,
  PublishRequest,
  PublishResult,
  RunJournal,
  SecretResolver,
  SecretStore,
  SigningProvider,
  VersionCodeProvider,
} from './core/ports/index.js';
