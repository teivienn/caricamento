import type { CaricamentoConfig, Platform } from '../core/config/schema.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Builder, SigningProvider, VersionCodeProvider } from '../core/ports/index.js';
import { androidBuildStep, detectStep, iosBuildStep, verifySigningStep, versionStep, type VersionOverrides } from './steps.js';

export interface BuildInput extends VersionOverrides {
  cwd: string;
  /** Android only; iOS always produces an .ipa. */
  artifactType?: 'aab' | 'apk';
  dryRun?: boolean;
}

export interface BuildUseCaseDeps {
  config: CaricamentoConfig;
  /** Platform the builder/signing/version source were wired for. Default: android. */
  platform?: Platform;
  builder: Builder;
  signing: SigningProvider | null;
  versionCodeProvider?: VersionCodeProvider;
  recorder?: RunRecorder;
}

export class BuildUseCase implements UseCase<BuildInput> {
  constructor(private readonly deps: BuildUseCaseDeps) {}

  run(input: BuildInput): AsyncIterable<RunEvent> {
    const platform = this.deps.platform ?? 'android';
    const steps: Step[] = [
      detectStep(this.deps.config, platform),
      versionStep(this.deps.config, input, this.deps.versionCodeProvider, platform),
      platform === 'ios' ? iosBuildStep(this.deps.builder) : androidBuildStep(this.deps.builder, input.artifactType ?? 'apk'),
      verifySigningStep(this.deps.signing),
    ];
    return new Pipeline(steps).run({ cwd: input.cwd, dryRun: input.dryRun, recorder: this.deps.recorder });
  }
}
