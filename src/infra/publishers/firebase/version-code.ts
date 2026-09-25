import type { VersionCodeProvider } from '../../../core/ports/index.js';
import type { FirebaseTargetConfig } from '../../../core/config/schema.js';
import { UploadError } from '../../../core/errors.js';
import { firebaseAppResource } from './app-resource.js';
import type { TokenProvider } from './auth.js';

const API_BASE = 'https://firebaseappdistribution.googleapis.com';
const PAGE_SIZE = 100;

export interface FirebaseVersionCodeProviderOptions {
  config: FirebaseTargetConfig;
  platform: 'android' | 'ios';
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

interface ReleasesPage {
  releases?: Array<{ buildVersion?: string }>;
  nextPageToken?: string;
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

    let max: number | null = null;
    let pageToken: string | undefined;
    do {
      const url = new URL(`${API_BASE}/v1/${app}/releases`);
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      const text = await response.text();
      if (!response.ok) {
        throw new UploadError(`Firebase API error during releases.list: HTTP ${response.status}`, {
          hint: response.status === 401 || response.status === 403
            ? 'Check that the service account has the Firebase App Distribution Admin role.'
            : undefined,
          context: { status: response.status, body: text.slice(0, 500) },
        });
      }
      const page = JSON.parse(text) as ReleasesPage;
      for (const release of page.releases ?? []) {
        const value = Number(release.buildVersion);
        if (Number.isFinite(value) && (max === null || value > max)) max = value;
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);

    return max;
  }
}
