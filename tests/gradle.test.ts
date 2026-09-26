import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type CaricamentoConfig } from '../src/core/config/schema.js';
import { BuildError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import type { ProcessRunner, SecretResolver } from '../src/core/ports/index.js';
import { GradleBuilder } from '../src/infra/builders/gradle.js';
import { androidProjectRoot } from '../src/application/steps.js';

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
  const runMock =
    vi.fn<(cmd: string, args: string[], options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>>();

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

  it('injects signing and version properties into the gradlew invocation (properties mode)', async () => {
    const config = makeConfig({
      module: 'app',
      buildType: 'release',
      signing: {
        keystoreRef: 'secret:android/keystore-path',
        keystorePasswordRef: 'secret:android/keystore-password',
        keyAlias: 'upload',
        keyPasswordRef: 'secret:android/key-password',
        injection: 'properties',
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

  it('passes -PCARICAMENTO_APPLICATION_ID in properties mode when configured', async () => {
    const config = makeConfig({
      module: 'app',
      buildType: 'release',
      applicationId: 'com.example.app.qa',
      signing: {
        keystoreRef: 'secret:android/keystore-path',
        keystorePasswordRef: 'secret:android/keystore-password',
        keyAlias: 'upload',
        keyPasswordRef: 'secret:android/key-password',
        injection: 'properties',
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
    await builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' });

    const [, args] = runMock.mock.calls[0]!;
    expect(args).toContain('-PCARICAMENTO_APPLICATION_ID=com.example.app.qa');
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

  it('runs gradlew in projectRoot and collects artifacts there (RN/Flutter layout)', async () => {
    const rnAndroid = join(dir, 'android');
    await mkdir(join(rnAndroid, 'app/build/outputs/apk/release'), { recursive: true });
    await writeFile(join(rnAndroid, 'app/build/outputs/apk/release/app-release.apk'), 'fake-apk');

    const builder = new GradleBuilder(runner, makeSecrets({}), makeConfig({ module: 'app', buildType: 'release' }));
    const artifacts = await builder.build(makeContext(dir), {
      platform: 'android',
      artifactType: 'apk',
      projectRoot: rnAndroid,
    });

    expect(runMock).toHaveBeenCalledOnce();
    expect(runMock.mock.calls[0]?.[2]).toMatchObject({ cwd: rnAndroid });
    expect(artifacts[0]?.path).toBe(join(rnAndroid, 'app/build/outputs/apk/release/app-release.apk'));
  });
});

describe('GradleBuilder init-script injection (default)', () => {
  let dir: string;
  let runner: ProcessRunner;
  const runMock =
    vi.fn<(cmd: string, args: string[], options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>>();

  const signingConfig = {
    keystoreRef: 'secret:android/keystore-path',
    keystorePasswordRef: 'secret:android/keystore-password',
    keyAlias: 'upload',
    keyPasswordRef: 'secret:android/key-password',
  };
  const secrets = makeSecrets({
    'secret:android/keystore-path': '/tmp/test.keystore',
    'secret:android/keystore-password': "store'pass",
    'secret:android/key-password': 'keypass',
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-gradle-init-'));
    runMock.mockReset();
    runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    runner = { run: runMock, which: async () => null };
    await mkdir(join(dir, 'app/build/outputs/apk/release'), { recursive: true });
    await writeFile(join(dir, 'app/build/outputs/apk/release/app-release.apk'), 'fake-apk');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a generated init script instead of -P signing properties', async () => {
    let scriptContent = '';
    let scriptPath = '';
    runMock.mockImplementation(async (_cmd, args) => {
      scriptPath = args[1]!;
      scriptContent = await readFile(scriptPath, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const builder = new GradleBuilder(runner, secrets, makeConfig({ module: 'app', buildType: 'release', signing: signingConfig }));
    await builder.build(makeContext(dir), {
      platform: 'android',
      artifactType: 'apk',
      versionCode: 42,
      versionName: '2.0.0',
    });

    const [, args] = runMock.mock.calls[0]!;
    expect(args[0]).toBe('-I');
    expect(args[2]).toBe(':app:assembleRelease');
    expect(args.some((a) => a.startsWith('-PCARICAMENTO_'))).toBe(false);

    expect(scriptContent).toContain("storeFile project.file('/tmp/test.keystore')");
    expect(scriptContent).toContain("storePassword 'store\\'pass'"); // groovy-escaped
    expect(scriptContent).toContain("keyAlias 'upload'");
    expect(scriptContent).toContain('buildType.signingConfig = androidExt.signingConfigs.caricamento');
    expect(scriptContent).toContain('androidExt.defaultConfig.versionCode = 42');
    expect(scriptContent).toContain("androidExt.defaultConfig.versionName = '2.0.0'");

    // the temp file with plaintext passwords must be removed after the build
    await expect(readFile(scriptPath, 'utf8')).rejects.toThrow();
  });

  it('redacts the init script path target in dry-run output', async () => {
    const logs: string[] = [];
    const ctx = { ...makeContext(dir, true), log: (_s: string, line: string) => logs.push(line) };
    const builder = new GradleBuilder(runner, secrets, makeConfig({ module: 'app', signing: signingConfig }));
    await builder.build(ctx, { platform: 'android', artifactType: 'apk' });
    expect(runMock).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('<generated-init-script>');
  });

  it('renders the applicationId override into the init script when configured', async () => {
    let scriptContent = '';
    runMock.mockImplementation(async (_cmd, args) => {
      scriptContent = await readFile(args[1]!, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const builder = new GradleBuilder(
      runner,
      secrets,
      makeConfig({ module: 'app', buildType: 'release', applicationId: 'com.example.app.qa', signing: signingConfig }),
    );
    await builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' });

    expect(scriptContent).toContain("androidExt.defaultConfig.applicationId = 'com.example.app.qa'");
    expect(runMock.mock.calls[0]![1].some((a: string) => a.startsWith('-PCARICAMENTO_APPLICATION_ID'))).toBe(false);
  });

  it('omits the applicationId line when not configured', async () => {
    let scriptContent = '';
    runMock.mockImplementation(async (_cmd, args) => {
      scriptContent = await readFile(args[1]!, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const builder = new GradleBuilder(runner, secrets, makeConfig({ module: 'app', signing: signingConfig }));
    await builder.build(makeContext(dir), { platform: 'android', artifactType: 'apk' });

    // the guard comment mentions applicationId; assert no assignment is rendered
    expect(scriptContent).not.toContain('defaultConfig.applicationId =');
  });
});

describe('androidProjectRoot (SPEC §5.3)', () => {
  it('resolves the android/ subdirectory for react-native and flutter', () => {
    expect(androidProjectRoot('/root', 'react-native')).toBe(join('/root', 'android'));
    expect(androidProjectRoot('/root', 'flutter')).toBe(join('/root', 'android'));
  });

  it('uses the run cwd for native android and unknown types', () => {
    expect(androidProjectRoot('/root', 'android')).toBe('/root');
    expect(androidProjectRoot('/root', undefined)).toBe('/root');
  });
});
