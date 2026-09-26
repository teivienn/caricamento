import { readFile } from 'node:fs/promises';
import { UploadError } from '../../../core/errors.js';
import type { TokenProvider } from '../firebase/auth.js';

// Paths and hosts below are taken from the API discovery document
// (https://androidpublisher.googleapis.com/$discovery/rest?version=v3):
// rootUrl is https://androidpublisher.googleapis.com/ and media uploads live
// on the SAME host under /upload/... — the upload.<api>.googleapis.com
// subdomain pattern is NOT valid (its TLS cert only covers *.googleapis.com,
// one level deep).
const API_BASE = 'https://androidpublisher.googleapis.com';
const MAX_RETRIES = 3;

export interface PlayClientOptions {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

export interface AppEdit {
  id: string;
}

export interface Bundle {
  versionCode?: number;
}

export interface TrackRelease {
  versionCodes?: string[];
  status?: string;
}

export interface Track {
  track?: string;
  releases?: TrackRelease[];
}

export interface TracksListResponse {
  tracks?: Track[];
}

export interface TrackUpdate {
  releases: Array<{
    versionCodes: string[];
    status: string;
    releaseNotes?: Array<{ language: string; text: string }>;
  }>;
}

export interface InternalAppSharingArtifact {
  downloadUrl?: string;
  sha256?: string;
  certificateFingerprint?: string;
}

/**
 * Thin REST client for the Play Developer API v3 (SPEC §7.2), shared by
 * PlayPublisher and PlayVersionCodeProvider. Mirrors the Firebase publisher's
 * approach: native fetch, exponential backoff, no retries on 4xx.
 */
export class PlayApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PlayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async insertEdit(packageName: string): Promise<AppEdit> {
    return this.withRetries(async () => {
      const response = await this.fetchImpl(`${API_BASE}/androidpublisher/v3/applications/${packageName}/edits`, {
        method: 'POST',
        headers: await this.jsonHeaders(),
        body: JSON.stringify({}),
      });
      return this.parseJson<AppEdit>(response, 'edits.insert');
    });
  }

  async deleteEdit(packageName: string, editId: string): Promise<void> {
    await this.withRetries(async () => {
      const response = await this.fetchImpl(
        `${API_BASE}/androidpublisher/v3/applications/${packageName}/edits/${editId}`,
        { method: 'DELETE', headers: await this.authHeaders() },
      );
      if (!response.ok) await this.throwForStatus(response, 'edits.delete');
    });
  }

  /** Best-effort cleanup: never throws. */
  async tryDeleteEdit(packageName: string, editId: string): Promise<void> {
    try {
      await this.deleteEdit(packageName, editId);
    } catch {
      // cleanup is best-effort; the original error is the one that matters
    }
  }

  async uploadBundle(packageName: string, editId: string, artifactPath: string): Promise<Bundle> {
    const body = await readFile(artifactPath);
    const url = `${API_BASE}/upload/androidpublisher/v3/applications/${packageName}/edits/${editId}/bundles`;
    return this.withRetries(async () => {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...(await this.authHeaders()),
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: new Uint8Array(body),
      });
      return this.parseJson<Bundle>(response, 'edits.bundles.upload');
    });
  }

  async uploadDeobfuscationFile(
    packageName: string,
    editId: string,
    versionCode: number,
    mappingPath: string,
  ): Promise<void> {
    const body = await readFile(mappingPath);
    const url =
      `${API_BASE}/upload/androidpublisher/v3/applications/${packageName}/edits/${editId}` +
      `/apks/${versionCode}/deobfuscationFiles/proguard`;
    return this.withRetries(async () => {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...(await this.authHeaders()),
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: new Uint8Array(body),
      });
      await this.parseJson<unknown>(response, 'edits.deobfuscationfiles.upload');
    });
  }

  async updateTrack(packageName: string, editId: string, track: string, update: TrackUpdate): Promise<void> {
    await this.withRetries(async () => {
      const response = await this.fetchImpl(
        `${API_BASE}/androidpublisher/v3/applications/${packageName}/edits/${editId}/tracks/${track}`,
        { method: 'PUT', headers: await this.jsonHeaders(), body: JSON.stringify(update) },
      );
      await this.parseJson<unknown>(response, 'edits.tracks.update');
    });
  }

  async commitEdit(packageName: string, editId: string): Promise<void> {
    await this.withRetries(async () => {
      const response = await this.fetchImpl(
        `${API_BASE}/androidpublisher/v3/applications/${packageName}/edits/${editId}:commit`,
        { method: 'POST', headers: await this.jsonHeaders() },
      );
      await this.parseJson<unknown>(response, 'edits.commit');
    });
  }

  /**
   * Internal App Sharing upload (androidpublisher.internalappsharingartifacts
   * .uploadapk/.uploadbundle): same host, /upload/... path, no edit session.
   */
  async uploadSharingArtifact(
    packageName: string,
    kind: 'apk' | 'aab',
    artifactPath: string,
  ): Promise<InternalAppSharingArtifact> {
    const body = await readFile(artifactPath);
    const artifactType = kind === 'aab' ? 'bundle' : 'apk';
    const url = `${API_BASE}/upload/androidpublisher/v3/applications/internalappsharing/${packageName}/artifacts/${artifactType}`;
    return this.withRetries(async () => {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...(await this.authHeaders()),
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: new Uint8Array(body),
      });
      return this.parseJson<InternalAppSharingArtifact>(response, 'internalappsharingartifacts.upload');
    });
  }

  async listTracks(packageName: string, editId: string): Promise<Track[]> {    const response = await this.withRetries(async () => {
      const res = await this.fetchImpl(
        `${API_BASE}/androidpublisher/v3/applications/${packageName}/edits/${editId}/tracks`,
        { method: 'GET', headers: await this.authHeaders() },
      );
      return this.parseJson<TracksListResponse>(res, 'edits.tracks.list');
    });
    return response.tracks ?? [];
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.options.tokenProvider();
    return { Authorization: `Bearer ${token}` };
  }

  private async jsonHeaders(): Promise<Record<string, string>> {
    return { ...(await this.authHeaders()), 'Content-Type': 'application/json' };
  }

  private async parseJson<T>(response: Response, what: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) await this.throwForStatus(response, what, text);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      throw new UploadError(`Google Play API returned invalid JSON during ${what}`, { cause: err });
    }
  }

  private async throwForStatus(response: Response, what: string, body?: string): Promise<never> {
    const text = body ?? (await response.text());
    const apiMessage = extractApiMessage(text);
    throw new UploadError(`Google Play API error during ${what}: HTTP ${response.status}${apiMessage ? ` — ${apiMessage}` : ''}`, {
      hint:
        response.status === 401 || response.status === 403
          ? 'Check that the service account is invited in Play Console (Users and permissions) with release permissions for this app.'
          : response.status === 404
            ? 'Check that targets.play.packageName matches an existing app in Play Console.'
            : undefined,
      context: { status: response.status, body: text.slice(0, 500) },
    });
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (err instanceof UploadError && err.context.status !== undefined) {
          const status = Number(err.context.status);
          if (status >= 400 && status < 500) throw err;
        }
        if (attempt < MAX_RETRIES) await sleep(2 ** attempt * 500);
      }
    }
    throw lastError;
  }
}

function extractApiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
