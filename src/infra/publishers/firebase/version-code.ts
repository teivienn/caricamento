import type { VersionCodeProvider } from '../../../core/ports/index.js';
import type { FirebaseTargetConfig } from '../../../core/config/schema.js';
import { firebaseAppResource } from './app-resource.js';
import type { TokenProvider } from './auth.js';
import { fetchAllReleases } from './releases.js';

export interface FirebaseVersionCodeProviderOptions {
  config: FirebaseTargetConfig;
  platform: 'android' | 'ios';
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

/**
 * Highest versionCode known to Firebase App Distribution (SPEC §8):
 * releases.list returns each release's `buildVersion`. Returns null when the
 * app has no releases yet. Caveat: this tracks only builds uploaded to
 * Firebase — releases that bypassed it are invisible here.
 */
export class FirebaseVersionCodeProvider implements VersionCodeProvider {
  readonly name = 'firebase';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FirebaseVersionCodeProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async maxVersionCode(): Promise<number | null> {
    const app = firebaseAppResource(this.options.config, this.options.platform);
    const token = await this.options.tokenProvider();
    const releases = await fetchAllReleases(this.fetchImpl, app, token);

    let max: number | null = null;
    for (const release of releases) {
      const value = Number(release.buildVersion);
      if (Number.isFinite(value) && (max === null || value > max)) max = value;
    }
    return max;
  }
}
