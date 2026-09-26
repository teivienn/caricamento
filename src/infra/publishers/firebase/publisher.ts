import { readFile } from 'node:fs/promises';
import type { FirebaseTargetConfig } from '../../../core/config/schema.js';
import { UploadError } from '../../../core/errors.js';
import type { StepContext } from '../../../core/pipeline/types.js';
import type { Publisher, PublishRequest, PublishResult } from '../../../core/ports/index.js';
import { firebaseAppResource } from './app-resource.js';
import type { TokenProvider } from './auth.js';
import { fetchAllReleases } from './releases.js';

const API_BASE = 'https://firebaseappdistribution.googleapis.com';
// Media upload lives on the SAME host under /upload/... — the
// upload.<api>.googleapis.com subdomain pattern is NOT valid for this API
// (its TLS cert only covers *.googleapis.com, one level deep).
const UPLOAD_BASE = API_BASE;
const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export interface FirebasePublisherOptions {
  config: FirebaseTargetConfig;
  platform: 'android' | 'ios';
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface Operation {
  name: string;
  done?: boolean;
  error?: { message?: string };
  response?: { release?: { name?: string }; name?: string };
}

/**
 * Pure-REST Firebase App Distribution publisher (SPEC §7.3):
 * media upload -> poll long-running operation -> PATCH release notes ->
 * POST distribute to groups/testers.
 */
export class FirebasePublisher implements Publisher {
  readonly target = 'firebase';

  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly options: FirebasePublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  private appResource(): string {
    return firebaseAppResource(this.options.config, this.options.platform);
  }

  async publish(ctx: StepContext, request: PublishRequest): Promise<PublishResult> {
    const app = this.appResource();
    // Priority: --release-notes flag > target config > generated changelog.
    const releaseNotes = request.releaseNotes ?? this.options.config.releaseNotes ?? request.generatedReleaseNotes;
    // The API expects bare group aliases ("qa"), NOT resource names ("groups/qa").
    const groups = this.options.config.groups.map((g) => g.replace(/^groups\//, ''));

    if (ctx.dryRun) {
      ctx.log('stdout', `[dry-run] would upload ${request.artifact.path} to ${app} and distribute to [${groups.join(', ')}]`);
      return { target: this.target };
    }

    const token = await this.options.tokenProvider();
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Idempotency (SPEC §9): a release with this buildVersion was already
    // uploaded — skip the upload and notes, but still distribute.
    let releaseName: string | undefined;
    if (request.versionCode !== undefined) {
      releaseName = await this.findExistingRelease(app, request.versionCode, token, ctx);
    }

    if (releaseName) {
      ctx.log('stdout', `versionCode ${request.versionCode} already uploaded as ${releaseName} — skipping upload`);
    } else {
      ctx.progress(5, 'Uploading binary');
      const operation = await this.upload(app, request.artifact.path, authHeaders);

      ctx.progress(30, 'Processing upload');
      releaseName = await this.pollOperation(operation.name, authHeaders, ctx);
      ctx.log('stdout', `Release created: ${releaseName}`);

      if (releaseNotes) {
        ctx.progress(80, 'Setting release notes');
        await this.withRetries(() =>
          this.request('PATCH', `${API_BASE}/v1/${releaseName}?updateMask=release_notes.text`, authHeaders, {
            releaseNotes: { text: releaseNotes },
          }),
        );
      }
    }

    if (groups.length > 0 || this.options.config.testers.length > 0) {
      ctx.progress(90, 'Distributing to groups');
      await this.withRetries(() =>
        this.request('POST', `${API_BASE}/v1/${releaseName}:distribute`, authHeaders, {
          groupAliases: groups,
          testerEmails: this.options.config.testers,
        }),
      );
    }

    ctx.progress(100, 'Done');
    return {
      target: this.target,
      releaseName,
      url: `https://console.firebase.google.com/project/${app.split('/')[1]}/appdistribution`,
    };
  }

  private async findExistingRelease(
    app: string,
    versionCode: number,
    token: string,
    ctx: StepContext,
  ): Promise<string | undefined> {
    const releases = await this.withRetries(() => fetchAllReleases(this.fetchImpl, app, token));
    const existing = releases.find((r) => r.buildVersion === String(versionCode));
    if (existing && !existing.name) {
      ctx.log('stderr', `Found a release with buildVersion ${versionCode} but it has no resource name — uploading anyway`);
    }
    return existing?.name;
  }

  private async upload(app: string, artifactPath: string, headers: Record<string, string>): Promise<Operation> {
    const body = await readFile(artifactPath);
    const url = `${UPLOAD_BASE}/upload/v1/${app}/releases:upload`;
    return this.withRetries(async () => {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: new Uint8Array(body),
      });
      return this.parseJson<Operation>(response, 'upload');
    });
  }

  private async pollOperation(name: string, headers: Record<string, string>, ctx: StepContext): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const operation = await this.withRetries(() =>
        this.request('GET', `${API_BASE}/v1/${name}`, headers),
      );
      if (operation.done) {
        if (operation.error) {
          throw new UploadError(`Firebase upload operation failed: ${operation.error.message ?? 'unknown error'}`);
        }
        const releaseName = operation.response?.release?.name ?? operation.response?.name;
        if (!releaseName) {
          throw new UploadError('Firebase upload finished but returned no release name', {
            context: { operation: name },
          });
        }
        return releaseName;
      }
      if (Date.now() > deadline) {
        throw new UploadError('Timed out waiting for Firebase to process the upload', {
          hint: 'The binary may still appear in the Firebase console; check there before retrying.',
          context: { operation: name },
        });
      }
      ctx.log('stdout', `Waiting for Firebase to process ${name}...`);
      await sleep(this.pollIntervalMs);
    }
  }

  private async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Operation> {
    const response = await this.fetchImpl(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parseJson<Operation>(response, `${method} ${url}`);
  }

  private async parseJson<T>(response: Response, what: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new UploadError(`Firebase API error during ${what}: HTTP ${response.status}`, {
        hint: response.status === 401 || response.status === 403
          ? 'Check that the service account has the Firebase App Distribution Admin role.'
          : undefined,
        context: { status: response.status, body: text.slice(0, 500) },
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new UploadError(`Firebase API returned invalid JSON during ${what}`, { cause: err });
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
