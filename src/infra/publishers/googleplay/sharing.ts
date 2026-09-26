import type { PlaySharingTargetConfig } from '../../../core/config/schema.js';
import { UploadError } from '../../../core/errors.js';
import type { StepContext } from '../../../core/pipeline/types.js';
import type { Publisher, PublishRequest, PublishResult } from '../../../core/ports/index.js';
import type { TokenProvider } from '../firebase/auth.js';
import { PlayApiClient } from './client.js';

export interface PlaySharingPublisherOptions {
  config: PlaySharingTargetConfig;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

/**
 * Play Internal App Sharing publisher: uploads an APK or AAB and returns a
 * download URL anyone with the link (and an allowlisted Google account) can
 * install from. No edit session, no track assignment.
 */
export class PlaySharingPublisher implements Publisher {
  readonly target = 'playsharing';

  private readonly client: PlayApiClient;

  constructor(private readonly options: PlaySharingPublisherOptions) {
    this.client = new PlayApiClient({ tokenProvider: options.tokenProvider, fetchImpl: options.fetchImpl });
  }

  async publish(ctx: StepContext, request: PublishRequest): Promise<PublishResult> {
    const { packageName } = this.options.config;
    const kind = request.artifact.kind === 'aab' ? 'aab' : 'apk';

    if (ctx.dryRun) {
      ctx.log('stdout', `[dry-run] would upload ${request.artifact.path} to Internal App Sharing for ${packageName}`);
      return { target: this.target };
    }

    ctx.progress(10, 'Uploading to Internal App Sharing');
    const artifact = await this.client.uploadSharingArtifact(packageName, kind, request.artifact.path);
    if (!artifact.downloadUrl) {
      throw new UploadError('Internal App Sharing upload succeeded but returned no downloadUrl', {
        context: { packageName },
      });
    }

    ctx.log('stdout', `Internal App Sharing download URL: ${artifact.downloadUrl}`);
    ctx.progress(100, 'Done');
    return { target: this.target, releaseName: packageName, url: artifact.downloadUrl };
  }
}
