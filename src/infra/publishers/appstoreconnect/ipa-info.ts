import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRunner } from '../../../core/ports/index.js';

export interface IpaInfo {
  bundleId?: string;
  /** CFBundleShortVersionString. */
  shortVersion?: string;
  /** CFBundleVersion. */
  bundleVersion?: string;
}

export interface IpaInfoReader {
  /** null when the Info.plist cannot be read (e.g. no unzip/plutil on this machine). */
  read(ipaPath: string): Promise<IpaInfo | null>;
}

/**
 * Reads the app's Info.plist out of an .ipa: the values the binary actually
 * carries are authoritative for the upload (a prebuilt `--artifact` may not
 * match the config).
 */
export class UnzipIpaInfoReader implements IpaInfoReader {
  constructor(private readonly processes: ProcessRunner) {}

  async read(ipaPath: string): Promise<IpaInfo | null> {
    const dir = await mkdtemp(join(tmpdir(), 'caricamento-ipainfo-'));
    try {
      const unzip = await this.processes.run('unzip', ['-o', '-q', ipaPath, 'Payload/*.app/Info.plist', '-d', dir]);
      if (unzip.exitCode !== 0) return null;
      const app = (await readdir(join(dir, 'Payload')).catch(() => [] as string[])).find((f) => f.endsWith('.app'));
      if (!app) return null;
      const json = await this.processes.run('plutil', ['-convert', 'json', '-o', '-', join(dir, 'Payload', app, 'Info.plist')]);
      if (json.exitCode !== 0) return null;
      const plist = JSON.parse(json.stdout) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      return {
        bundleId: str(plist.CFBundleIdentifier),
        shortVersion: str(plist.CFBundleShortVersionString),
        bundleVersion: str(plist.CFBundleVersion),
      };
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
