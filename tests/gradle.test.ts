import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type CaricamentoConfig } from '../src/core/config/schema.js';
import { BuildError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import type { ProcessRunner, SecretResolver } from '../src/core/ports/index.js';
import { GradleBuilder } from '../src/infra/builders/gradle.js';

const makeConfig = (android?: object): CaricamentoConfig => configSchema.parse({ android });

const makeSecrets = (values: Record<string, string>): SecretResolver => ({
  resolve: async (ref: string) => {
    const value = values[ref];
    if (value === undefined) throw new Error(`unresolved ${ref}`);
    return value;
  },
  tryResolve: async (ref: string) => values[ref] ?? null,
});

const makeContext = (cwd: string, dryRun = false): StepContext => ({
  runId: 'test-run',
  cwd,
  dryRun,
  log: () => {},
  progress: () => {},
  data: new Map(),
});

describe('GradleBuilder', () => {
  let dir: string;
  let runner: ProcessRunner;
  const runMock = vi.fn<(cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-gradle-'));
    runMock.mockReset();
    runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    runner = { run: runMock, which: async () => null };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the assemble task name without flavor', () => {
    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app', buildType: 'release' }));
    expect(builder.plan({ platform: 'android', artifactType: 'apk' }).task).toBe(':app:assembleRelease');
  });

  it('builds the bundle task name with flavor', () => {
    const builder = new GradleBuilder(
      runner,
      makeSecrets({}),
      makeConfig({ module: 'app', flavor: 'prod', buildType: 'release' }),
    );
    const plan = builder.plan({ platform: 'android', artifactType: 'aab' });
    expect(plan.task).toBe(':app:bundleProdRelease');
    expect(plan.outputDir).toBe(join('app', 'build', 'outputs', 'bundle', 'prodRelease'));
  });

  it('injects signing and version properties into the gradlew invocation', async () => {
    const config = makeConfig({
      module: 'app',
      buildType: 'release',
      signing: {
        keystoreRef: 'secret:android/keystore-path',
        keystorePasswordRef: 'secret:android/keystore-password',
        keyAlias: 'upload',
        keyPasswordRef: 'secret:android/key-password',
      },
    });
    const secrets = makeSecrets({
      'secret:android/keystore-path': '/tmp/test.keystore',
      'secret:android/keystore-password': 'storepass',
      'secret:android/key-password': 'keypass',
    });
    await mkdir(join(dir, 'app/build/outputs/apk/release'), { recursive: true });
    await writeFile(join(dir, 'app/build/outputs/apk/release/app-release.apk'), 'fake-apk');

    const builder = new GradleBuilder(runner, secrets, config);
    const artifacts = await builder.build(makeContext(dir), {
      platform: 'android',
      artifactType: 'apk',
      versionCode: 123,
      versionName: '1.2.3',
    });

    expect(runMock).toHaveBeenCalledOnce();
    const [cmd, args] = runMock.mock.calls[0]!;
    expect(cmd).toBe('./gradlew');
    expect(args).toEqual([
      ':app:assembleRelease',
      '-PCARICAMENTO_STORE_FILE=/tmp/test.keystore',
      '-PCARICAMENTO_STORE_PASSWORD=storepass',
      '-PCARICAMENTO_KEY_ALIAS=upload',
      '-PCARICAMENTO_KEY_PASSWORD=keypass',
      '-PCARICAMENTO_VERSION_CODE=123',
      '-PCARICAMENTO_VERSION_NAME=1.2.3',
    ]);
    expect(artifacts[0]).toMatchObject({ kind: 'apk', platform: 'android' });
    expect(artifacts[0]?.path).toBe(join(dir, 'app/build/outputs/apk/release/app-release.apk'));
  });

  it('collects mapping.txt when present', async () => {
    await mkdir(join(dir, 'app/build/outputs/apk/release'), { recursive: true });
    await writeFile(join(dir, 'app/build/outputs/apk/release/app-release.apk'), 'fake-apk');
    await mkdir(join(dir, 'app/build/outputs/mapping/release'), { recursive: true });
    await writeFile(join(dir, 'app/build/outputs/mapping/release/mapping.txt'), 'mapping');

    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app', buildType: 'release' }));
    const artifacts = await builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' });
    expect(artifacts.map((a) => a.kind)).toEqual(['apk', 'mapping']);
  });

  it('throws BuildError when gradle exits non-zero', async () => {
    runMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });
    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app' }));
    await expect(builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' })).rejects.toThrow(BuildError);
  });

  it('throws BuildError when the output artifact is missing', async () => {
    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app' }));
    await expect(builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' })).rejects.toThrow(
      /output directory is missing/,
    );
  });

  it('does not invoke gradle on dry runs', async () => {
    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app' }));
    const artifacts = await builder.build(makeContext(dir, true), { platform: 'android', artifactType: 'apk' });
    expect(runMock).not.toHaveBeenCalled();
    expect(artifacts).toEqual([]);
  });
});
