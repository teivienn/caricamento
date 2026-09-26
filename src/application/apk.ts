import { basename, dirname, join } from 'node:path';
import type { Artifact } from '../core/artifact/types.js';
import { ValidationError } from '../core/errors.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { ApkConverter } from '../core/ports/index.js';
import { locateArtifactStep } from './steps.js';

export interface ApkInput {
  cwd: string;
  /** Explicit AAB path; default: newest AAB in the build outputs. */
  artifactPath?: string;
  /** Output APK path; default: alongside the AAB as <name>-universal.apk. */
  outPath?: string;
  dryRun?: boolean;
}

export interface ApkUseCaseDeps {
  converter: ApkConverter;
  recorder?: RunRecorder;
}

/** AAB -> universal APK for local installation (SPEC §5.5, bundletool). */
export class ApkUseCase implements UseCase<ApkInput> {
  constructor(private readonly deps: ApkUseCaseDeps) {}

  run(input: ApkInput): AsyncIterable<RunEvent> {
    const steps: Step[] = [locateArtifactStep(input.artifactPath, 'aab'), this.convertStep(input)];
    return new Pipeline(steps).run({ cwd: input.cwd, dryRun: input.dryRun, recorder: this.deps.recorder });
  }

  private convertStep(input: ApkInput): Step {
    return {
      id: 'apk:convert',
      title: 'Convert AAB to universal APK',
      run: async (ctx) => {
        const artifacts = (ctx.data.get('artifacts') as Artifact[] | undefined) ?? [];
        const aab = artifacts.find((a) => a.kind === 'aab');
        if (!aab) {
          if (ctx.dryRun) return;
          throw new ValidationError('No AAB artifact available for conversion');
        }
        const outPath = input.outPath ?? join(dirname(aab.path), `${basename(aab.path, '.aab')}-universal.apk`);
        if (ctx.dryRun) {
          ctx.log('stdout', `[dry-run] would convert ${aab.path} to ${outPath} via bundletool`);
          return;
        }
        const apkPath = await this.deps.converter.buildUniversalApk(ctx, aab.path, outPath);
        const apk: Artifact = { kind: 'apk', platform: 'android', path: apkPath };
        return { artifacts: [apk], data: { apkPath } };
      },
    };
  }
}
