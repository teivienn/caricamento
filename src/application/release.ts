import type { CaricamentoConfig } from '../core/config/schema.js';
import { ValidationError } from '../core/errors.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Builder, Publisher, SigningProvider } from '../core/ports/index.js';
import {
  androidBuildStep,
  detectStep,
  publishStep,
  verifySigningStep,
  versionStep,
  type VersionOverrides,
} from './steps.js';

export interface ReleaseInput extends VersionOverrides {
  cwd: string;
  targets: string[];
  artifactType?: 'aab' | 'apk';
  releaseNotes?: string;
  dryRun?: boolean;
}

export interface ReleaseUseCaseDeps {
  config: CaricamentoConfig;
  builder: Builder;
  signing: SigningProvider | null;
  publishers: Record<string, Publisher>;
  recorder?: RunRecorder;
}

export class ReleaseUseCase implements UseCase<ReleaseInput> {
  constructor(private readonly deps: ReleaseUseCaseDeps) {}

  run(input: ReleaseInput): AsyncIterable<RunEvent> {
    const steps: Step[] = [
      detectStep(this.deps.config, 'android'),
      versionStep(this.deps.config, input),
      androidBuildStep(this.deps.builder, input.artifactType ?? 'apk'),
      verifySigningStep(this.deps.signing),
    ];
    for (const target of input.targets) {
      const publisher = this.deps.publishers[target];
      if (!publisher) {
        throw new ValidationError(`Unknown release target "${target}"`, {
          hint: `Available targets: ${Object.keys(this.deps.publishers).join(', ') || '(none configured)'}.`,
        });
      }
      steps.push(publishStep(publisher, input.releaseNotes));
    }
    return new Pipeline(steps).run({ cwd: input.cwd, dryRun: input.dryRun, recorder: this.deps.recorder });
  }
}
