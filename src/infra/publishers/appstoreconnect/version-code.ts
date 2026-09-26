import { ValidationError } from '../../../core/errors.js';
import type { VersionCodeProvider } from '../../../core/ports/index.js';
import type { AppStoreConnectClient } from './client.js';

/**
 * Highest CFBundleVersion among the app's iOS builds in App Store Connect
 * (SPEC §8), across all versions and including expired builds. Only purely
 * numeric build numbers are considered ("1.2.3"-style values are ignored).
 * Returns null when the app has no builds yet.
 */
export class AppStoreVersionCodeProvider implements VersionCodeProvider {
  readonly name = 'appstore';

  constructor(private readonly options: { client: AppStoreConnectClient; bundleId: string }) {}

  async maxVersionCode(): Promise<number | null> {
    const app = await this.options.client.findApp(this.options.bundleId);
    if (!app) {
      throw new ValidationError(`No app with bundle ID ${this.options.bundleId} in App Store Connect`, {
        hint: 'Create the app record in App Store Connect first, or fix targets.appstore.bundleId.',
      });
    }
    let max: number | null = null;
    for (const build of await this.options.client.listBuilds(app.id)) {
      const version = build.attributes?.version ?? '';
      if (!/^\d+$/.test(version)) continue;
      const value = Number(version);
      if (max === null || value > max) max = value;
    }
    return max;
  }
}
