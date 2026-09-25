import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretStore } from '../../core/ports/index.js';
import { secretNameToEnvKey } from './env.js';

/** `.env` in the target project — local development only, must stay gitignored (SPEC §3.5). */
export class DotenvSecretStore implements SecretStore {
  private cache: Map<string, string> | null = null;

  constructor(private readonly projectDir: string) {}

  async get(name: string): Promise<string | null> {
    const values = await this.load();
    const value = values.get(secretNameToEnvKey(name));
    return value !== undefined && value !== '' ? value : null;
  }

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    let content: string;
    try {
      content = await readFile(join(this.projectDir, '.env'), 'utf8');
    } catch {
      return this.cache;
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      this.cache.set(key, value);
    }
    return this.cache;
  }
}
