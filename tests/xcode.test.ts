import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iosBuildStep, nativeProjectRoot } from '../src/application/steps.js';
import { configSchema, type CaricamentoConfig } from '../src/core/config/schema.js';
import { resolveVariantConfig } from '../src/core/config/variants.js';
import { BuildError, SigningError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import type { ProcessResult, ProcessRunner, SecretResolver } from '../src/core/ports/index.js';
import { XcodeBuilder } from '../src/infra/builders/xcode.js';
import { IosSigningProvider, parseIdentities } from '../src/infra/signing/ios.js';
import { buildPlist, parsePlist } from '../src/infra/system/plist.js';

type RunCall = { cmd: string; args: string[] };

const makeContext = (cwd: string, dryRun = false, logs: string[] = []): StepContext => ({
  runId: 'test-run',
  cwd,
  dryRun,
  log: (_stream, line) => logs.push(line),
  progress: () => {},
  data: new Map(),
});

const makeSecrets = (values: Record<string, string>): SecretResolver => ({
  resolve: async (ref) => {
    const value = values[ref];
    if (value === undefined) throw new Error(`unresolved ${ref}`);
    return value;
  },
  tryResolve: async (ref) => values[ref] ?? null,
});

const iosConfig = (ios: object, extra: object = {}): CaricamentoConfig =>
  configSchema.parse({ ios: { project: 'App.xcodeproj', scheme: 'App', ...ios }, ...extra });

const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/**
 * Fake ProcessRunner: simulates what xcodebuild/ditto/plutil leave on disk so
 * the builder's artifact collection runs against a real directory tree.
 */
function fakeRunner(opts: { plist?: Record<string, string>; fail?: (call: RunCall) => ProcessResult | undefined; stdout?: (call: RunCall) => string } = {}) {
  const calls: RunCall[] = [];
  const run = vi.fn(async (cmd: string, args: string[], options?: { onLine?: (s: 'stdout' | 'stderr', l: string) => void }) => {
    const call = { cmd, args };
    calls.push(call);
    const failure = opts.fail?.(call);
    if (failure) {
      for (const line of failure.stdout.split('\n')) options?.onLine?.('stdout', line);
      return failure;
    }
    if (cmd === 'xcodebuild' && args[0] === 'archive') {
      const archive = argValue(args, '-archivePath')!;
      await mkdir(join(archive, 'Products', 'Applications', 'App.app'), { recursive: true });
      await mkdir(join(archive, 'dSYMs', 'App.app.dSYM'), { recursive: true });
    }
    if (cmd === 'xcodebuild' && args[0] === '-exportArchive') {
      const exportPath = argValue(args, '-exportPath')!;
      await mkdir(exportPath, { recursive: true });
      await writeFile(join(exportPath, 'App.ipa'), 'signed-ipa');
    }
    if (cmd === 'ditto' && args[0] === '-c') await writeFile(args[args.length - 1]!, 'unsigned-ipa');
    if (cmd === 'plutil') {
      const key = args[1]!;
      return { exitCode: 0, stdout: `${opts.plist?.[key] ?? ''}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: opts.stdout?.(call) ?? '', stderr: '' };
  });
  const runner: ProcessRunner = { run, which: async () => null };
  return { runner, calls };
}

describe('XcodeBuilder (SPEC §5.2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-xcode-'));
    await mkdir(join(dir, 'App.xcodeproj'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const builderFor = (config: CaricamentoConfig, runner: ProcessRunner, secrets = makeSecrets({})) =>
    new XcodeBuilder(runner, config, new IosSigningProvider({ processes: runner, secrets, config }));

  it('archives and exports with automatic signing, ASC key auth and injected versions', async () => {
    const config = iosConfig({
      signing: { mode: 'automatic', teamId: 'ABCDE12345', apiKeyRef: 'secret:asc/key', keyId: 'KEY123', issuerId: 'issuer-uuid' },
    });
    const { runner, calls } = fakeRunner({ plist: { CFBundleVersion: '42', CFBundleShortVersionString: '1.2.3' } });
    const secrets = makeSecrets({ 'secret:asc/key': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    const artifacts = await builderFor(config, runner, secrets).build(makeContext(dir), {
      platform: 'ios',
      versionCode: 42,
      versionName: '1.2.3',
    });

    const archive = calls.find((c) => c.cmd === 'xcodebuild' && c.args[0] === 'archive')!.args;
    expect(archive.slice(0, 11)).toEqual([
      'archive',
      '-project',
      join(dir, 'App.xcodeproj'),
      '-scheme',
      'App',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      join(dir, 'build', 'caricamento', 'App.xcarchive'),
    ]);
    expect(archive).toContain('-allowProvisioningUpdates');
    expect(argValue(archive, '-authenticationKeyID')).toBe('KEY123');
    expect(argValue(archive, '-authenticationKeyIssuerID')).toBe('issuer-uuid');
    expect(argValue(archive, '-authenticationKeyPath')).toMatch(/AuthKey_KEY123\.p8$/);
    expect(archive).toEqual(
      expect.arrayContaining(['MARKETING_VERSION=1.2.3', 'CURRENT_PROJECT_VERSION=42', 'CODE_SIGN_STYLE=Automatic', 'DEVELOPMENT_TEAM=ABCDE12345']),
    );
    // the temporary .p8 copy is gone after the build
    expect(existsSync(argValue(archive, '-authenticationKeyPath')!)).toBe(false);

    const exportCall = calls.find((c) => c.cmd === 'xcodebuild' && c.args[0] === '-exportArchive')!.args;
    expect(argValue(exportCall, '-exportPath')).toBe(join(dir, 'build', 'caricamento', 'ipa'));
    expect(exportCall).toContain('-allowProvisioningUpdates');
    const plist = parsePlist(await readFile(argValue(exportCall, '-exportOptionsPlist')!, 'utf8'));
    expect(plist).toMatchObject({ method: 'app-store-connect', signingStyle: 'automatic', teamID: 'ABCDE12345' });

    expect(artifacts).toEqual([
      expect.objectContaining({ kind: 'ipa', platform: 'ios', path: join(dir, 'build', 'caricamento', 'ipa', 'App.ipa') }),
      { kind: 'dsym', platform: 'ios', path: join(dir, 'build', 'caricamento', 'App.xcarchive', 'dSYMs') },
    ]);
  });

  it('falls back to the targets.appstore key for automatic signing', async () => {
    const config = iosConfig(
      { signing: { mode: 'automatic' } },
      { targets: { appstore: { apiKeyRef: 'secret:asc/key', keyId: 'ASCKEY', issuerId: 'iss', bundleId: 'com.example.app' } } },
    );
    const { runner, calls } = fakeRunner();
    const secrets = makeSecrets({ 'secret:asc/key': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' });
    await builderFor(config, runner, secrets).build(makeContext(dir), { platform: 'ios' });
    const archive = calls.find((c) => c.args[0] === 'archive')!.args;
    expect(argValue(archive, '-authenticationKeyID')).toBe('ASCKEY');
  });

  it('uses -workspace and resolves it inside <root>/ios for React Native', async () => {
    const config = configSchema.parse({ ios: { workspace: 'App.xcworkspace', scheme: 'App', signing: { mode: 'none' } } });
    await mkdir(join(dir, 'ios', 'App.xcworkspace'), { recursive: true });
    const { runner, calls } = fakeRunner();
    const projectRoot = nativeProjectRoot(dir, 'react-native', 'ios');
    expect(projectRoot).toBe(join(dir, 'ios'));
    await builderFor(config, runner).build(makeContext(dir), { platform: 'ios', projectRoot });
    const archive = calls.find((c) => c.args[0] === 'archive')!.args;
    expect(argValue(archive, '-workspace')).toBe(join(dir, 'ios', 'App.xcworkspace'));
    expect(argValue(archive, '-archivePath')).toBe(join(dir, 'ios', 'build', 'caricamento', 'App.xcarchive'));
  });

  it('accepts root-relative workspace paths too (ios/App.xcworkspace)', async () => {
    const config = configSchema.parse({ ios: { workspace: 'ios/App.xcworkspace', scheme: 'App', signing: { mode: 'none' } } });
    await mkdir(join(dir, 'ios', 'App.xcworkspace'), { recursive: true });
    const { runner, calls } = fakeRunner();
    await builderFor(config, runner).build(makeContext(dir), { platform: 'ios', projectRoot: join(dir, 'ios') });
    expect(argValue(calls.find((c) => c.args[0] === 'archive')!.args, '-workspace')).toBe(join(dir, 'ios', 'App.xcworkspace'));
  });

  it('builds unsigned without exportArchive and packages Payload/*.app (mode none)', async () => {
    const config = iosConfig({ signing: { mode: 'none' } });
    const { runner, calls } = fakeRunner();
    const artifacts = await builderFor(config, runner).build(makeContext(dir), { platform: 'ios' });
    const archive = calls.find((c) => c.args[0] === 'archive')!.args;
    expect(archive).toEqual(expect.arrayContaining(['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=']));
    expect(archive).not.toContain('-allowProvisioningUpdates');
    expect(calls.some((c) => c.args[0] === '-exportArchive')).toBe(false);
    const zip = calls.find((c) => c.cmd === 'ditto' && c.args[0] === '-c')!.args;
    expect(zip).toEqual(['-c', '-k', '--norsrc', '--noextattr', '--keepParent', join(dir, 'build', 'caricamento', 'unsigned', 'Payload'), join(dir, 'build', 'caricamento', 'ipa', 'App.ipa')]);
    expect(artifacts[0]).toMatchObject({ kind: 'ipa', path: join(dir, 'build', 'caricamento', 'ipa', 'App.ipa') });
  });

  it('injects the variant bundle ID as PRODUCT_BUNDLE_IDENTIFIER', async () => {
    const base = iosConfig({ signing: { mode: 'none', bundleId: 'com.example.app' } }, { variants: { qa: { bundleId: 'com.example.app.qa' } } });
    const { runner, calls } = fakeRunner();
    await builderFor(resolveVariantConfig(base, 'qa'), runner).build(makeContext(dir), { platform: 'ios' });
    expect(calls.find((c) => c.args[0] === 'archive')!.args).toContain('PRODUCT_BUNDLE_IDENTIFIER=com.example.app.qa');
  });

  it('fails when the archived Info.plist ignores the injected version', async () => {
    const config = iosConfig({ signing: { mode: 'none' } });
    const { runner } = fakeRunner({ plist: { CFBundleVersion: '1' } });
    await expect(builderFor(config, runner).build(makeContext(dir), { platform: 'ios', versionCode: 42 })).rejects.toThrow(
      /CFBundleVersion=1, expected 42/,
    );
  });

  it('maps xcodebuild signing failures to SigningError', async () => {
    const config = iosConfig({ signing: { mode: 'automatic' } });
    const { runner } = fakeRunner({
      fail: (c) =>
        c.cmd === 'xcodebuild'
          ? { exitCode: 65, stdout: 'error: No profiles for \'com.example.app\' were found', stderr: '' }
          : undefined,
    });
    await expect(builderFor(config, runner).build(makeContext(dir), { platform: 'ios' })).rejects.toBeInstanceOf(SigningError);
  });

  it('maps other xcodebuild failures to BuildError with the first error line', async () => {
    const config = iosConfig({ signing: { mode: 'none' } });
    const { runner } = fakeRunner({
      fail: (c) => (c.cmd === 'xcodebuild' ? { exitCode: 65, stdout: "App.swift:3:1: error: cannot find 'Foo' in scope", stderr: '' } : undefined),
    });
    const error = await builderFor(config, runner).build(makeContext(dir), { platform: 'ios' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).message).toContain("cannot find 'Foo' in scope");
  });

  it('dry-run logs both commands and the plist without resolving secrets', async () => {
    const config = iosConfig({
      signing: { mode: 'automatic', apiKeyRef: 'secret:asc/key', keyId: 'K', issuerId: 'I' },
    });
    const { runner, calls } = fakeRunner();
    const logs: string[] = [];
    const artifacts = await builderFor(config, runner).build(makeContext(dir, true, logs), { platform: 'ios', versionCode: 5 });
    expect(artifacts).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toContain('-authenticationKeyPath <secret:asc/key>');
    expect(logs.join('\n')).toContain('<string>app-store-connect</string>');
    expect(logs.join('\n')).toContain('xcodebuild -exportArchive');
  });

  it('iosBuildStep passes the resolved version and native root to the builder', async () => {
    const build = vi.fn(async () => []);
    const ctx = makeContext(dir);
    ctx.data.set('versionCode', 7);
    ctx.data.set('versionName', '3.0');
    ctx.data.set('projectType', 'flutter');
    await iosBuildStep({ build }).run(ctx);
    expect(build).toHaveBeenCalledWith(ctx, { platform: 'ios', versionCode: 7, versionName: '3.0', projectRoot: join(dir, 'ios') });
  });
});

describe('IosSigningProvider manual mode (SPEC §6.1)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'caricamento-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const profileXml = (opts: { uuid: string; name: string; appId: string; expires?: Date }) =>
    buildPlist({
      Name: opts.name,
      UUID: opts.uuid,
      TeamIdentifier: ['ABCDE12345'],
      ExpirationDate: opts.expires ?? new Date('2099-01-01T00:00:00Z'),
      Entitlements: { 'application-identifier': opts.appId },
    });

  const SHA1 = '0123456789ABCDEF0123456789ABCDEF01234567';

  function manualRunner(profiles: Record<string, string>) {
    return fakeRunner({
      stdout: ({ cmd, args }) => {
        if (cmd === 'security' && args[0] === 'cms') return profiles[args[3]!] ?? '';
        if (cmd === 'security' && args[0] === 'list-keychains' && args.length === 3) return '    "/Users/me/Library/Keychains/login.keychain-db"\n';
        if (cmd === 'security' && args[0] === 'find-identity') return `  1) ${SHA1} "Apple Distribution: Example (ABCDE12345)"\n     1 valid identities found\n`;
        return '';
      },
    });
  }

  it('imports the .p12 into a temporary keychain, installs profiles, and cleans everything up', async () => {
    const profileFile = join(home, 'app.mobileprovision');
    const p12File = join(home, 'dist.p12');
    await writeFile(profileFile, 'binary-profile');
    await writeFile(p12File, 'binary-p12');
    const config = iosConfig({
      signing: {
        mode: 'manual',
        bundleId: 'com.example.app',
        certificateRef: 'secret:ios/p12',
        certificatePasswordRef: 'secret:ios/p12-password',
        profileRefs: ['secret:ios/profile'],
      },
    });
    const { runner, calls } = manualRunner({ [profileFile]: profileXml({ uuid: 'UUID-1', name: 'App Store', appId: 'ABCDE12345.com.example.app' }) });
    const secrets = makeSecrets({ 'secret:ios/p12': p12File, 'secret:ios/p12-password': 'hunter2', 'secret:ios/profile': profileFile });
    const provider = new IosSigningProvider({ processes: runner, secrets, config, homeDir: home });

    const session = await provider.prepare(makeContext(home));
    const installed = [
      join(home, 'Library', 'MobileDevice', 'Provisioning Profiles', 'UUID-1.mobileprovision'),
      join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles', 'UUID-1.mobileprovision'),
    ];
    for (const path of installed) expect(existsSync(path)).toBe(true);

    const security = calls.filter((c) => c.cmd === 'security').map((c) => c.args);
    const keychain = security.find((a) => a[0] === 'create-keychain')![3]!;
    expect(security.map((a) => a[0])).toEqual([
      'cms',
      'create-keychain',
      'set-keychain-settings',
      'unlock-keychain',
      'import',
      'set-key-partition-list',
      'list-keychains',
      'list-keychains',
      'find-identity',
    ]);
    expect(security.find((a) => a[0] === 'import')).toEqual(
      expect.arrayContaining([p12File, '-k', keychain, '-P', 'hunter2', '-T', '/usr/bin/codesign']),
    );
    expect(security[7]).toEqual(['list-keychains', '-d', 'user', '-s', keychain, '/Users/me/Library/Keychains/login.keychain-db']);

    expect(session.buildSettings).toEqual({
      CODE_SIGN_STYLE: 'Manual',
      DEVELOPMENT_TEAM: 'ABCDE12345',
      PROVISIONING_PROFILE_SPECIFIER: 'UUID-1',
      CODE_SIGN_IDENTITY: SHA1,
      OTHER_CODE_SIGN_FLAGS: `--keychain ${keychain}`,
    });
    expect(session.exportOptions).toEqual({
      method: 'app-store',
      signingStyle: 'manual',
      teamId: 'ABCDE12345',
      provisioningProfiles: { 'com.example.app': 'UUID-1' },
      signingCertificate: SHA1,
    });

    calls.length = 0;
    await session.cleanup();
    for (const path of installed) expect(existsSync(path)).toBe(false);
    const cleanup = calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(cleanup).toEqual(['list-keychains -d', 'delete-keychain ' + keychain]);
    expect(calls[0]!.args).toEqual(['list-keychains', '-d', 'user', '-s', '/Users/me/Library/Keychains/login.keychain-db']);
  });

  it('accepts base64 profile content and does not force a specifier for multi-profile apps', async () => {
    const config = iosConfig({ signing: { mode: 'manual', profileRefs: ['secret:ios/app', 'secret:ios/widget'] } });
    const appB64 = Buffer.from('app-profile').toString('base64');
    const widgetB64 = Buffer.from('widget-profile').toString('base64');
    let decoded = 0;
    const { runner } = fakeRunner({
      stdout: ({ cmd, args }) => {
        if (cmd !== 'security' || args[0] !== 'cms') return '';
        return profileXml(
          decoded++ === 0
            ? { uuid: 'APP', name: 'App', appId: 'ABCDE12345.com.example.app' }
            : { uuid: 'WIDGET', name: 'Widget', appId: 'ABCDE12345.com.example.app.widget' },
        );
      },
    });
    const secrets = makeSecrets({ 'secret:ios/app': appB64, 'secret:ios/widget': widgetB64 });
    const session = await new IosSigningProvider({ processes: runner, secrets, config, homeDir: home }).prepare(makeContext(home));
    expect(session.buildSettings.PROVISIONING_PROFILE_SPECIFIER).toBeUndefined();
    expect(session.buildSettings.CODE_SIGN_IDENTITY).toBeUndefined();
    expect(session.exportOptions?.provisioningProfiles).toEqual({ 'com.example.app': 'APP', 'com.example.app.widget': 'WIDGET' });
    await session.cleanup();
  });

  it('rejects expired profiles and cleans up what was already installed', async () => {
    const profileFile = join(home, 'old.mobileprovision');
    await writeFile(profileFile, 'x');
    const config = iosConfig({ signing: { mode: 'manual', profileRefs: ['secret:ios/profile'] } });
    const { runner } = manualRunner({
      [profileFile]: profileXml({ uuid: 'OLD', name: 'Old', appId: 'ABCDE12345.com.example.app', expires: new Date('2020-01-01T00:00:00Z') }),
    });
    const provider = new IosSigningProvider({ processes: runner, secrets: makeSecrets({ 'secret:ios/profile': profileFile }), config, homeDir: home });
    await expect(provider.prepare(makeContext(home))).rejects.toThrow(/expired/);
  });

  it('rejects profiles that do not match the configured bundle ID', async () => {
    const profileFile = join(home, 'other.mobileprovision');
    await writeFile(profileFile, 'x');
    const config = iosConfig({ signing: { mode: 'manual', bundleId: 'com.example.qa', profileRefs: ['secret:ios/profile'] } });
    const { runner } = manualRunner({ [profileFile]: profileXml({ uuid: 'U', name: 'Prod', appId: 'ABCDE12345.com.example.app' }) });
    const provider = new IosSigningProvider({ processes: runner, secrets: makeSecrets({ 'secret:ios/profile': profileFile }), config, homeDir: home });
    await expect(provider.prepare(makeContext(home))).rejects.toThrow(/No provisioning profile matches bundle ID com\.example\.qa/);
    expect(existsSync(join(home, 'Library', 'MobileDevice', 'Provisioning Profiles', 'U.mobileprovision'))).toBe(false);
  });

  it('maps wildcard profiles to the configured bundle ID', async () => {
    const profileFile = join(home, 'wild.mobileprovision');
    await writeFile(profileFile, 'x');
    const config = iosConfig({ signing: { mode: 'manual', bundleId: 'com.example.app.qa', profileRefs: ['secret:ios/profile'] } });
    const { runner } = manualRunner({ [profileFile]: profileXml({ uuid: 'W', name: 'Wild', appId: 'ABCDE12345.com.example.*' }) });
    const provider = new IosSigningProvider({ processes: runner, secrets: makeSecrets({ 'secret:ios/profile': profileFile }), config, homeDir: home });
    const session = await provider.prepare(makeContext(home));
    expect(session.exportOptions?.provisioningProfiles).toEqual({ 'com.example.app.qa': 'W' });
    await session.cleanup();
  });

  it('parses find-identity output', () => {
    expect(parseIdentities(`  1) ${SHA1} "Apple Distribution: X (T)"\n     1 valid identities found`)).toEqual([
      { sha1: SHA1, name: 'Apple Distribution: X (T)' },
    ]);
  });
});

describe('ios config schema', () => {
  it('requires exactly one of workspace/project', () => {
    expect(() => configSchema.parse({ ios: { scheme: 'App' } })).toThrow(/exactly one of ios.workspace or ios.project/);
    expect(() => configSchema.parse({ ios: { scheme: 'App', workspace: 'a', project: 'b' } })).toThrow(/exactly one/);
  });

  it('applies defaults: Release, automatic, app-store, generic iOS destination', () => {
    const config = configSchema.parse({ ios: { project: 'App.xcodeproj', scheme: 'App' } });
    expect(config.ios).toMatchObject({
      configuration: 'Release',
      destination: 'generic/platform=iOS',
      signing: { mode: 'automatic', method: 'app-store' },
    });
  });

  it('requires profiles for manual mode and the full API key triple', () => {
    expect(() => configSchema.parse({ ios: { project: 'a', scheme: 'A', signing: { mode: 'manual' } } })).toThrow(/profileRefs/);
    expect(() => configSchema.parse({ ios: { project: 'a', scheme: 'A', signing: { apiKeyRef: 'secret:k' } } })).toThrow(/set together/);
  });

  it('parses targets.appstore with defaults', () => {
    const config = configSchema.parse({
      targets: { appstore: { apiKeyRef: 'secret:asc/key', keyId: 'K', issuerId: 'I', bundleId: 'com.example.app' } },
    });
    expect(config.targets.appstore).toMatchObject({
      distributeTo: 'testflight',
      betaGroups: [],
      upload: 'api',
      processingTimeoutMinutes: 30,
      locale: 'en-US',
    });
  });
});
