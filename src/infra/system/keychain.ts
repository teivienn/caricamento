import type { ProcessRunner, SecretStore } from '../../core/ports/index.js';

const SERVICE_PREFIX = 'caricamento';

/**
 * macOS Keychain via the `security` CLI (SPEC §3.5). Best-effort: any failure
 * (not macOS, item missing, user denied) resolves to null so the chain moves on.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly processes: ProcessRunner) {}

  async get(name: string): Promise<string | null> {
    try {
      const result = await this.processes.run('security', [
        'find-generic-password',
        '-s',
        `${SERVICE_PREFIX}/${name}`,
        '-w',
      ]);
      if (result.exitCode !== 0) return null;
      const value = result.stdout.trim();
      return value === '' ? null : value;
    } catch {
      return null;
    }
  }
}
