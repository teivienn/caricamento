import type { CaricamentoConfig } from '../core/config/schema.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Builder, SigningProvider } from '../core/ports/index.js';
import { androidBuildStep, detectStep, verifySigningStep, versionStep, type VersionOverrides } from './steps.js';

export interface BuildInput extends VersionOverrides {
  cwd: string;
  artifactType?: 'aab' | 'apk';
  dryRun?: boolean;
}

export interface BuildUseCaseDeps {
  config: CaricamentoConfig;
  builder: Builder;
  signing: SigningProvider | null;
  recorder?: RunRecorder;
}

export class BuildUseCase implements UseCase<BuildInput> {
  constructor(private readonly deps: BuildUseCaseDeps) {}

  run(input: BuildInput): AsyncIterable<RunEvent> {
    const steps: Step[] = [
      detectStep(this.deps.config, 'android'),
      versionStep(this.deps.config, input),
      androidBuildStep(this.deps.builder, input.artifactType ?? 'apk'),
      verifySigningStep(this.deps.signing),
    ];
    return new Pipeline(steps).run({ cwd: input.cwd, dryRun: input.dryRun, recorder: this.deps.recorder });
  }
}
