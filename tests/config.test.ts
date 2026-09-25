import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineConfig } from '../src/core/config/defineConfig.js';
import { configSchema } from '../src/core/config/schema.js';
import { ConfigError } from '../src/core/errors.js';
import { JitiConfigLoader, resolveConfigPath } from '../src/infra/system/config-loader.js';

describe('config schema', () => {
  it('applies defaults to an empty config', () => {
    const config = configSchema.parse({});
    expect(config.project.type).toBe('auto');
    expect(config.version.strategy).toBe('manual');
    expect(config.targets).toEqual({});
  });

  it('parses a full android + firebase config', () => {
    const config = defineConfig({
      project: { type: 'android' },
      android: {
        module: 'app',
        flavor: 'prod',
        buildType: 'release',
        signing: {
          keystoreRef: 'secret:android/keystore-path',
          keystorePasswordRef: 'secret:android/keystore-password',
          keyAlias: 'upload',
          keyPasswordRef: 'secret:android/key-password',
          expectedCertificateSha256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        },
      },
      version: { strategy: 'timestamp' },
      targets: {
        firebase: { appIdAndroid: '1:123:android:def', groups: ['qa'] },
      },
    });
    expect(config.android?.flavor).toBe('prod');
    expect(config.targets.firebase?.groups).toEqual(['qa']);
  });

  it('rejects raw secrets instead of secret: refs', () => {
    expect(() =>
      defineConfig({
        android: {
          signing: {
            keystoreRef: '/Users/me/real.keystore',
            keystorePasswordRef: 'secret:android/keystore-password',
            keyAlias: 'upload',
            keyPasswordRef: 'secret:android/key-password',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects unknown version strategies', () => {
    expect(() => defineConfig({ version: { strategy: 'random' } })).toThrow();
  });
});

describe('config loading', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a caricamento.config.ts via jiti', async () => {
    await writeFile(
      join(dir, 'caricamento.config.ts'),
      `export default {
        project: { type: 'android' as const },
        android: { module: 'app', buildType: 'release' },
        version: { strategy: 'manual' as const, buildNumber: 42 },
        targets: { firebase: { appIdAndroid: '1:123:android:def', groups: ['qa'] } },
      };
      `,
    );
    const config = await new JitiConfigLoader().loadValidated(resolveConfigPath(dir));
    expect(config.project.type).toBe('android');
    expect(config.version.buildNumber).toBe(42);
  });

  it('throws ConfigError when the file is missing', () => {
    expect(() => resolveConfigPath(dir)).toThrow(ConfigError);
  });

  it('throws ConfigError on schema violations', async () => {
    await writeFile(join(dir, 'caricamento.config.ts'), `export default { version: { strategy: 'nope' } };\n`);
    await expect(new JitiConfigLoader().loadValidated(resolveConfigPath(dir))).rejects.toThrow(ConfigError);
  });
});
