import { readFile } from 'node:fs/promises';
import type { SecretStore } from '../../core/ports/index.js';
import { secretNameToEnvKey } from './env.js';

/**
 * Reads secrets from .env files, in order; the first file containing the key
 * wins. Paths that do not exist are skipped. In registry mode the list is
 * ~/.caricamento/projects/<name>.env followed by <project>/.env (SPEC §3.5).
 */
export class DotenvSecretStore implements SecretStore {
  private values: Map<string, string> | null = null;

  constructor(private readonly paths: string[]) {}

  async get(name: string): Promise<string | null> {
    const values = await this.load();
    const value = values.get(secretNameToEnvKey(name));
    return value !== undefined && value !== '' ? value : null;
  }

  private async load(): Promise<Map<string, string>> {
    if (this.values) return this.values;
    this.values = new Map();
    for (const path of this.paths) {
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      for (const [key, value] of parseDotenv(content)) {
        if (!this.values.has(key)) this.values.set(key, value);
      }
    }
    return this.values;
  }
}

export function parseDotenv(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
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
    entries.push([key, value]);
  }
  return entries;
}
