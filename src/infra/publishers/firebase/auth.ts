import { existsSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { UploadError } from '../../../core/errors.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export type TokenProvider = () => Promise<string>;

export interface GoogleTokenProviderOptions {
  /** OAuth scopes; defaults to cloud-platform (covers Firebase App Distribution). */
  scopes?: string[];
  /** Service name used in error messages (e.g. "Firebase App Distribution"). */
  service?: string;
}

/**
 * Access-token provider backed by a service account (SPEC §7.2/§7.3).
 * `credential` may be inline JSON or a path to a JSON key file; when omitted,
 * Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) are used.
 */
export function createGoogleTokenProvider(credential?: string, options: GoogleTokenProviderOptions = {}): TokenProvider {
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const service = options.service ?? 'Google APIs';
  let auth: GoogleAuth;
  if (credential) {
    const options = existsSync(credential)
      ? { keyFile: credential, scopes }
      : { credentials: parseServiceAccountJson(credential), scopes };
    auth = new GoogleAuth(options);
  } else {
    auth = new GoogleAuth({ scopes });
  }
  return async () => {
    try {
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      if (!token.token) throw new Error('empty access token');
      return token.token;
    } catch (err) {
      throw new UploadError(`Failed to obtain a Google access token for ${service}`, {
        hint: 'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key, or configure serviceAccountRef in the target config.',
        cause: err,
      });
    }
  };
}

function parseServiceAccountJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new UploadError('serviceAccountRef resolved to a value that is neither a file path nor valid JSON', {
      hint: 'Point the secret at a service-account JSON key file or store the JSON itself.',
      cause: err,
    });
  }
}
