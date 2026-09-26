import type { PlayTargetConfig } from '../../../core/config/schema.js';
import { UploadError, ValidationError } from '../../../core/errors.js';
import type { StepContext } from '../../../core/pipeline/types.js';
import type { Publisher, PublishRequest, PublishResult } from '../../../core/ports/index.js';
import type { TokenProvider } from '../firebase/auth.js';
import { PlayApiClient } from './client.js';

export interface PlayPublisherOptions {
  config: PlayTargetConfig;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

/**
 * Pure-REST Google Play publisher (SPEC §7.2): transactional edit flow —
 * edits.insert -> bundles.upload (AAB) -> deobfuscationfiles.upload (mapping,
 * when present) -> tracks.update -> edits.commit. On any failure after the
 * edit is created the edit is deleted best-effort.
 *
 * Idempotency (SPEC §9): versionCodes can never be re-uploaded to Play, so
 * before opening the real edit a throwaway edit probes edits.tracks.list.
 * When the versionCode already exists, the bundle upload is skipped; if the
 * target track lacks it, only a tracks.update is committed (basic track
 * reuse); if it is already on the target track, nothing is committed at all.
 */
export class PlayPublisher implements Publisher {
  readonly target = 'play';

  private readonly client: PlayApiClient;

  constructor(private readonly options: PlayPublisherOptions) {
    this.client = new PlayApiClient({ tokenProvider: options.tokenProvider, fetchImpl: options.fetchImpl });
  }

  async publish(ctx: StepContext, request: PublishRequest): Promise<PublishResult> {
    const { packageName, track, status } = this.options.config;
    if (request.artifact.kind !== 'aab') {
      throw new ValidationError('Google Play requires an AAB artifact', {
        hint: 'Build with --artifact-type aab (the release command switches automatically when play is among the targets).',
        context: { kind: request.artifact.kind },
      });
    }
    // Priority: --release-notes flag > target config > generated changelog.
    const releaseNotes = request.releaseNotes ?? this.options.config.releaseNotes ?? request.generatedReleaseNotes;
    const mapping = request.artifacts?.find((a) => a.kind === 'mapping');

    if (ctx.dryRun) {
      ctx.log(
        'stdout',
        `[dry-run] would upload ${request.artifact.path} to ${packageName} on track "${track}" (status: ${status})` +
          (mapping ? ` with mapping ${mapping.path}` : ''),
      );
      return { target: this.target };
    }

    const existing = await this.probeExistingVersionCode(packageName, request.versionCode);
    if (existing?.onTargetTrack) {
      ctx.log('stdout', `versionCode ${request.versionCode} is already published on track "${track}" — nothing to do`);
      return { target: this.target, releaseName: `${packageName}@${track}`, url: 'https://play.google.com/console' };
    }

    ctx.progress(5, 'Opening edit');
    const edit = await this.client.insertEdit(packageName);
    ctx.log('stdout', `Edit opened: ${edit.id}`);

    try {
      if (existing) {
        // The AAB is already on Play — only re-assign the existing code.
        ctx.log('stdout', `versionCode ${existing.versionCode} already uploaded — skipping bundle upload`);
        await this.assignTrack(packageName, edit.id, track, existing.versionCode, status, releaseNotes, ctx);
      } else {
        ctx.progress(15, 'Uploading AAB');
        const bundle = await this.client.uploadBundle(packageName, edit.id, request.artifact.path);
        if (bundle.versionCode === undefined) {
          throw new UploadError('Google Play accepted the bundle but returned no versionCode', {
            context: { editId: edit.id },
          });
        }
        ctx.log('stdout', `Bundle uploaded: versionCode=${bundle.versionCode}`);

        if (mapping) {
          ctx.progress(55, 'Uploading mapping.txt');
          await this.client.uploadDeobfuscationFile(packageName, edit.id, bundle.versionCode, mapping.path);
        }

        await this.assignTrack(packageName, edit.id, track, bundle.versionCode, status, releaseNotes, ctx);
      }

      ctx.progress(90, 'Committing edit');
      await this.client.commitEdit(packageName, edit.id);
    } catch (err) {
      ctx.log('stderr', `Edit failed, deleting edit ${edit.id} (best effort)`);
      await this.client.tryDeleteEdit(packageName, edit.id);
      throw err;
    }

    ctx.progress(100, 'Done');
    return {
      target: this.target,
      releaseName: `${packageName}@${track}`,
      url: `https://play.google.com/console`,
    };
  }

  private async assignTrack(
    packageName: string,
    editId: string,
    track: string,
    versionCode: number,
    status: string,
    releaseNotes: string | undefined,
    ctx: StepContext,
  ): Promise<void> {
    ctx.progress(70, `Assigning to track "${track}"`);
    await this.client.updateTrack(packageName, editId, track, {
      releases: [
        {
          versionCodes: [String(versionCode)],
          status,
          ...(releaseNotes ? { releaseNotes: [{ language: 'en-US', text: releaseNotes }] } : {}),
        },
      ],
    });
  }

  /**
   * Throwaway edit -> tracks.list -> delete. Returns the versionCode's
   * current location, or undefined when it is unknown to Play (or when no
   * versionCode was resolved for this run — then the probe is skipped).
   */
  private async probeExistingVersionCode(
    packageName: string,
    versionCode: number | undefined,
  ): Promise<{ versionCode: number; onTargetTrack: boolean } | undefined> {
    if (versionCode === undefined) return undefined;
    const probe = await this.client.insertEdit(packageName);
    try {
      const tracks = await this.client.listTracks(packageName, probe.id);
      const code = String(versionCode);
      let somewhere = false;
      let onTargetTrack = false;
      for (const t of tracks) {
        for (const release of t.releases ?? []) {
          if (release.versionCodes?.includes(code)) {
            somewhere = true;
            if (t.track === this.options.config.track) onTargetTrack = true;
          }
        }
      }
      return somewhere ? { versionCode, onTargetTrack } : undefined;
    } finally {
      await this.client.tryDeleteEdit(packageName, probe.id);
    }
  }
}
