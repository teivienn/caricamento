import { userInfo } from 'node:os';
import type { ProcessRunner, SecretStore } from '../../core/ports/index.js';

const SERVICE_PREFIX = 'caricamento';

/**
 * macOS Keychain via the `security` CLI (SPEC §3.5). Items are ordinary
 * generic passwords in the login keychain with service "caricamento/<name>",
 * so they stay visible and editable in Keychain Access.app.
 * Reads are best-effort: any failure (not macOS, item missing, user denied)
 * resolves to null so the chain moves on.
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

  /** Creates or updates (-U) the item. The value transits process argv briefly. */
  async set(name: string, value: string): Promise<void> {
    const result = await this.processes.run('security', [
      'add-generic-password',
      '-s',
      `${SERVICE_PREFIX}/${name}`,
      '-a',
      userInfo().username,
      '-w',
      value,
      '-U',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`security add-generic-password failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
  }

  /** Returns false when the item did not exist. */
  async delete(name: string): Promise<boolean> {
    const result = await this.processes.run('security', ['delete-generic-password', '-s', `${SERVICE_PREFIX}/${name}`]);
    return result.exitCode === 0;
  }

  /** Names (prefix stripped) of all caricamento items in the login keychain. */
  async list(): Promise<string[]> {
    const result = await this.processes.run('security', ['dump-keychain']);
    if (result.exitCode !== 0) return [];
    const names = new Set<string>();
    for (const match of result.stdout.matchAll(/"svce"<blob>="([^"]+)"/g)) {
      const service = match[1]!;
      if (service.startsWith(`${SERVICE_PREFIX}/`)) {
        names.add(service.slice(SERVICE_PREFIX.length + 1));
      }
    }
    return [...names].sort();
  }
}
