import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../../core/errors.js';

export interface MaterializedFile {
  path: string;
  /** Removes the temporary copy; a no-op when the secret was already a file path. */
  cleanup(): Promise<void>;
}

/**
 * Secrets for file-shaped credentials (.p8, .p12, .mobileprovision) may be a
 * path on the build machine or the content itself — inline PEM for keys,
 * base64 for binary files (the usual shape of CI env vars). Tools like
 * xcodebuild/altool/security need a real file, so inline content is written
 * to a 0600 temp file that the caller must clean up.
 */
export async function materializeSecretFile(
  value: string,
  options: { fileName: string; encoding: 'pem' | 'base64'; label: string },
): Promise<MaterializedFile> {
  if (existsSync(value)) return { path: value, cleanup: async () => {} };

  let content: Buffer;
  if (options.encoding === 'pem') {
    if (!value.includes('-----BEGIN')) {
      throw new ConfigError(`${options.label} is neither an existing file path nor PEM content`, {
        hint: 'Point the secret at the .p8 file or store the key text itself (including the BEGIN/END lines).',
      });
    }
    content = Buffer.from(value.replace(/\\n/g, '\n'), 'utf8');
  } else {
    const compact = value.replace(/\s+/g, '');
    content = /^[A-Za-z0-9+/]+={0,2}$/.test(compact) ? Buffer.from(compact, 'base64') : Buffer.alloc(0);
    if (content.length === 0) {
      throw new ConfigError(`${options.label} is neither an existing file path nor base64 content`, {
        hint: 'Point the secret at the file or store its base64 encoding (e.g. `base64 -i file`).',
      });
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'caricamento-secret-'));
  const path = join(dir, options.fileName);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Reads a PEM private key given either its path or the PEM text itself. */
export async function readPemSecret(value: string, label: string): Promise<string> {
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  if (existsSync(value)) return readFile(value, 'utf8');
  throw new ConfigError(`${label} is neither an existing file path nor PEM content`, {
    hint: 'Point the secret at the .p8 file or store the key text itself (including the BEGIN/END lines).',
  });
}
