import type { VersionCodeProvider } from '../../../core/ports/index.js';
import type { TokenProvider } from '../firebase/auth.js';
import { PlayApiClient } from './client.js';

export interface PlayVersionCodeProviderOptions {
  packageName: string;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

/**
 * Highest published versionCode across all Play tracks (SPEC §8): opens a
 * throwaway edit, reads edits.tracks.list, deletes the edit. Returns null
 * when no track has any release yet.
 */
export class PlayVersionCodeProvider implements VersionCodeProvider {
  readonly name = 'play';
  private readonly client: PlayApiClient;

  constructor(private readonly options: PlayVersionCodeProviderOptions) {
    this.client = new PlayApiClient({ tokenProvider: options.tokenProvider, fetchImpl: options.fetchImpl });
  }

  async maxVersionCode(): Promise<number | null> {
    const { packageName } = this.options;
    const edit = await this.client.insertEdit(packageName);
    try {
      const tracks = await this.client.listTracks(packageName, edit.id);
      let max: number | null = null;
      for (const track of tracks) {
        for (const release of track.releases ?? []) {
          for (const code of release.versionCodes ?? []) {
            const value = Number(code);
            if (Number.isFinite(value) && (max === null || value > max)) max = value;
          }
        }
      }
      return max;
    } finally {
      await this.client.tryDeleteEdit(packageName, edit.id);
    }
  }
}
