import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UploadError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import { PlaySharingPublisher } from '../src/infra/publishers/googleplay/sharing.js';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
}

const recorded: RecordedRequest[] = [];
let failStatus: number | null = null;

const PACKAGE_NAME = 'com.example.app';
const DOWNLOAD_URL = 'https://play.google.com/apps/internaltest/abc123';

const server = setupServer(
  http.all('*', async ({ request }) => {
    recorded.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization') });
    if (failStatus !== null) {
      return HttpResponse.json({ error: { message: 'The current user has insufficient permissions' } }, { status: failStatus });
    }
    return HttpResponse.json({ downloadUrl: DOWNLOAD_URL, sha256: 'deadbeef' });
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

describe('PlaySharingPublisher (Internal App Sharing)', () => {
  let dir: string;
  let apkPath: string;
  let aabPath: string;

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  beforeEach(async () => {
    recorded.length = 0;
    failStatus = null;
    dir = await mkdtemp(join(tmpdir(), 'caricamento-sharing-'));
    apkPath = join(dir, 'app-release.apk');
    aabPath = join(dir, 'app-release.aab');
    await writeFile(apkPath, 'fake-apk-bytes');
    await writeFile(aabPath, 'fake-aab-bytes');
  });

  afterEach(async () => {
    server.resetHandlers();
    await rm(dir, { recursive: true, force: true });
  });

  const makePublisher = () =>
    new PlaySharingPublisher({
      config: { serviceAccountRef: 'secret:play/service-account', packageName: PACKAGE_NAME },
      tokenProvider: async () => 'test-token',
    });

  it('uploads an APK to the apk artifacts endpoint and returns the download URL', async () => {
    const result = await makePublisher().publish(ctx, { artifact: { kind: 'apk', platform: 'android', path: apkPath } });

    expect(result.url).toBe(DOWNLOAD_URL);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toBe(
      `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/${PACKAGE_NAME}/artifacts/apk`,
    );
    expect(recorded[0]?.authorization).toBe('Bearer test-token');
  });

  it('uploads an AAB to the bundle artifacts endpoint', async () => {
    const result = await makePublisher().publish(ctx, { artifact: { kind: 'aab', platform: 'android', path: aabPath } });

    expect(result.url).toBe(DOWNLOAD_URL);
    expect(recorded[0]?.url).toContain('/artifacts/bundle');
  });

  it('does not retry on 4xx and throws UploadError with the API message', async () => {
    failStatus = 403;
    const error = await makePublisher()
      .publish(ctx, { artifact: { kind: 'apk', platform: 'android', path: apkPath } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain('insufficient permissions');
    expect(recorded).toHaveLength(1);
  });

  it('short-circuits on dry runs without any HTTP calls', async () => {
    const result = await makePublisher().publish({ ...ctx, dryRun: true }, {
      artifact: { kind: 'apk', platform: 'android', path: apkPath },
    });
    expect(result.target).toBe('playsharing');
    expect(recorded).toHaveLength(0);
  });
});
