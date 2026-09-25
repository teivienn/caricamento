import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UploadError, ValidationError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import { FirebasePublisher } from '../src/infra/publishers/firebase/publisher.js';

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  authorization: string | null;
}

const recorded: RecordedRequest[] = [];
let pollCount = 0;
let failUpload = false;

const RELEASE_NAME = 'projects/1/apps/1:1:android:abc/releases/rel-1';
const OPERATION_NAME = 'projects/1/apps/1:1:android:abc/operations/op-1';

const server = setupServer(
  http.all('*', async ({ request }) => {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    recorded.push({ method: request.method, url: url.toString(), body, authorization: request.headers.get('authorization') });

    if (request.method === 'POST' && url.pathname.endsWith(':releases:upload')) {
      if (failUpload) {
        return HttpResponse.json({ error: { message: 'forbidden' } }, { status: 403 });
      }
      return HttpResponse.json({ name: OPERATION_NAME });
    }
    if (request.method === 'GET' && url.pathname.endsWith('/operations/op-1')) {
      pollCount += 1;
      if (pollCount < 2) return HttpResponse.json({ name: OPERATION_NAME, done: false });
      return HttpResponse.json({ name: OPERATION_NAME, done: true, response: { release: { name: RELEASE_NAME } } });
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/releases/rel-1')) {
      return HttpResponse.json({});
    }
    if (request.method === 'POST' && url.pathname.endsWith(':distribute')) {
      return HttpResponse.json({});
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

describe('FirebasePublisher (SPEC §7.3)', () => {
  let dir: string;
  let artifactPath: string;

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  beforeEach(async () => {
    recorded.length = 0;
    pollCount = 0;
    failUpload = false;
    dir = await mkdtemp(join(tmpdir(), 'caricamento-firebase-'));
    artifactPath = join(dir, 'app-release.apk');
    await writeFile(artifactPath, 'fake-apk-bytes');
  });

  afterEach(async () => {
    server.resetHandlers();
    await rm(dir, { recursive: true, force: true });
  });

  const makePublisher = () =>
    new FirebasePublisher({
      config: {
        appIdAndroid: '1:1:android:abc',
        groups: ['qa', 'groups/internal'],
        testers: ['dev@example.com'],
        releaseNotes: undefined,
      },
      platform: 'android',
      tokenProvider: async () => 'test-token',
      pollIntervalMs: 1,
    });

  it('runs upload -> poll -> release notes -> distribute', async () => {
    const result = await makePublisher().publish(ctx, {
      artifact: { kind: 'apk', platform: 'android', path: artifactPath },
      releaseNotes: 'What is new',
    });

    expect(result.releaseName).toBe(RELEASE_NAME);
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'GET', 'GET', 'PATCH', 'POST']);

    const [upload, , , patch, distribute] = recorded;
    expect(upload?.url).toBe(
      'https://upload.firebaseappdistribution.googleapis.com/upload/v1/projects/1/apps/1:1:android:abc:releases:upload',
    );
    expect(upload?.authorization).toBe('Bearer test-token');

    expect(patch?.url).toContain(`v1/${RELEASE_NAME}`);
    expect(patch?.url).toContain('updateMask=release_notes.text');
    expect(patch?.body).toEqual({ releaseNotes: { text: 'What is new' } });

    expect(distribute?.url).toContain(`${RELEASE_NAME}:distribute`);
    expect(distribute?.body).toEqual({
      groupAliases: ['groups/qa', 'groups/internal'],
      testerEmails: ['dev@example.com'],
    });
  });

  it('does not retry on 4xx and throws UploadError', async () => {
    failUpload = true;
    await expect(
      makePublisher().publish(ctx, { artifact: { kind: 'apk', platform: 'android', path: artifactPath } }),
    ).rejects.toThrow(UploadError);
    expect(recorded.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('requires an app id for the platform', async () => {
    const publisher = new FirebasePublisher({
      config: { groups: [], testers: [] },
      platform: 'android',
      tokenProvider: async () => 'test-token',
    });
    await expect(
      publisher.publish(ctx, { artifact: { kind: 'apk', platform: 'android', path: artifactPath } }),
    ).rejects.toThrow(ValidationError);
  });

  it('short-circuits on dry runs without any HTTP calls', async () => {
    const result = await makePublisher().publish({ ...ctx, dryRun: true }, {
      artifact: { kind: 'apk', platform: 'android', path: artifactPath },
    });
    expect(result.target).toBe('firebase');
    expect(recorded).toHaveLength(0);
  });
});
