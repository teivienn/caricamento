import type { SecretStore } from '../../core/ports/index.js';

/** `android/keystore-password` -> `ANDROID_KEYSTORE_PASSWORD`. */
export function secretNameToEnvKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(name: string): Promise<string | null> {
    const value = this.env[secretNameToEnvKey(name)];
    return Promise.resolve(value !== undefined && value !== '' ? value : null);
  }
}
