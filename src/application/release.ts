import type { CaricamentoConfig, Platform } from '../core/config/schema.js';
import { ValidationError } from '../core/errors.js';
import { Pipeline, type RunRecorder } from '../core/pipeline/pipeline.js';
import type { RunEvent, Step, UseCase } from '../core/pipeline/types.js';
import type { Builder, ChangelogProvider, Publisher, SigningProvider, VersionCodeProvider } from '../core/ports/index.js';
import {
  androidBuildStep,
  changelogStep,
  detectStep,
  iosBuildStep,
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
  /** Platform the builder/signing/publishers were wired for. Default: android. */
  platform?: Platform;
  builder: Builder;
  signing: SigningProvider | null;
  publishers: Record<string, Publisher>;
  /** Backs the auto-increment version strategy (SPEC §8); wired from targets.play. */
  versionCodeProvider?: VersionCodeProvider;
  /** Generates release notes from git when configured (SPEC §7). */
  changelog?: ChangelogProvider;
  recorder?: RunRecorder;
}

export class ReleaseUseCase implements UseCase<ReleaseInput> {
  constructor(private readonly deps: ReleaseUseCaseDeps) {}

  run(input: ReleaseInput): AsyncIterable<RunEvent> {
    const platform = this.deps.platform ?? 'android';
    if (platform === 'ios' && input.targets.includes('appstore') && this.deps.config.ios?.signing.mode === 'none') {
      throw new ValidationError('Unsigned builds (ios.signing.mode "none") cannot be published to App Store Connect', {
        hint: 'Switch ios.signing.mode to "automatic" or "manual" for releases.',
      });
    }
    // Play only accepts AAB; Firebase accepts both, so switching is safe for
    // combined firebase+play runs.
    const requestedType = input.artifactType ?? 'apk';
    const artifactType = input.targets.includes('play') ? 'aab' : requestedType;
    const steps: Step[] = [
      detectStep(this.deps.config, platform),
      versionStep(this.deps.config, input, this.deps.versionCodeProvider, platform),
      platform === 'ios' ? iosBuildStep(this.deps.builder) : androidBuildStep(this.deps.builder, artifactType, requestedType),
      verifySigningStep(this.deps.signing),
    ];
    if (this.needsChangelog(input)) {
      steps.push(changelogStep(this.deps.changelog!));
    }
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

  /**
   * Changelog generation runs only when it can actually be used: the block is
   * configured, no --release-notes flag was passed, and at least one target
   * has no target-level releaseNotes (priority: flag > target config > git).
   */
  private needsChangelog(input: ReleaseInput): boolean {
    if (!this.deps.changelog || !this.deps.config.changelog || input.releaseNotes) return false;
    // appstore's "What to Test" plays the role of releaseNotes.
    const targets = this.deps.config.targets as Record<string, { releaseNotes?: string; whatToTest?: string } | undefined>;
    return input.targets.some((t) => !(targets[t]?.releaseNotes ?? targets[t]?.whatToTest));
  }
}
