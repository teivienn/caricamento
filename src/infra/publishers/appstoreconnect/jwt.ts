import { importPKCS8, SignJWT } from 'jose';
import { ConfigError } from '../../../core/errors.js';

export const ASC_AUDIENCE = 'appstoreconnect-v1';
/**
 * Apple rejects tokens whose `exp` is more than 20 minutes in the future
 * ("Generating Tokens for API Requests"); 15 minutes leaves room for clock
 * skew between this machine and Apple.
 */
export const TOKEN_LIFETIME_SECONDS = 15 * 60;
/** Re-sign when fewer than this many seconds of validity remain. */
const REFRESH_MARGIN_SECONDS = 2 * 60;

export interface AscCredentials {
  /** PEM contents of the .p8 key (PKCS#8, EC P-256). */
  privateKey: string;
  keyId: string;
  issuerId: string;
}

export type AscTokenProvider = () => Promise<string>;

/**
 * Signs an App Store Connect API token: ES256, header { alg, kid, typ: JWT },
 * payload { iss, iat, exp, aud: 'appstoreconnect-v1' } — exactly the fields
 * Apple documents for team keys.
 */
export async function signAscToken(credentials: AscCredentials, nowSeconds: number, lifetimeSeconds = TOKEN_LIFETIME_SECONDS): Promise<string> {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(credentials.privateKey, 'ES256');
  } catch (err) {
    throw new ConfigError('The App Store Connect API key is not a valid PKCS#8 EC private key', {
      hint: 'Use the AuthKey_<KEYID>.p8 file downloaded from App Store Connect → Users and Access → Integrations.',
      cause: err,
    });
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })
    .setIssuer(credentials.issuerId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + lifetimeSeconds)
    .setAudience(ASC_AUDIENCE)
    .sign(key);
}

/**
 * Cached token provider: credentials are loaded lazily on first use (so
 * secrets are only resolved when ASC is actually called) and the token is
 * re-signed shortly before it expires.
 */
export function createAscTokenProvider(
  loadCredentials: () => Promise<AscCredentials>,
  options: { now?: () => number; lifetimeSeconds?: number } = {},
): AscTokenProvider {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const lifetime = options.lifetimeSeconds ?? TOKEN_LIFETIME_SECONDS;
  let credentials: AscCredentials | undefined;
  let cached: { token: string; expiresAt: number } | undefined;

  return async () => {
    const current = now();
    if (cached && cached.expiresAt - current > REFRESH_MARGIN_SECONDS) return cached.token;
    credentials ??= await loadCredentials();
    const token = await signAscToken(credentials, current, lifetime);
    cached = { token, expiresAt: current + lifetime };
    return token;
  };
}
