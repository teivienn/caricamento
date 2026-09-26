import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApkUseCase } from '../src/application/apk.js';
import { configSchema } from '../src/core/config/schema.js';
import { BuildError } from '../src/core/errors.js';
import type { RunEvent } from '../src/core/pipeline/types.js';
import type { ProcessResult, ProcessRunner, SecretResolver } from '../src/core/ports/index.js';
import { resolveBundletool, BundletoolApkConverter } from '../src/infra/system/bundletool.js';

describe('resolveBundletool', () => {
  const deps = (overrides: Partial<Parameters<typeof resolveBundletool>[0]>) => ({
    env: {} as NodeJS.ProcessEnv,
    which: async () => null,
    exists: () => false,
    download: async () => {},
    toolsDir: '/tools',
    ...overrides,
  });

  it('prefers BUNDLETOOL_PATH over everything', async () => {
    const result = await resolveBundletool(deps({ env: { BUNDLETOOL_PATH: '/opt/bt.jar' }, exists: () => true }));
    expect(result).toEqual({ executable: 'java', prefixArgs: ['-jar', '/opt/bt.jar'] });
  });

  it('rejects a BUNDLETOOL_PATH pointing at a missing file', async () => {
    await expect(resolveBundletool(deps({ env: { BUNDLETOOL_PATH: '/nope.jar' }, exists: () => false }))).rejects.toThrow(
      BuildError,
    );
  });

  it('uses bundletool from PATH when no env override', async () => {
    const result = await resolveBundletool(deps({ which: async (t) => (t === 'bundletool' ? '/usr/local/bin/bundletool' : null) }));
    expect(result).toEqual({ executable: '/usr/local/bin/bundletool', prefixArgs: [] });
  });

  it('uses the cached jar without downloading', async () => {
    let downloaded = false;
    const result = await resolveBundletool(
      deps({ exists: (p) => p === '/tools/bundletool.jar', download: async () => { downloaded = true; } }),
    );
    expect(result).toEqual({ executable: 'java', prefixArgs: ['-jar', '/tools/bundletool.jar'] });
    expect(downloaded).toBe(false);
  });

  it('downloads the jar once when nothing is available', async () => {
    const calls: Array<[string, string]> = [];
    const result = await resolveBundletool(
      deps({ download: async (url, dest) => { calls.push([url, dest]); } }),
    );
    expect(calls).toEqual([['https://api.github.com/repos/google/bundletool/releases/latest', '/tools/bundletool.jar']]);
    expect(result.prefixArgs).toEqual(['-jar', '/tools/bundletool.jar']);
  });
});

describe('BundletoolApkConverter', () => {
  let dir: string;
  let aabPath: string;
  let fakeJar: string;
  let savedEnv: string | undefined;

  const secrets: SecretResolver = {
    resolve: async (ref: string) => {
      const values: Record<string, string> = {
        'secret:android/keystore-path': '/tmp/test.keystore',
        'secret:android/keystore-password': 'storepass',
        'secret:android/key-password': 'keypass',
      };
      const value = values[ref];
      if (value === undefined) throw new Error(`unresolved ${ref}`);
      return value;
    },
    tryResolve: async () => null,
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-bt-'));
    aabPath = join(dir, 'app-release.aab');
    fakeJar = join(dir, 'bundletool.jar');
    await writeFile(aabPath, 'fake-aab');
    await writeFile(fakeJar, 'fake-jar');
    savedEnv = process.env.BUNDLETOOL_PATH;
    process.env.BUNDLETOOL_PATH = fakeJar;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.BUNDLETOOL_PATH;
    else process.env.BUNDLETOOL_PATH = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });

  const config = configSchema.parse({
    android: {
      signing: {
        keystoreRef: 'secret:android/keystore-path',
        keystorePasswordRef: 'secret:android/keystore-password',
        keyAlias: 'upload',
        keyPasswordRef: 'secret:android/key-password',
      },
    },
  });

  it('builds the bundletool command with signing and redacts passwords in logs', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const processes: ProcessRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === '/usr/bin/unzip') {
          const outDir = args[args.indexOf('-d') + 1]!;
          await writeFile(join(outDir, 'universal.apk'), 'fake-apk');
        }
        return { exitCode: 0, stdout: '', stderr: '' } satisfies ProcessResult;
      },
      which: async (tool) => (tool === 'unzip' ? '/usr/bin/unzip' : null),
    };
    const ctx = {
      runId: 'test-run',
      cwd: dir,
      dryRun: false,
      log: (_s: string, line: string) => logs.push(line),
      progress: () => {},
      data: new Map(),
    };

    const converter = new BundletoolApkConverter({ processes, secrets, config });
    const out = join(dir, 'out.apk');
    const result = await converter.buildUniversalApk(ctx, aabPath, out);

    expect(result).toBe(out);
    const bt = calls[0]!;
    expect(bt.command).toBe('java');
    expect(bt.args.slice(0, 2)).toEqual(['-jar', fakeJar]);
    expect(bt.args).toContain('build-apks');
    expect(bt.args).toContain(`--bundle=${aabPath}`);
    expect(bt.args).toContain('--mode=universal');
    expect(bt.args).toContain('--ks=/tmp/test.keystore');
    expect(bt.args).toContain('--ks-key-alias=upload');
    expect(bt.args).toContain('--ks-pass=pass:storepass');
    expect(bt.args).toContain('--key-pass=pass:keypass');

    const logged = logs.join('\n');
    expect(logged).not.toContain('storepass');
    expect(logged).not.toContain('keypass');
    expect(logged).toContain('--ks-pass=***');
  });

  it('fails with a BuildError when bundletool exits non-zero', async () => {
    const processes: ProcessRunner = {
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
      which: async () => null,
    };
    const converter = new BundletoolApkConverter({ processes, secrets, config });
    await expect(converter.buildUniversalApk(
      { runId: 't', cwd: dir, dryRun: false, log: () => {}, progress: () => {}, data: new Map() },
      aabPath,
      join(dir, 'out.apk'),
    )).rejects.toThrow(BuildError);
  });
});

describe('ApkUseCase', () => {
  it('fails with a validation error when no AAB is found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caricamento-apk-'));
    try {
      const useCase = new ApkUseCase({
        converter: { buildUniversalApk: async (_ctx, _aab, out) => out },
      });
      const events: RunEvent[] = [];
      for await (const event of useCase.run({ cwd: dir })) events.push(event);

      const done = events.find((e) => e.type === 'run:done');
      expect(done?.type === 'run:done' && done.summary.status).toBe('failed');
      expect(done?.type === 'run:done' && done.summary.error?.code).toBe('VALIDATION_ERROR');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
