import { ValidationError } from '../core/errors.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Publisher } from '../core/ports/index.js';
import { locateArtifactStep, publishStep } from './steps.js';

export interface UploadInput {
  cwd: string;
  target: string;
  artifactPath?: string;
  artifactType?: 'aab' | 'apk' | 'ipa';
  releaseNotes?: string;
  dryRun?: boolean;
}

export interface UploadUseCaseDeps {
  publishers: Record<string, Publisher>;
  recorder?: RunRecorder;
}

export class UploadUseCase implements UseCase<UploadInput> {
  constructor(private readonly deps: UploadUseCaseDeps) {}

  run(input: UploadInput): AsyncIterable<RunEvent> {
    const publisher = this.deps.publishers[input.target];
    if (!publisher) {
      throw new ValidationError(`Unknown upload target "${input.target}"`, {
        hint: `Available targets: ${Object.keys(this.deps.publishers).join(', ') || '(none configured)'}.`,
      });
    }
    const steps: Step[] = [
      locateArtifactStep(input.artifactPath, input.artifactType ?? 'apk'),
      publishStep(publisher, input.releaseNotes),
    ];
    return new Pipeline(steps).run({ cwd: input.cwd, dryRun: input.dryRun, recorder: this.deps.recorder });
  }
}
