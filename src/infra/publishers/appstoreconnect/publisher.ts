import type { AppStoreTargetConfig } from '../../../core/config/schema.js';
import { ValidationError } from '../../../core/errors.js';
import type { StepContext } from '../../../core/pipeline/types.js';
import type { Publisher, PublishRequest, PublishResult } from '../../../core/ports/index.js';
import type { AppStoreConnectClient, AscBetaGroup } from './client.js';
import type { IpaInfoReader } from './ipa-info.js';
import type { AscBuildUploader } from './upload.js';

const POLL_INTERVAL_MS = 30_000;

export interface AppStorePublisherOptions {
  config: AppStoreTargetConfig;
  client: AppStoreConnectClient;
  uploader: AscBuildUploader;
  ipaInfo: IpaInfoReader;
  pollIntervalMs?: number;
}

/**
 * App Store Connect / TestFlight publisher (SPEC §7.1):
 * upload (Build Uploads API or altool) → poll processingState until VALID
 * (bounded by processingTimeoutMinutes) → "What to Test" → beta groups.
 *
 * "What to Test" is set before the build is added to groups so testers are
 * notified with the notes already in place.
 *
 * Idempotency (SPEC §9): when a build with the same CFBundleVersion already
 * exists for this version, the upload is skipped and distribution resumes.
 */
export class AppStorePublisher implements Publisher {
  readonly target = 'appstore';

  constructor(private readonly options: AppStorePublisherOptions) {}

  async publish(ctx: StepContext, request: PublishRequest): Promise<PublishResult> {
    const { config, client } = this.options;
    if (config.distributeTo === 'appstore') {
      throw new ValidationError('targets.appstore.distributeTo "appstore" (App Store review submission) is not implemented yet', {
        hint: 'Use distributeTo: "testflight" and submit for review in App Store Connect; review submission is on the roadmap (SPEC §7.1).',
      });
    }
    if (request.artifact.kind !== 'ipa') {
      throw new ValidationError('App Store Connect requires an .ipa artifact', {
        hint: 'Build with --platform ios (or pass --artifact <path>.ipa).',
        context: { kind: request.artifact.kind },
      });
    }
    const whatToTest = request.releaseNotes ?? config.whatToTest ?? request.generatedReleaseNotes;

    if (ctx.dryRun) {
      ctx.log(
        'stdout',
        `[dry-run] would upload ${request.artifact.path} to App Store Connect (${config.bundleId}) via ${this.options.uploader.name}, ` +
          `wait up to ${config.processingTimeoutMinutes} min for processing, then distribute to TestFlight groups [${config.betaGroups.join(', ')}]`,
      );
      return { target: this.target };
    }

    const { shortVersion, bundleVersion } = await this.versions(request);

    ctx.progress(2, 'Looking up the app');
    const app = await client.findApp(config.bundleId);
    if (!app) {
      throw new ValidationError(`No app with bundle ID ${config.bundleId} in App Store Connect`, {
        hint: 'Create the app record in App Store Connect (My Apps → +) first, or fix targets.appstore.bundleId.',
      });
    }
    const groups = await this.resolveGroups(app.id);

    let buildUploadId: string | undefined;
    const existing = await client.findBuild(app.id, bundleVersion, shortVersion);
    if (existing) {
      ctx.log('stdout', `Build ${shortVersion} (${bundleVersion}) already exists in App Store Connect — skipping upload`);
    } else {
      ctx.progress(5, `Uploading via ${this.options.uploader.name}`);
      const result = await this.options.uploader.upload(ctx, {
        ipaPath: request.artifact.path,
        appId: app.id,
        bundleId: config.bundleId,
        shortVersion,
        bundleVersion,
      });
      buildUploadId = result.buildUploadId;
    }

    ctx.progress(45, 'Waiting for App Store Connect processing');
    const timeoutMs = config.processingTimeoutMinutes * 60_000;
    const build = await client.pollBuildProcessing({
      appId: app.id,
      version: bundleVersion,
      shortVersion,
      buildUploadId,
      timeoutMs,
      intervalMs: this.options.pollIntervalMs ?? POLL_INTERVAL_MS,
      onProgress: (message, elapsedMs) => {
        ctx.progress(45 + Math.min(40, Math.round((elapsedMs / timeoutMs) * 40)), 'Waiting for App Store Connect processing');
        ctx.log('stdout', `Processing (${Math.round(elapsedMs / 1000)}s): ${message}`);
      },
    });
    ctx.log('stdout', `Build ${build.id} is VALID`);
    if (build.attributes?.usesNonExemptEncryption == null) {
      ctx.log(
        'stderr',
        'Export compliance is not declared — TestFlight will show "Missing Compliance" until you answer it in App Store Connect ' +
          '(or set ITSAppUsesNonExemptEncryption in Info.plist).',
      );
    }

    if (whatToTest) {
      ctx.progress(88, 'Setting What to Test');
      await client.setWhatToTest(build.id, config.locale, whatToTest);
    }
    for (const group of groups) {
      ctx.progress(92, `Adding to beta group "${group.attributes?.name}"`);
      await client.addBuildToBetaGroup(group.id, build.id);
      ctx.log('stdout', `Added to beta group "${group.attributes?.name}"`);
    }

    ctx.progress(100, 'Done');
    return {
      target: this.target,
      releaseName: `${config.bundleId} ${shortVersion} (${bundleVersion})`,
      url: `https://appstoreconnect.apple.com/apps/${app.id}/testflight/ios`,
    };
  }

  /** Values embedded in the binary win; the resolved version is the fallback (no unzip/plutil). */
  private async versions(request: PublishRequest): Promise<{ shortVersion: string; bundleVersion: string }> {
    const info = await this.options.ipaInfo.read(request.artifact.path);
    if (info?.bundleId && info.bundleId !== this.options.config.bundleId) {
      throw new ValidationError(`The .ipa has bundle ID ${info.bundleId}, but targets.appstore.bundleId is ${this.options.config.bundleId}`, {
        hint: 'Set ios.signing.bundleId (or the variant bundleId) to match, or fix targets.appstore.bundleId.',
      });
    }
    const shortVersion = info?.shortVersion ?? request.versionName;
    const bundleVersion = info?.bundleVersion ?? (request.versionCode !== undefined ? String(request.versionCode) : undefined);
    if (!shortVersion || !bundleVersion) {
      throw new ValidationError('Could not determine CFBundleShortVersionString / CFBundleVersion of the .ipa', {
        hint: 'Set version.name and a version strategy in the config (or --version / --build).',
      });
    }
    return { shortVersion, bundleVersion };
  }

  /** Resolved before uploading so a typo fails fast instead of after a 30-minute wait. */
  private async resolveGroups(appId: string): Promise<AscBetaGroup[]> {
    const wanted = this.options.config.betaGroups;
    if (wanted.length === 0) return [];
    const available = await this.options.client.listBetaGroups(appId);
    return wanted.map((name) => {
      const group = available.find((g) => g.attributes?.name === name);
      if (!group) {
        throw new ValidationError(`TestFlight beta group "${name}" does not exist for this app`, {
          hint: `Available groups: ${available.map((g) => g.attributes?.name).join(', ') || '(none)'}.`,
        });
      }
      return group;
    });
  }
}
