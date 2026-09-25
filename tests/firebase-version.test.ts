import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UploadError } from '../src/core/errors.js';
import { FirebaseVersionCodeProvider } from '../src/infra/publishers/firebase/version-code.js';

let pages: Array<{ releases?: Array<{ buildVersion?: string }>; nextPageToken?: string }> = [];
let failWith: number | null = null;

// Wildcard: the app id contains colons, which are parameter syntax for msw paths.
const server = setupServer(
  http.get('https://firebaseappdistribution.googleapis.com/v1/*/releases', () => {
    if (failWith) {
      return HttpResponse.json({ error: { message: 'denied' } }, { status: failWith });
    }
    return HttpResponse.json(pages[0] ?? {});
  }),
);

const makeProvider = () =>
  new FirebaseVersionCodeProvider({
    config: { appIdAndroid: '1:1:android:abc', groups: [], testers: [] },
    platform: 'android',
    tokenProvider: async () => 'test-token',
  });

describe('FirebaseVersionCodeProvider (SPEC §8)', () => {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());
  afterEach(() => {
    server.resetHandlers();
    pages = [];
    failWith = null;
  });

  it('returns the max buildVersion across releases', async () => {
    pages = [{ releases: [{ buildVersion: '41' }, { buildVersion: '7' }, { buildVersion: '40' }] }];
    await expect(makeProvider().maxVersionCode()).resolves.toBe(41);
  });

  it('returns null when there are no releases', async () => {
    pages = [{}];
    await expect(makeProvider().maxVersionCode()).resolves.toBeNull();
  });

  it('follows pagination', async () => {
    server.use(
      http.get('https://firebaseappdistribution.googleapis.com/v1/*/releases', ({ request }) => {
        const token = new URL(request.url).searchParams.get('pageToken');
        if (!token) return HttpResponse.json({ releases: [{ buildVersion: '3' }], nextPageToken: 'p2' });
        return HttpResponse.json({ releases: [{ buildVersion: '9' }] });
      }),
    );
    await expect(makeProvider().maxVersionCode()).resolves.toBe(9);
  });

  it('ignores releases without a numeric buildVersion', async () => {
    pages = [{ releases: [{}, { buildVersion: 'abc' }, { buildVersion: '12' }] }];
    await expect(makeProvider().maxVersionCode()).resolves.toBe(12);
  });

  it('wraps API errors in UploadError', async () => {
    failWith = 403;
    await expect(makeProvider().maxVersionCode()).rejects.toThrow(UploadError);
  });
});
