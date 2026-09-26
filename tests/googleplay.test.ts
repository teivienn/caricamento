import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UploadError, ValidationError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import { PlayPublisher } from '../src/infra/publishers/googleplay/publisher.js';
import { PlayVersionCodeProvider } from '../src/infra/publishers/googleplay/version-code.js';

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  authorization: string | null;
}

const recorded: RecordedRequest[] = [];
let failBundleUpload = false;
let failCommit = false;
let tracksResponse: unknown = { tracks: [] };

const PACKAGE_NAME = 'com.example.app';
const EDIT_ID = 'edit-123';
const API = 'https://androidpublisher.googleapis.com';
const EDIT_BASE = `${API}/androidpublisher/v3/applications/${PACKAGE_NAME}/edits`;

const server = setupServer(
  http.all('*', async ({ request }) => {
    const url = new URL(request.url);
    const isUpload = url.pathname.startsWith('/upload/');
    const body =
      request.method === 'GET' || request.method === 'DELETE' || isUpload
        ? undefined
        : await request.json().catch(() => undefined);
    recorded.push({ method: request.method, url: url.toString(), body, authorization: request.headers.get('authorization') });

    if (request.method === 'POST' && url.pathname === `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits`) {
      return HttpResponse.json({ id: EDIT_ID });
    }
    if (request.method === 'DELETE' && url.pathname === `/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/${EDIT_ID}`) {
      return new HttpResponse(null, { status: 204 });
    }
    if (request.method === 'POST' && url.pathname.endsWith(`/edits/${EDIT_ID}/bundles`) && isUpload) {
      if (failBundleUpload) {
        return HttpResponse.json({ error: { message: 'The current user has insufficient permissions' } }, { status: 403 });
      }
      return HttpResponse.json({ versionCode: 42 });
    }
    if (request.method === 'POST' && url.pathname.includes('/deobfuscationFiles/proguard') && isUpload) {
      return HttpResponse.json({});
    }
    if (request.method === 'PUT' && url.pathname.endsWith(`/edits/${EDIT_ID}/tracks/internal`)) {
      return HttpResponse.json({});
    }
    if (request.method === 'POST' && url.pathname.endsWith(`/edits/${EDIT_ID}:commit`)) {
      if (failCommit) {
        return HttpResponse.json({ error: { message: 'Version code 42 has already been used' } }, { status: 400 });
      }
      return HttpResponse.json({ id: EDIT_ID });
    }
    if (request.method === 'GET' && url.pathname.endsWith(`/edits/${EDIT_ID}/tracks`)) {
      return HttpResponse.json(tracksResponse as object);
    }
    return HttpResponse.json({ error: { message: 'unexpected request' } }, { status: 500 });
  }),
);

const ctx: StepContext = {
  runId: 'test-run',
  cwd: '/tmp',
  dryRun: false,
  log: () => {},
  progress: () => {},
  data: new Map(),
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const playConfig = {
  serviceAccountRef: 'secret:play/service-account',
  packageName: PACKAGE_NAME,
  track: 'internal' as const,
  status: 'completed' as const,
};

describe('PlayPublisher (SPEC §7.2)', () => {
  let dir: string;
  let aabPath: string;
  let mappingPath: string;

  beforeEach(async () => {
    recorded.length = 0;
    failBundleUpload = false;
    failCommit = false;
    tracksResponse = { tracks: [] };
    dir = await mkdtemp(join(tmpdir(), 'caricamento-play-'));
    aabPath = join(dir, 'app-release.aab');
    mappingPath = join(dir, 'mapping.txt');
    await writeFile(aabPath, 'fake-aab-bytes');
    await writeFile(mappingPath, 'fake-mapping');
  });

  afterEach(async () => {
    server.resetHandlers();
    await rm(dir, { recursive: true, force: true });
  });

  const makePublisher = () =>
    new PlayPublisher({ config: playConfig, tokenProvider: async () => 'test-token' });

  it('runs edits.insert -> bundle upload -> track update -> commit', async () => {
    const result = await makePublisher().publish(ctx, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
      releaseNotes: 'What is new',
    });

    expect(result.target).toBe('play');
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'POST', 'PUT', 'POST']);

    const [insert, upload, track, commit] = recorded;
    expect(insert?.url).toBe(`${EDIT_BASE}`);
    expect(insert?.authorization).toBe('Bearer test-token');

    expect(upload?.url).toBe(`${API}/upload/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/${EDIT_ID}/bundles`);

    expect(track?.url).toBe(`${EDIT_BASE}/${EDIT_ID}/tracks/internal`);
    expect(track?.body).toEqual({
      releases: [
        {
          versionCodes: ['42'],
          status: 'completed',
          releaseNotes: [{ language: 'en-US', text: 'What is new' }],
        },
      ],
    });

    expect(commit?.url).toBe(`${EDIT_BASE}/${EDIT_ID}:commit`);
  });

  it('uploads mapping.txt via edits.deobfuscationfiles when present', async () => {
    await makePublisher().publish(ctx, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
      artifacts: [
        { kind: 'aab', platform: 'android', path: aabPath },
        { kind: 'mapping', platform: 'android', path: mappingPath },
      ],
    });

    expect(recorded.map((r) => r.method)).toEqual(['POST', 'POST', 'POST', 'PUT', 'POST']);
    expect(recorded[2]?.url).toBe(
      `${API}/upload/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/${EDIT_ID}/apks/42/deobfuscationFiles/proguard`,
    );
  });

  it('rejects APK artifacts with a ValidationError before any HTTP call', async () => {
    await expect(
      makePublisher().publish(ctx, { artifact: { kind: 'apk', platform: 'android', path: aabPath } }),
    ).rejects.toThrow(ValidationError);
    expect(recorded).toHaveLength(0);
  });

  it('does not retry on 4xx and throws UploadError with the API message', async () => {
    failBundleUpload = true;
    const error = await makePublisher()
      .publish(ctx, { artifact: { kind: 'aab', platform: 'android', path: aabPath } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain('insufficient permissions');
    expect(recorded.filter((r) => r.url.endsWith('/bundles'))).toHaveLength(1);
    // the failed edit is cleaned up
    expect(recorded.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('deletes the edit when commit fails', async () => {
    failCommit = true;
    const error = await makePublisher()
      .publish(ctx, { artifact: { kind: 'aab', platform: 'android', path: aabPath } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain('Version code 42 has already been used');
    const cleanup = recorded.find((r) => r.method === 'DELETE');
    expect(cleanup?.url).toBe(`${EDIT_BASE}/${EDIT_ID}`);
  });

  it('short-circuits on dry runs without any HTTP calls', async () => {
    const result = await makePublisher().publish({ ...ctx, dryRun: true }, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
    });
    expect(result.target).toBe('play');
    expect(recorded).toHaveLength(0);
  });

  it('does nothing when the versionCode is already on the target track (SPEC §9)', async () => {
    tracksResponse = {
      tracks: [{ track: 'internal', releases: [{ versionCodes: ['42'] }] }],
    };

    const result = await makePublisher().publish(ctx, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
      versionCode: 42,
    });

    expect(result.target).toBe('play');
    // probe edit only: insert -> tracks.list -> delete; no upload, no commit
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'GET', 'DELETE']);
    expect(recorded.some((r) => r.url.endsWith('/bundles'))).toBe(false);
  });

  it('reuses an existing versionCode on another track: tracks.update + commit, no bundle upload', async () => {
    tracksResponse = {
      tracks: [{ track: 'production', releases: [{ versionCodes: ['42'] }] }],
    };

    await makePublisher().publish(ctx, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
      versionCode: 42,
      releaseNotes: 'Promoted build',
    });

    const methods = recorded.map((r) => r.method);
    // probe (insert/tracks/delete) + real edit (insert/track update/commit)
    expect(methods).toEqual(['POST', 'GET', 'DELETE', 'POST', 'PUT', 'POST']);
    expect(recorded.some((r) => r.url.endsWith('/bundles'))).toBe(false);
    const trackUpdate = recorded.find((r) => r.method === 'PUT');
    expect(trackUpdate?.body).toEqual({
      releases: [{ versionCodes: ['42'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Promoted build' }] }],
    });
  });

  it('uploads normally when the versionCode is unknown to Play', async () => {
    tracksResponse = { tracks: [{ track: 'internal', releases: [{ versionCodes: ['41'] }] }] };

    await makePublisher().publish(ctx, {
      artifact: { kind: 'aab', platform: 'android', path: aabPath },
      versionCode: 42,
    });

    expect(recorded.some((r) => r.url.endsWith('/bundles'))).toBe(true);
  });
});

describe('PlayVersionCodeProvider (SPEC §8)', () => {
  beforeEach(() => {
    recorded.length = 0;
  });
  afterEach(() => server.resetHandlers());

  const makeProvider = () =>
    new PlayVersionCodeProvider({ packageName: PACKAGE_NAME, tokenProvider: async () => 'test-token' });

  it('returns the max versionCode across all tracks and cleans up the edit', async () => {
    tracksResponse = {
      tracks: [
        { track: 'internal', releases: [{ versionCodes: ['7', '9'] }] },
        { track: 'production', releases: [{ versionCodes: ['5'] }, { versionCodes: ['12'], status: 'draft' }] },
      ],
    };
    await expect(makeProvider().maxVersionCode()).resolves.toBe(12);
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'GET', 'DELETE']);
  });

  it('returns null when no track has releases', async () => {
    tracksResponse = { tracks: [{ track: 'internal', releases: [] }] };
    await expect(makeProvider().maxVersionCode()).resolves.toBeNull();
  });
});
