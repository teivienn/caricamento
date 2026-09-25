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
    const releaseNotes = request.releaseNotes ?? this.options.config.releaseNotes;
    const mapping = request.artifacts?.find((a) => a.kind === 'mapping');

    if (ctx.dryRun) {
      ctx.log(
        'stdout',
        `[dry-run] would upload ${request.artifact.path} to ${packageName} on track "${track}" (status: ${status})` +
          (mapping ? ` with mapping ${mapping.path}` : ''),
      );
      return { target: this.target };
    }

    ctx.progress(5, 'Opening edit');
    const edit = await this.client.insertEdit(packageName);
    ctx.log('stdout', `Edit opened: ${edit.id}`);

    try {
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

      ctx.progress(70, `Assigning to track "${track}"`);
      await this.client.updateTrack(packageName, edit.id, track, {
        releases: [
          {
            versionCodes: [String(bundle.versionCode)],
            status,
            ...(releaseNotes ? { releaseNotes: [{ language: 'en-US', text: releaseNotes }] } : {}),
          },
        ],
      });

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
}
