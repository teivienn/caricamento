import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type AppStoreTargetConfig } from '../src/core/config/schema.js';
import { ConfigError, UploadError, ValidationError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import type { ProcessRunner } from '../src/core/ports/index.js';
import { resolveVersion, resolveVersionSource } from '../src/core/versioning/index.js';
import { AppStoreConnectClient } from '../src/infra/publishers/appstoreconnect/client.js';
import type { IpaInfo } from '../src/infra/publishers/appstoreconnect/ipa-info.js';
import { ASC_AUDIENCE, createAscTokenProvider, signAscToken, TOKEN_LIFETIME_SECONDS } from '../src/infra/publishers/appstoreconnect/jwt.js';
import { AppStorePublisher } from '../src/infra/publishers/appstoreconnect/publisher.js';
import { AltoolBuildUploader, ApiBuildUploader } from '../src/infra/publishers/appstoreconnect/upload.js';
import { AppStoreVersionCodeProvider } from '../src/infra/publishers/appstoreconnect/version-code.js';

const API = 'https://api.appstoreconnect.apple.com';
const UPLOAD_HOST = 'https://upload.example.test';

describe('App Store Connect JWT (SPEC §7.1)', () => {
  it('signs an ES256 token that verifies with the matching public key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const now = Math.floor(Date.now() / 1000);
    const token = await signAscToken({ privateKey: pem, keyId: 'KEY123', issuerId: 'issuer-uuid' }, now);

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    const { payload } = await jwtVerify(token, publicKey, { audience: ASC_AUDIENCE, issuer: 'issuer-uuid' });
    expect(payload.iat).toBe(now);
    expect(payload.exp! - payload.iat!).toBe(TOKEN_LIFETIME_SECONDS);
    expect(TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(20 * 60);
  });

  it('fails verification against a different key', async () => {
    const signer = await generateKeyPair('ES256', { extractable: true });
    const other = await generateKeyPair('ES256');
    const token = await signAscToken({ privateKey: await exportPKCS8(signer.privateKey), keyId: 'K', issuerId: 'I' }, Math.floor(Date.now() / 1000));
    await expect(jwtVerify(token, other.publicKey)).rejects.toThrow();
  });

  it('caches the token and re-signs shortly before expiry, loading credentials once', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    let now = 1_800_000_000;
    const load = vi.fn(async () => ({ privateKey: pem, keyId: 'K', issuerId: 'I' }));
    const provider = createAscTokenProvider(load, { now: () => now });

    const first = await provider();
    now += 60;
    expect(await provider()).toBe(first);
    now += TOKEN_LIFETIME_SECONDS - 60 - 30; // 30s left: inside the refresh margin
    const refreshed = await provider();
    expect(refreshed).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects a key that is not PKCS#8 EC', async () => {
    await expect(signAscToken({ privateKey: 'not a key', keyId: 'K', issuerId: 'I' }, 0)).rejects.toBeInstanceOf(ConfigError);
  });
});

// ---- fake App Store Connect --------------------------------------------------

interface Recorded {
  method: string;
  url: URL;
  body?: unknown;
  bytes?: Uint8Array;
  headers: Headers;
}

const recorded: Recorded[] = [];
let builds: Array<{ id: string; version: string; state: string }>;
/** Successive processingStates returned for the uploaded build (last one repeats). */
let processingStates: string[];
let uploadState: { state: string; errors?: Array<{ code: string; description: string }> };
let localizations: Array<{ id: string; locale: string }>;
let failNextBuildsWith: number[];
let altoolUploaded = false;

const server = setupServer(
  http.all('*', async ({ request }) => {
    const url = new URL(request.url);
    const isUpload = url.origin === UPLOAD_HOST;
    const entry: Recorded = { method: request.method, url, headers: request.headers };
    if (isUpload) entry.bytes = new Uint8Array(await request.arrayBuffer());
    else if (request.method !== 'GET') entry.body = await request.json().catch(() => undefined);
    recorded.push(entry);

    if (isUpload) return new HttpResponse(null, { status: 200 });
    const path = url.pathname;
    const q = url.searchParams;

    if (path === '/v1/apps' && request.method === 'GET') {
      return HttpResponse.json({
        data: [
          { id: 'app-qa', type: 'apps', attributes: { bundleId: 'com.example.app.qa' } },
          { id: 'app-1', type: 'apps', attributes: { bundleId: 'com.example.app' } },
        ].filter((a) => a.attributes.bundleId.startsWith(q.get('filter[bundleId]') ?? '')),
      });
    }
    if (path === '/v1/builds' && request.method === 'GET') {
      const status = failNextBuildsWith.shift();
      if (status) return HttpResponse.json({ errors: [{ detail: 'try later' }] }, { status });
      const version = q.get('filter[version]');
      if (version === null) {
        // full listing (version source) — paginated
        if (!q.get('cursor')) {
          return HttpResponse.json({
            data: builds.slice(0, 2).map(toBuild),
            links: { next: `${API}/v1/builds?filter[app]=app-1&cursor=2` },
          });
        }
        return HttpResponse.json({ data: builds.slice(2).map(toBuild) });
      }
      const existing = builds.find((b) => b.version === version);
      if (existing) return HttpResponse.json({ data: [toBuild(existing)] });
      const committed = recorded.some((r) => r.method === 'PATCH' && r.url.pathname.startsWith('/v1/buildUploadFiles/'));
      if (!committed && !altoolUploaded) return HttpResponse.json({ data: [] });
      const state = processingStates.length > 1 ? processingStates.shift()! : processingStates[0]!;
      if (state === 'NOT_VISIBLE') return HttpResponse.json({ data: [] });
      return HttpResponse.json({ data: [toBuild({ id: 'build-new', version, state })] });
    }
    if (path === '/v1/buildUploads' && request.method === 'POST') {
      return HttpResponse.json({ data: { id: 'bu-1', type: 'buildUploads', attributes: { state: { state: 'AWAITING_UPLOAD' } } } }, { status: 201 });
    }
    if (path === '/v1/buildUploads/bu-1' && request.method === 'GET') {
      return HttpResponse.json({ data: { id: 'bu-1', type: 'buildUploads', attributes: { state: uploadState } } });
    }
    if (path === '/v1/buildUploadFiles' && request.method === 'POST') {
      return HttpResponse.json(
        {
          data: {
            id: 'file-1',
            type: 'buildUploadFiles',
            attributes: {
              uploadOperations: [
                { method: 'PUT', url: `${UPLOAD_HOST}/part1`, offset: 0, length: 6, partNumber: 1, requestHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }, { name: 'x-apple-token', value: 'abc' }] },
                { method: 'PUT', url: `${UPLOAD_HOST}/part2`, offset: 6, length: 4, partNumber: 2, requestHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }] },
              ],
            },
          },
        },
        { status: 201 },
      );
    }
    if (path === '/v1/buildUploadFiles/file-1' && request.method === 'PATCH') {
      return HttpResponse.json({ data: { id: 'file-1', type: 'buildUploadFiles', attributes: {} } });
    }
    if (path === '/v1/betaGroups' && request.method === 'GET') {
      return HttpResponse.json({
        data: [
          { id: 'g-qa', type: 'betaGroups', attributes: { name: 'QA', isInternalGroup: true } },
          { id: 'g-ext', type: 'betaGroups', attributes: { name: 'External', isInternalGroup: false } },
        ],
      });
    }
    if (/^\/v1\/betaGroups\/[^/]+\/relationships\/builds$/.test(path) && request.method === 'POST') {
      return new HttpResponse(null, { status: 204 });
    }
    if (/^\/v1\/builds\/[^/]+\/betaBuildLocalizations$/.test(path)) {
      return HttpResponse.json({ data: localizations.map((l) => ({ id: l.id, type: 'betaBuildLocalizations', attributes: { locale: l.locale } })) });
    }
    if (path === '/v1/betaBuildLocalizations' && request.method === 'POST') {
      return HttpResponse.json({ data: { id: 'loc-new', type: 'betaBuildLocalizations' } }, { status: 201 });
    }
    if (path.startsWith('/v1/betaBuildLocalizations/') && request.method === 'PATCH') {
      return HttpResponse.json({ data: { id: path.split('/').pop(), type: 'betaBuildLocalizations' } });
    }
    return HttpResponse.json({ errors: [{ detail: `unexpected ${request.method} ${path}` }] }, { status: 500 });
  }),
);

function toBuild(b: { id: string; version: string; state: string }) {
  return { id: b.id, type: 'builds', attributes: { version: b.version, processingState: b.state, usesNonExemptEncryption: false } };
}

const ctx: StepContext = { runId: 'test', cwd: '/tmp', dryRun: false, log: () => {}, progress: () => {}, data: new Map() };

const ascConfig = (overrides: Partial<AppStoreTargetConfig> = {}): AppStoreTargetConfig => ({
  apiKeyRef: 'secret:asc/key',
  keyId: 'KEY123',
  issuerId: 'issuer',
  bundleId: 'com.example.app',
  distributeTo: 'testflight',
  betaGroups: ['QA'],
  whatToTest: 'Check the login flow',
  locale: 'en-US',
  upload: 'api',
  processingTimeoutMinutes: 30,
  ...overrides,
});

const makeClient = () => new AppStoreConnectClient({ tokenProvider: async () => 'jwt-token', retryBaseMs: 1 });
const ipaInfo = (info: IpaInfo | null = { bundleId: 'com.example.app', shortVersion: '1.4.0', bundleVersion: '57' }) => ({ read: async () => info });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('AppStorePublisher — TestFlight flow (SPEC §7.1)', () => {
  let dir: string;
  let ipaPath: string;

  beforeEach(async () => {
    recorded.length = 0;
    builds = [];
    processingStates = ['NOT_VISIBLE', 'PROCESSING', 'VALID'];
    uploadState = { state: 'PROCESSING' };
    localizations = [];
    failNextBuildsWith = [];
    altoolUploaded = false;
    dir = await mkdtemp(join(tmpdir(), 'caricamento-asc-'));
    ipaPath = join(dir, 'App.ipa');
    await writeFile(ipaPath, Buffer.from('0123456789'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const publisher = (config = ascConfig(), info = ipaInfo()) => {
    const client = makeClient();
    return new AppStorePublisher({ config, client, uploader: new ApiBuildUploader(client), ipaInfo: info, pollIntervalMs: 1 });
  };
  const api = () => recorded.filter((r) => r.url.origin === API);

  it('uploads via the Build Uploads API, waits for VALID, sets What to Test and adds to groups', async () => {
    const result = await publisher().publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } });

    expect(result).toEqual({
      target: 'appstore',
      releaseName: 'com.example.app 1.4.0 (57)',
      url: 'https://appstoreconnect.apple.com/apps/app-1/testflight/ios',
    });
    for (const r of api()) expect(r.headers.get('authorization')).toBe('Bearer jwt-token');

    const createUpload = api().find((r) => r.method === 'POST' && r.url.pathname === '/v1/buildUploads')!;
    expect(createUpload.body).toEqual({
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: '1.4.0', cfBundleVersion: '57', platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });
    const reserve = api().find((r) => r.method === 'POST' && r.url.pathname === '/v1/buildUploadFiles')!;
    expect(reserve.body).toEqual({
      data: {
        type: 'buildUploadFiles',
        attributes: { assetType: 'ASSET', fileName: 'App.ipa', fileSize: 10, uti: 'com.apple.ipa' },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: 'bu-1' } } },
      },
    });

    const parts = recorded.filter((r) => r.url.origin === UPLOAD_HOST);
    expect(parts.map((p) => [p.method, p.url.pathname, Buffer.from(p.bytes!).toString()])).toEqual([
      ['PUT', '/part1', '012345'],
      ['PUT', '/part2', '6789'],
    ]);
    expect(parts[0]!.headers.get('x-apple-token')).toBe('abc');
    expect(parts.every((p) => p.headers.get('authorization') === null)).toBe(true);

    const commit = api().find((r) => r.method === 'PATCH' && r.url.pathname === '/v1/buildUploadFiles/file-1')!;
    expect(commit.body).toEqual({ data: { type: 'buildUploadFiles', id: 'file-1', attributes: { uploaded: true } } });

    const buildPolls = api().filter((r) => r.url.pathname === '/v1/builds');
    expect(buildPolls.at(-1)!.url.searchParams.get('filter[version]')).toBe('57');
    expect(buildPolls.at(-1)!.url.searchParams.get('filter[preReleaseVersion.version]')).toBe('1.4.0');
    expect(api().some((r) => r.url.pathname === '/v1/buildUploads/bu-1')).toBe(true);

    const tail = api()
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.url.pathname}`)
      .slice(-2);
    expect(tail).toEqual(['POST /v1/betaBuildLocalizations', 'POST /v1/betaGroups/g-qa/relationships/builds']);
    const loc = api().find((r) => r.url.pathname === '/v1/betaBuildLocalizations')!;
    expect(loc.body).toEqual({
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew: 'Check the login flow' },
        relationships: { build: { data: { type: 'builds', id: 'build-new' } } },
      },
    });
    const addToGroup = api().find((r) => r.url.pathname === '/v1/betaGroups/g-qa/relationships/builds')!;
    expect(addToGroup.body).toEqual({ data: [{ type: 'builds', id: 'build-new' }] });
  });

  it('skips the upload when the build already exists (idempotent re-run)', async () => {
    builds = [{ id: 'build-old', version: '57', state: 'VALID' }];
    await publisher().publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } });
    expect(api().some((r) => r.url.pathname === '/v1/buildUploads')).toBe(false);
    expect(api().some((r) => r.url.pathname === '/v1/betaGroups/g-qa/relationships/builds')).toBe(true);
  });

  it('updates an existing What to Test localization instead of creating one', async () => {
    builds = [{ id: 'build-old', version: '57', state: 'VALID' }];
    localizations = [{ id: 'loc-en', locale: 'en-US' }];
    await publisher(ascConfig({ betaGroups: [] })).publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath }, releaseNotes: 'Flag wins' });
    const patch = api().find((r) => r.method === 'PATCH' && r.url.pathname === '/v1/betaBuildLocalizations/loc-en')!;
    expect(patch.body).toEqual({ data: { type: 'betaBuildLocalizations', id: 'loc-en', attributes: { whatsNew: 'Flag wins' } } });
    expect(api().some((r) => r.url.pathname.includes('/relationships/builds'))).toBe(false);
  });

  it('falls back to generated release notes when no What to Test is configured', async () => {
    builds = [{ id: 'build-old', version: '57', state: 'VALID' }];
    await publisher(ascConfig({ whatToTest: undefined, betaGroups: [] })).publish(ctx, {
      artifact: { kind: 'ipa', platform: 'ios', path: ipaPath },
      generatedReleaseNotes: '- from git',
    });
    expect(api().find((r) => r.url.pathname === '/v1/betaBuildLocalizations')!.body).toMatchObject({
      data: { attributes: { whatsNew: '- from git' } },
    });
  });

  it('rejects distributeTo "appstore" (review submission is roadmap)', async () => {
    const error = await publisher(ascConfig({ distributeTo: 'appstore' }))
      .publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).hint).toMatch(/roadmap/);
    expect(recorded).toHaveLength(0);
  });

  it('fails fast on an unknown beta group, before uploading', async () => {
    const error = await publisher(ascConfig({ betaGroups: ['Nope'] }))
      .publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).hint).toContain('QA, External');
    expect(api().some((r) => r.url.pathname === '/v1/buildUploads')).toBe(false);
  });

  it('rejects an .ipa whose bundle ID differs from targets.appstore.bundleId', async () => {
    const info = ipaInfo({ bundleId: 'com.example.app.qa', shortVersion: '1', bundleVersion: '2' });
    await expect(publisher(ascConfig(), info).publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })).rejects.toThrow(
      /bundle ID com\.example\.app\.qa/,
    );
  });

  it('uses the resolved version when the .ipa cannot be inspected', async () => {
    builds = [{ id: 'b', version: '99', state: 'VALID' }];
    await publisher(ascConfig({ betaGroups: [], whatToTest: undefined }), ipaInfo(null)).publish(ctx, {
      artifact: { kind: 'ipa', platform: 'ios', path: ipaPath },
      versionCode: 99,
      versionName: '2.0',
    });
    expect(api().find((r) => r.url.pathname === '/v1/builds')!.url.searchParams.get('filter[version]')).toBe('99');
  });

  it('surfaces a FAILED build upload with Apple\'s error details', async () => {
    uploadState = { state: 'FAILED', errors: [{ code: 'DUPLICATE', description: 'The bundle version must be higher' }] };
    const error = await publisher()
      .publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain('DUPLICATE: The bundle version must be higher');
  });

  it('fails when processing ends INVALID', async () => {
    processingStates = ['INVALID'];
    await expect(publisher().publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })).rejects.toThrow(/INVALID/);
  });

  it('times out after processingTimeoutMinutes', async () => {
    processingStates = ['PROCESSING'];
    const error = await publisher(ascConfig({ processingTimeoutMinutes: 0.0005 }))
      .publish(ctx, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toMatch(/Timed out/);
  });

  it('dry-run touches nothing', async () => {
    await publisher().publish({ ...ctx, dryRun: true }, { artifact: { kind: 'ipa', platform: 'ios', path: ipaPath } });
    expect(recorded).toHaveLength(0);
  });

  it('uploads via altool when targets.appstore.upload is "altool"', async () => {
    const calls: string[][] = [];
    let keyPath = '';
    const runner: ProcessRunner = {
      which: async () => null,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        keyPath = args[args.indexOf('--p8-file-path') + 1]!;
        expect(existsSync(keyPath)).toBe(true);
        altoolUploaded = true;
        return { exitCode: 0, stdout: 'UPLOAD SUCCEEDED', stderr: '' };
      },
    };
    processingStates = ['VALID'];
    const client = makeClient();
    const uploader = new AltoolBuildUploader(runner, async () => ({
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      keyId: 'KEY123',
      issuerId: 'issuer',
    }));
    await new AppStorePublisher({ config: ascConfig({ upload: 'altool' }), client, uploader, ipaInfo: ipaInfo(), pollIntervalMs: 1 }).publish(ctx, {
      artifact: { kind: 'ipa', platform: 'ios', path: ipaPath },
    });
    expect(calls[0]).toEqual([
      'xcrun', 'altool', '--upload-app', '-f', ipaPath, '-t', 'ios', '--api-key', 'KEY123', '--api-issuer', 'issuer', '--p8-file-path', keyPath,
    ]);
    expect(keyPath).toMatch(/AuthKey_KEY123\.p8$/);
    expect(existsSync(keyPath)).toBe(false);
    expect(api().some((r) => r.url.pathname === '/v1/buildUploads')).toBe(false);
  });

  it('reports altool failures as UploadError', async () => {
    const runner: ProcessRunner = {
      which: async () => null,
      run: async (_cmd, _args, options) => {
        options?.onLine?.('stderr', 'ERROR: The bundle version 57 has already been used.');
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const uploader = new AltoolBuildUploader(runner, async () => ({ privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----', keyId: 'K', issuerId: 'I' }));
    await expect(
      uploader.upload(ctx, { ipaPath, appId: 'app-1', bundleId: 'com.example.app', shortVersion: '1', bundleVersion: '57' }),
    ).rejects.toThrow(/already been used/);
  });
});

describe('AppStoreConnectClient transport', () => {
  beforeEach(() => {
    recorded.length = 0;
    builds = [{ id: 'b1', version: '3', state: 'VALID' }];
    processingStates = [];
    failNextBuildsWith = [];
  });

  it('picks the exact bundle ID match from filter[bundleId] results', async () => {
    expect((await makeClient().findApp('com.example.app'))?.id).toBe('app-1');
    expect(await makeClient().findApp('com.example')).toBeUndefined();
  });

  it('retries 429 and 5xx responses', async () => {
    failNextBuildsWith = [429, 503];
    const found = await makeClient().findBuild('app-1', '3');
    expect(found?.id).toBe('b1');
    expect(recorded.filter((r) => r.url.pathname === '/v1/builds')).toHaveLength(3);
  });

  it('does not retry other 4xx and explains 401', async () => {
    failNextBuildsWith = [401];
    const error = await makeClient().listBuilds('app-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain('HTTP 401 — try later');
    expect((error as UploadError).hint).toMatch(/keyId\/issuerId/);
    expect(recorded).toHaveLength(1);
  });
});

describe('version auto-increment from App Store Connect (SPEC §8)', () => {
  beforeEach(() => {
    recorded.length = 0;
    failNextBuildsWith = [];
  });

  it('returns the max numeric CFBundleVersion across all pages', async () => {
    builds = [
      { id: 'a', version: '9', state: 'VALID' },
      { id: 'b', version: '1.2.3', state: 'VALID' },
      { id: 'c', version: '41', state: 'PROCESSING' },
      { id: 'd', version: '10', state: 'VALID' },
    ];
    const provider = new AppStoreVersionCodeProvider({ client: makeClient(), bundleId: 'com.example.app' });
    expect(provider.name).toBe('appstore');
    expect(await provider.maxVersionCode()).toBe(41);
    const listing = recorded.filter((r) => r.url.pathname === '/v1/builds');
    expect(listing).toHaveLength(2);
    expect(listing[0]!.url.searchParams.get('filter[app]')).toBe('app-1');
    expect(listing[0]!.url.searchParams.get('filter[preReleaseVersion.platform]')).toBe('IOS');
  });

  it('returns null when the app has no builds', async () => {
    builds = [];
    expect(await new AppStoreVersionCodeProvider({ client: makeClient(), bundleId: 'com.example.app' }).maxVersionCode()).toBeNull();
  });

  it('feeds resolveVersion: max + 1', () => {
    const config = configSchema.parse({ version: { strategy: 'auto-increment', source: 'appstore' } });
    expect(resolveVersion({ config, maxVersionCode: 41 }, 'ios').versionCode).toBe(42);
    expect(() => resolveVersion({ config }, 'ios')).toThrow(/App Store Connect API/);
  });

  it('uses YYYYMMDDHHMM (UTC) for the iOS timestamp strategy', () => {
    const config = configSchema.parse({ version: { strategy: 'timestamp' } });
    expect(resolveVersion({ config, now: new Date('2026-09-26T04:07:00Z') }, 'ios').versionCode).toBe(202609260407);
  });

  it('resolves the default source: play > appstore > firebase among platform-native targets', () => {
    const play = { serviceAccountRef: 'secret:p', packageName: 'com.example.app' };
    const appstore = { apiKeyRef: 'secret:a', keyId: 'K', issuerId: 'I', bundleId: 'com.example.app' };
    const firebase = { appIdIos: '1:1:ios:1', appIdAndroid: '1:1:android:1' };
    const all = configSchema.parse({ targets: { play, appstore, firebase } });
    expect(resolveVersionSource(all, 'android')).toBe('play');
    expect(resolveVersionSource(all, 'ios')).toBe('appstore');
    expect(resolveVersionSource(configSchema.parse({ targets: { play, firebase } }), 'ios')).toBe('firebase');
    expect(resolveVersionSource(configSchema.parse({ targets: { appstore, firebase } }), 'android')).toBe('firebase');
    expect(resolveVersionSource(configSchema.parse({ targets: { play } }), 'ios')).toBeUndefined();
    expect(resolveVersionSource(configSchema.parse({ version: { source: 'appstore' }, targets: { play } }), 'android')).toBe('appstore');
  });
});
