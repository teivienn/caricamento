import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/core/errors.js';
import { DotenvSecretStore } from '../src/infra/system/dotenv.js';
import { EnvSecretStore, secretNameToEnvKey } from '../src/infra/system/env.js';
import { ChainedSecretResolver } from '../src/infra/system/secrets.js';

describe('secret name normalization', () => {
  it('maps secret names to env keys', () => {
    expect(secretNameToEnvKey('android/keystore-password')).toBe('ANDROID_KEYSTORE_PASSWORD');
    expect(secretNameToEnvKey('asc/private-key')).toBe('ASC_PRIVATE_KEY');
  });
});

describe('secret resolution chain (SPEC §3.5)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-secrets-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves from environment variables', async () => {
    const env = new EnvSecretStore({ ANDROID_KEYSTORE_PASSWORD: 'from-env' });
    await expect(env.get('android/keystore-password')).resolves.toBe('from-env');
    await expect(env.get('missing/name')).resolves.toBeNull();
  });

  it('resolves from .env files', async () => {
    await writeFile(join(dir, '.env'), '# comment\nANDROID_KEY_PASSWORD="from-dotenv"\nEMPTY=\n');
    const dotenv = new DotenvSecretStore(dir);
    await expect(dotenv.get('android/key-password')).resolves.toBe('from-dotenv');
    await expect(dotenv.get('empty')).resolves.toBeNull();
  });

  it('prefers env vars over .env (chain order)', async () => {
    await writeFile(join(dir, '.env'), 'ANDROID_KEY_PASSWORD=from-dotenv\n');
    const resolver = new ChainedSecretResolver([
      new EnvSecretStore({ ANDROID_KEY_PASSWORD: 'from-env' }),
      new DotenvSecretStore(dir),
    ]);
    await expect(resolver.resolve('secret:android/key-password')).resolves.toBe('from-env');
  });

  it('falls through the chain until a store resolves', async () => {
    await writeFile(join(dir, '.env'), 'ANDROID_KEY_PASSWORD=from-dotenv\n');
    const resolver = new ChainedSecretResolver([new EnvSecretStore({}), new DotenvSecretStore(dir)]);
    await expect(resolver.resolve('secret:android/key-password')).resolves.toBe('from-dotenv');
  });

  it('throws ConfigError with a hint when nothing resolves', async () => {
    const resolver = new ChainedSecretResolver([new EnvSecretStore({})]);
    await expect(resolver.resolve('secret:nope/missing')).rejects.toThrow(ConfigError);
  });
});
