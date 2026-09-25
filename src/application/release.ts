import type { CaricamentoConfig } from '../core/config/schema.js';
import { ValidationError } from '../core/errors.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Builder, Publisher, SigningProvider, VersionCodeProvider } from '../core/ports/index.js';
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
  /** Backs the auto-increment version strategy (SPEC §8); wired from targets.play. */
  versionCodeProvider?: VersionCodeProvider;
  recorder?: RunRecorder;
}

export class ReleaseUseCase implements UseCase<ReleaseInput> {
  constructor(private readonly deps: ReleaseUseCaseDeps) {}

  run(input: ReleaseInput): AsyncIterable<RunEvent> {
    // Play only accepts AAB; Firebase accepts both, so switching is safe for
    // combined firebase+play runs.
    const requestedType = input.artifactType ?? 'apk';
    const artifactType = input.targets.includes('play') ? 'aab' : requestedType;
    const steps: Step[] = [
      detectStep(this.deps.config, 'android'),
      versionStep(this.deps.config, input, this.deps.versionCodeProvider),
      androidBuildStep(this.deps.builder, artifactType, requestedType),
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
