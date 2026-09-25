import type { SecretResolver, SecretStore } from '../../core/ports/index.js';
import { ConfigError } from '../../core/errors.js';

const REF_PREFIX = 'secret:';

export function isSecretRef(value: string): boolean {
  return value.startsWith(REF_PREFIX);
}

/** Resolution chain per SPEC §3.5: env vars -> macOS Keychain -> .env. */
export class ChainedSecretResolver implements SecretResolver {
  constructor(private readonly stores: SecretStore[]) {}

  async resolve(ref: string): Promise<string> {
    const value = await this.tryResolve(ref);
    if (value === null) {
      throw new ConfigError(`Secret "${ref}" could not be resolved`, {
        hint: 'Set it as an env var (e.g. ANDROID_KEYSTORE_PASSWORD), store it in the macOS Keychain via `security add-generic-password -s "caricamento/<name>"`, or add it to the project .env file.',
      });
    }
    return value;
  }

  async tryResolve(ref: string): Promise<string | null> {
    const name = isSecretRef(ref) ? ref.slice(REF_PREFIX.length) : ref;
    for (const store of this.stores) {
      const value = await store.get(name);
      if (value !== null) return value;
    }
    return null;
  }
}
