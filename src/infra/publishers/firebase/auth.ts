import { existsSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { UploadError } from '../../../core/errors.js';

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export type TokenProvider = () => Promise<string>;

/**
 * Access-token provider backed by a service account (SPEC §7.3).
 * `credential` may be inline JSON or a path to a JSON key file; when omitted,
 * Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) are used.
 */
export function createGoogleTokenProvider(credential?: string): TokenProvider {
  let auth: GoogleAuth;
  if (credential) {
    const options = existsSync(credential)
      ? { keyFile: credential, scopes: SCOPES }
      : { credentials: parseServiceAccountJson(credential), scopes: SCOPES };
    auth = new GoogleAuth(options);
  } else {
    auth = new GoogleAuth({ scopes: SCOPES });
  }
  return async () => {
    try {
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      if (!token.token) throw new Error('empty access token');
      return token.token;
    } catch (err) {
      throw new UploadError('Failed to obtain a Google access token for Firebase App Distribution', {
        hint: 'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key, or configure targets.firebase.serviceAccountRef.',
        cause: err,
      });
    }
  };
}

function parseServiceAccountJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new UploadError('targets.firebase.serviceAccountRef resolved to a value that is neither a file path nor valid JSON', {
      hint: 'Point the secret at a service-account JSON key file or store the JSON itself.',
      cause: err,
    });
  }
}
