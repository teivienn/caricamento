import { UploadError } from '../../../core/errors.js';

const API_BASE = 'https://firebaseappdistribution.googleapis.com';
const PAGE_SIZE = 100;

export interface FirebaseRelease {
  name?: string;
  buildVersion?: string;
}

interface ReleasesPage {
  releases?: FirebaseRelease[];
  nextPageToken?: string;
}

/** All releases of the app, following releases.list pagination. */
export async function fetchAllReleases(
  fetchImpl: typeof fetch,
  app: string,
  token: string,
): Promise<FirebaseRelease[]> {
  const releases: FirebaseRelease[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}/v1/${app}/releases`);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
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
    releases.push(...(page.releases ?? []));
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return releases;
}
