import { UploadError } from '../../../core/errors.js';
import type { AscTokenProvider } from './jwt.js';

export const ASC_API_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_RETRIES = 3;

export interface AscClientOptions {
  tokenProvider: AscTokenProvider;
  fetchImpl?: typeof fetch;
  /** Base delay of the exponential backoff; lowered in tests. */
  retryBaseMs?: number;
}

export interface AscResource<A> {
  id: string;
  type: string;
  attributes?: A;
  relationships?: Record<string, { data?: { id: string; type: string } | null } | undefined>;
}

export type AscApp = AscResource<{ bundleId?: string; name?: string }>;
export type AscBuild = AscResource<{
  version?: string;
  processingState?: 'PROCESSING' | 'FAILED' | 'INVALID' | 'VALID';
  uploadedDate?: string;
  expired?: boolean;
  usesNonExemptEncryption?: boolean | null;
}>;
export type AscBetaGroup = AscResource<{ name?: string; isInternalGroup?: boolean }>;
export type AscBetaBuildLocalization = AscResource<{ locale?: string; whatsNew?: string }>;

export interface AscStateDetail {
  code?: string;
  description?: string;
}

export type AscBuildUpload = AscResource<{
  cfBundleShortVersionString?: string;
  cfBundleVersion?: string;
  platform?: string;
  state?: {
    state?: 'AWAITING_UPLOAD' | 'PROCESSING' | 'FAILED' | 'COMPLETE';
    errors?: AscStateDetail[];
    warnings?: AscStateDetail[];
    infos?: AscStateDetail[];
  };
}>;

/** DeliveryFileUploadOperation: one presigned request to perform. */
export interface AscUploadOperation {
  method?: string;
  url?: string;
  offset?: number;
  length?: number;
  partNumber?: number;
  expiration?: string;
  requestHeaders?: Array<{ name?: string; value?: string }>;
}

export type AscBuildUploadFile = AscResource<{
  fileName?: string;
  fileSize?: number;
  assetType?: string;
  uti?: string;
  uploadOperations?: AscUploadOperation[];
  assetDeliveryState?: { state?: string; errors?: AscStateDetail[] };
}>;

interface Document<T> {
  data: T;
  links?: { next?: string };
}

export interface PollBuildOptions {
  appId: string;
  /** CFBundleVersion. */
  version: string;
  /** CFBundleShortVersionString (narrows the lookup when known). */
  shortVersion?: string;
  /** Build Uploads API id — lets the poll surface upload validation failures early. */
  buildUploadId?: string;
  timeoutMs: number;
  intervalMs: number;
  onProgress?: (message: string, elapsedMs: number) => void;
}

/**
 * Thin App Store Connect API client (SPEC §7.1): JWT bearer auth, JSON:API
 * documents, pagination via links.next, exponential backoff on 429/5xx and
 * network errors (never on other 4xx). Endpoint shapes follow Apple's
 * published reference (developer.apple.com/documentation/appstoreconnectapi).
 */
export class AppStoreConnectClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseMs: number;

  constructor(private readonly options: AscClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryBaseMs = options.retryBaseMs ?? 500;
  }

  // ---- apps & builds -------------------------------------------------------

  async listApps(bundleId: string): Promise<AscApp[]> {
    return this.getAll<AscApp>(`/v1/apps?${query({ 'filter[bundleId]': bundleId, limit: '200' })}`, 'list apps');
  }

  /** filter[bundleId] is not guaranteed to be an exact match — pick the exact one. */
  async findApp(bundleId: string): Promise<AscApp | undefined> {
    return (await this.listApps(bundleId)).find((app) => app.attributes?.bundleId === bundleId);
  }

  async listBuilds(appId: string, filters: { version?: string; shortVersion?: string } = {}): Promise<AscBuild[]> {
    const params: Record<string, string> = {
      'filter[app]': appId,
      'filter[preReleaseVersion.platform]': 'IOS',
      limit: '200',
    };
    if (filters.version !== undefined) params['filter[version]'] = filters.version;
    if (filters.shortVersion !== undefined) params['filter[preReleaseVersion.version]'] = filters.shortVersion;
    return this.getAll<AscBuild>(`/v1/builds?${query(params)}`, 'list builds');
  }

  async findBuild(appId: string, version: string, shortVersion?: string): Promise<AscBuild | undefined> {
    return (await this.listBuilds(appId, { version, shortVersion })).find((b) => b.attributes?.version === version);
  }

  /**
   * Polls until the build with this CFBundleVersion reaches processingState
   * VALID. FAILED/INVALID (or a FAILED build upload) throw immediately; the
   * wait is bounded by timeoutMs.
   */
  async pollBuildProcessing(options: PollBuildOptions): Promise<AscBuild> {
    const started = Date.now();
    for (;;) {
      const elapsed = Date.now() - started;
      if (options.buildUploadId) {
        const upload = await this.getBuildUpload(options.buildUploadId);
        const state = upload.attributes?.state;
        if (state?.state === 'FAILED') {
          throw new UploadError(`App Store Connect rejected the upload: ${describeDetails(state.errors) || 'no details'}`, {
            hint: 'Fix the reported issue (often a duplicate CFBundleVersion or a missing icon/entitlement) and upload again.',
            context: { buildUploadId: options.buildUploadId, errors: state.errors, warnings: state.warnings },
          });
        }
      }
      const build = await this.findBuild(options.appId, options.version, options.shortVersion);
      const processingState = build?.attributes?.processingState;
      if (build && processingState === 'VALID') return build;
      if (build && (processingState === 'FAILED' || processingState === 'INVALID')) {
        throw new UploadError(`Build ${options.version} finished processing as ${processingState}`, {
          hint: 'Apple usually e-mails the reason; see App Store Connect → TestFlight for details.',
          context: { buildId: build.id, processingState },
        });
      }
      if (elapsed > options.timeoutMs) {
        throw new UploadError(`Timed out after ${Math.round(elapsed / 60000)} min waiting for build ${options.version} to be processed`, {
          hint: 'The build may still finish processing; re-run the same release later — the upload is skipped when the build already exists.',
          context: { version: options.version, lastState: processingState ?? 'not visible yet' },
        });
      }
      options.onProgress?.(build ? `processingState=${processingState ?? 'unknown'}` : 'build not visible in App Store Connect yet', elapsed);
      await sleep(options.intervalMs);
    }
  }

  // ---- TestFlight ----------------------------------------------------------

  async listBetaGroups(appId: string): Promise<AscBetaGroup[]> {
    return this.getAll<AscBetaGroup>(`/v1/betaGroups?${query({ 'filter[app]': appId, limit: '200' })}`, 'list beta groups');
  }

  async addBuildToBetaGroup(groupId: string, buildId: string): Promise<void> {
    await this.request('POST', `/v1/betaGroups/${groupId}/relationships/builds`, 'add build to beta group', {
      data: [{ type: 'builds', id: buildId }],
    });
  }

  /** Creates or updates the build's "What to Test" localization for `locale`. */
  async setWhatToTest(buildId: string, locale: string, whatsNew: string): Promise<void> {
    const existing = await this.getAll<AscBetaBuildLocalization>(
      `/v1/builds/${buildId}/betaBuildLocalizations?limit=200`,
      'list beta build localizations',
    );
    const current = existing.find((l) => l.attributes?.locale === locale);
    if (current) {
      await this.request('PATCH', `/v1/betaBuildLocalizations/${current.id}`, 'update What to Test', {
        data: { type: 'betaBuildLocalizations', id: current.id, attributes: { whatsNew } },
      });
      return;
    }
    await this.request('POST', '/v1/betaBuildLocalizations', 'create What to Test', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale, whatsNew },
        relationships: { build: { data: { type: 'builds', id: buildId } } },
      },
    });
  }

  // ---- Build Uploads API ---------------------------------------------------

  async createBuildUpload(input: { appId: string; shortVersion: string; bundleVersion: string }): Promise<AscBuildUpload> {
    const doc = await this.request<Document<AscBuildUpload>>('POST', '/v1/buildUploads', 'create build upload', {
      data: {
        type: 'buildUploads',
        attributes: {
          cfBundleShortVersionString: input.shortVersion,
          cfBundleVersion: input.bundleVersion,
          platform: 'IOS',
        },
        relationships: { app: { data: { type: 'apps', id: input.appId } } },
      },
    });
    return doc.data;
  }

  async createBuildUploadFile(input: { buildUploadId: string; fileName: string; fileSize: number }): Promise<AscBuildUploadFile> {
    const doc = await this.request<Document<AscBuildUploadFile>>('POST', '/v1/buildUploadFiles', 'reserve build upload file', {
      data: {
        type: 'buildUploadFiles',
        attributes: { assetType: 'ASSET', fileName: input.fileName, fileSize: input.fileSize, uti: 'com.apple.ipa' },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: input.buildUploadId } } },
      },
    });
    return doc.data;
  }

  async commitBuildUploadFile(fileId: string): Promise<AscBuildUploadFile> {
    const doc = await this.request<Document<AscBuildUploadFile>>('PATCH', `/v1/buildUploadFiles/${fileId}`, 'commit build upload file', {
      data: { type: 'buildUploadFiles', id: fileId, attributes: { uploaded: true } },
    });
    return doc.data;
  }

  async getBuildUpload(id: string): Promise<AscBuildUpload> {
    return (await this.request<Document<AscBuildUpload>>('GET', `/v1/buildUploads/${id}`, 'read build upload')).data;
  }

  /**
   * Performs one presigned upload operation. The URL carries its own
   * credentials, so no Authorization header is sent — only the headers
   * Apple listed in requestHeaders.
   */
  async performUploadOperation(operation: AscUploadOperation, body: Uint8Array): Promise<void> {
    if (!operation.url) throw new UploadError('App Store Connect returned an upload operation without a URL');
    const headers: Record<string, string> = {};
    for (const header of operation.requestHeaders ?? []) {
      if (header.name && header.value !== undefined) headers[header.name] = header.value;
    }
    await this.withRetries(async () => {
      const response = await this.fetchImpl(operation.url!, { method: operation.method ?? 'PUT', headers, body });
      if (!response.ok) {
        const text = await response.text();
        throw new UploadError(`Uploading part ${operation.partNumber ?? '?'} failed: HTTP ${response.status}`, {
          context: { status: response.status, body: text.slice(0, 300) },
        });
      }
    });
  }

  // ---- transport -----------------------------------------------------------

  private async getAll<T>(path: string, what: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const doc: Document<T[]> = await this.request<Document<T[]>>('GET', next, what);
      items.push(...(doc.data ?? []));
      next = doc.links?.next;
    }
    return items;
  }

  private async request<T = unknown>(method: string, pathOrUrl: string, what: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${ASC_API_BASE}${pathOrUrl}`;
    return this.withRetries(async () => {
      const token = await this.options.tokenProvider();
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw apiError(response.status, text, what);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new UploadError(`App Store Connect returned invalid JSON during ${what}`, { cause: err });
      }
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
          if (status >= 400 && status < 500 && status !== 429) throw err;
        } else if (err instanceof UploadError) {
          throw err;
        }
        if (attempt < MAX_RETRIES) await sleep(2 ** attempt * this.retryBaseMs);
      }
    }
    throw lastError;
  }
}

function apiError(status: number, body: string, what: string): UploadError {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ title?: string; detail?: string; code?: string }> };
    detail = (parsed.errors ?? []).map((e) => e.detail ?? e.title ?? e.code).filter(Boolean).join('; ');
  } catch {
    // non-JSON error body
  }
  return new UploadError(`App Store Connect API error during ${what}: HTTP ${status}${detail ? ` — ${detail}` : ''}`, {
    hint:
      status === 401
        ? 'Check keyId/issuerId and that the .p8 key is active (App Store Connect → Users and Access → Integrations).'
        : status === 403
          ? 'The API key lacks permission — use a key with the App Manager or Admin role.'
          : status === 409
            ? 'App Store Connect reported a conflict — often the CFBundleVersion was already used for this version.'
            : undefined,
    context: { status, body: body.slice(0, 500) },
  });
}

function describeDetails(details: AscStateDetail[] | undefined): string {
  return (details ?? []).map((d) => (d.code ? `${d.code}: ${d.description ?? ''}` : d.description ?? '')).join('; ');
}

function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
