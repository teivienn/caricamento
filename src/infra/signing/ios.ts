import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../../core/artifact/types.js';
import type { CaricamentoConfig, IosSigningConfig } from '../../core/config/schema.js';
import { SigningError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { ProcessRunner, SecretResolver, SigningProvider, SigningVerification } from '../../core/ports/index.js';
import type { ExportOptionsInput } from '../builders/export-options.js';
import { parsePlist, type PlistValue } from '../system/plist.js';
import { materializeSecretFile, type MaterializedFile } from '../system/secret-file.js';

/** Everything XcodeBuilder needs to sign one archive + export. */
export interface IosSigningSession {
  /** Extra xcodebuild flags for both archive and export (provisioning updates + ASC auth). */
  xcodebuildArgs: string[];
  /** Build settings passed as KEY=VALUE to `xcodebuild archive`. */
  buildSettings: Record<string, string>;
  /** Undefined for unsigned builds (mode 'none'): no exportArchive at all. */
  exportOptions?: ExportOptionsInput;
  cleanup(): Promise<void>;
}

export interface IosSigningPreparer {
  readonly mode: IosSigningConfig['mode'];
  /** Resolves secrets and installs credentials; the caller MUST call cleanup(). */
  prepare(ctx: StepContext): Promise<IosSigningSession>;
  /** Secret-free preview of the session for --dry-run. */
  describe(): Omit<IosSigningSession, 'cleanup'>;
}

export interface ProvisioningProfileInfo {
  uuid: string;
  name: string;
  teamId?: string;
  /** Bundle ID from the application-identifier entitlement ('*' for wildcard profiles). */
  bundleId: string;
  expiresAt?: Date;
}

export interface IosSigningProviderOptions {
  processes: ProcessRunner;
  secrets: SecretResolver;
  config: CaricamentoConfig;
  /** Overridable for tests; defaults to os.homedir(). */
  homeDir?: string;
  now?: () => Date;
}

/**
 * iOS signing (SPEC §6.1). Three modes from `ios.signing.mode`:
 *
 * - automatic: `-allowProvisioningUpdates` plus ASC API key auth
 *   (`-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`),
 *   so Xcode creates/refreshes profiles itself. The key falls back to
 *   targets.appstore; without any key Xcode's signed-in accounts are used.
 * - manual: the .p12 is imported into a throwaway keychain (added to the
 *   search list for the build, removed afterwards) and the profiles are
 *   copied into both profile directories Xcode reads (pre-16 and 16+).
 *   exportOptions lists them explicitly.
 * - none: CODE_SIGNING_ALLOWED=NO — local unsigned builds.
 *
 * Everything is injected via xcodebuild arguments; project files are never
 * modified.
 */
export class IosSigningProvider implements SigningProvider, IosSigningPreparer {
  private readonly signing: IosSigningConfig;
  private readonly homeDir: string;
  private readonly now: () => Date;

  constructor(private readonly options: IosSigningProviderOptions) {
    this.signing = options.config.ios?.signing ?? { mode: 'automatic', method: 'app-store' };
    this.homeDir = options.homeDir ?? homedir();
    this.now = options.now ?? (() => new Date());
  }

  get mode(): IosSigningConfig['mode'] {
    return this.signing.mode;
  }

  describe(): Omit<IosSigningSession, 'cleanup'> {
    const { signing } = this;
    if (signing.mode === 'none') return { xcodebuildArgs: [], buildSettings: unsignedBuildSettings() };
    if (signing.mode === 'automatic') {
      const key = this.apiKey();
      return {
        xcodebuildArgs: ['-allowProvisioningUpdates', ...(key ? authArgs(`<${key.ref}>`, key.keyId, key.issuerId) : [])],
        buildSettings: this.automaticBuildSettings(),
        exportOptions: { method: signing.method, signingStyle: 'automatic', teamId: signing.teamId },
      };
    }
    const buildSettings: Record<string, string> = { CODE_SIGN_STYLE: 'Manual' };
    if (signing.teamId) buildSettings.DEVELOPMENT_TEAM = signing.teamId;
    if (signing.certificateRef) {
      buildSettings.CODE_SIGN_IDENTITY = '<imported identity>';
      buildSettings.OTHER_CODE_SIGN_FLAGS = '--keychain <temporary keychain>';
    }
    return {
      xcodebuildArgs: [],
      buildSettings,
      exportOptions: {
        method: signing.method,
        signingStyle: 'manual',
        teamId: signing.teamId,
        provisioningProfiles: Object.fromEntries((signing.profileRefs ?? []).map((ref) => [`<bundle id of ${ref}>`, '<uuid>'])),
      },
    };
  }

  async prepare(ctx: StepContext): Promise<IosSigningSession> {
    switch (this.signing.mode) {
      case 'none':
        ctx.log('stdout', 'ios.signing.mode is "none" — building unsigned (CODE_SIGNING_ALLOWED=NO)');
        return { xcodebuildArgs: [], buildSettings: unsignedBuildSettings(), cleanup: async () => {} };
      case 'automatic':
        return this.prepareAutomatic(ctx);
      case 'manual':
        return this.prepareManual(ctx);
    }
  }

  private apiKey(): { ref: string; keyId: string; issuerId: string } | undefined {
    const { signing } = this;
    if (signing.apiKeyRef && signing.keyId && signing.issuerId) {
      return { ref: signing.apiKeyRef, keyId: signing.keyId, issuerId: signing.issuerId };
    }
    const asc = this.options.config.targets.appstore;
    return asc ? { ref: asc.apiKeyRef, keyId: asc.keyId, issuerId: asc.issuerId } : undefined;
  }

  private automaticBuildSettings(): Record<string, string> {
    const settings: Record<string, string> = { CODE_SIGN_STYLE: 'Automatic' };
    if (this.signing.teamId) settings.DEVELOPMENT_TEAM = this.signing.teamId;
    return settings;
  }

  private async prepareAutomatic(ctx: StepContext): Promise<IosSigningSession> {
    const key = this.apiKey();
    const xcodebuildArgs = ['-allowProvisioningUpdates'];
    let keyFile: MaterializedFile | undefined;
    if (key) {
      const value = await this.options.secrets.resolve(key.ref);
      keyFile = await materializeSecretFile(value, { fileName: `AuthKey_${key.keyId}.p8`, encoding: 'pem', label: key.ref });
      xcodebuildArgs.push(...authArgs(keyFile.path, key.keyId, key.issuerId));
      ctx.log('stdout', `Automatic signing via App Store Connect API key ${key.keyId}`);
    } else {
      ctx.log('stdout', 'Automatic signing via the Apple accounts signed in to Xcode (no ASC API key configured)');
    }
    return {
      xcodebuildArgs,
      buildSettings: this.automaticBuildSettings(),
      exportOptions: { method: this.signing.method, signingStyle: 'automatic', teamId: this.signing.teamId },
      cleanup: async () => {
        await keyFile?.cleanup();
      },
    };
  }

  private async prepareManual(ctx: StepContext): Promise<IosSigningSession> {
    const cleanups: Array<() => Promise<void>> = [];
    const cleanup = async () => {
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch (err) {
          ctx.log('stderr', `Signing cleanup step failed: ${(err as Error).message}`);
        }
      }
    };

    try {
      const profiles = await this.installProfiles(ctx, cleanups);
      const teamId = this.signing.teamId ?? profiles[0]?.teamId;
      const provisioningProfiles = this.mapProfiles(profiles);

      const buildSettings: Record<string, string> = { CODE_SIGN_STYLE: 'Manual' };
      if (teamId) buildSettings.DEVELOPMENT_TEAM = teamId;
      // A command-line build setting applies to every target, so the profile
      // can only be forced for single-target apps; with extensions each
      // target must reference its profile in the project itself.
      const onlyProfile = profiles.length === 1 ? profiles[0] : undefined;
      if (onlyProfile) buildSettings.PROVISIONING_PROFILE_SPECIFIER = onlyProfile.uuid;
      else ctx.log('stdout', `${profiles.length} profiles installed — targets must reference them in the project (PROVISIONING_PROFILE_SPECIFIER)`);

      let signingCertificate: string | undefined;
      if (this.signing.certificateRef) {
        const keychain = await this.importCertificate(ctx, cleanups);
        signingCertificate = keychain.identity;
        buildSettings.CODE_SIGN_IDENTITY = keychain.identity;
        buildSettings.OTHER_CODE_SIGN_FLAGS = `--keychain ${keychain.path}`;
      } else {
        ctx.log('stdout', 'No ios.signing.certificateRef — using identities already present in the keychain search list');
      }

      return {
        xcodebuildArgs: [],
        buildSettings,
        exportOptions: {
          method: this.signing.method,
          signingStyle: 'manual',
          teamId,
          provisioningProfiles,
          signingCertificate,
        },
        cleanup,
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  private mapProfiles(profiles: ProvisioningProfileInfo[]): Record<string, string> {
    const bundleId = this.signing.bundleId;
    const map: Record<string, string> = {};
    for (const profile of profiles) {
      if (profile.bundleId.includes('*')) {
        if (!bundleId) {
          throw new SigningError(`Profile "${profile.name}" is a wildcard profile (${profile.bundleId})`, {
            hint: 'Set ios.signing.bundleId so the export knows which bundle it signs.',
          });
        }
        if (!wildcardMatches(profile.bundleId, bundleId)) continue;
        map[bundleId] = profile.uuid;
      } else {
        map[profile.bundleId] = profile.uuid;
      }
    }
    if (bundleId && !map[bundleId]) {
      throw new SigningError(`No provisioning profile matches bundle ID ${bundleId}`, {
        hint: `Profiles provided: ${profiles.map((p) => `${p.name} (${p.bundleId})`).join(', ')}.`,
      });
    }
    return map;
  }

  private async installProfiles(ctx: StepContext, cleanups: Array<() => Promise<void>>): Promise<ProvisioningProfileInfo[]> {
    const profiles: ProvisioningProfileInfo[] = [];
    // Xcode 16 moved the profile store; both locations are populated so the
    // same config works across Xcode versions.
    const dirs = [
      join(this.homeDir, 'Library', 'MobileDevice', 'Provisioning Profiles'),
      join(this.homeDir, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
    ];
    for (const ref of this.signing.profileRefs ?? []) {
      const value = await this.options.secrets.resolve(ref);
      const file = await materializeSecretFile(value, { fileName: 'profile.mobileprovision', encoding: 'base64', label: ref });
      cleanups.push(file.cleanup);
      const info = await this.decodeProfile(file.path, ref);
      if (info.expiresAt && info.expiresAt.getTime() < this.now().getTime()) {
        throw new SigningError(`Provisioning profile "${info.name}" expired on ${info.expiresAt.toISOString()}`, {
          hint: 'Regenerate the profile in the Apple Developer portal and update the secret.',
        });
      }
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
        const target = join(dir, `${info.uuid}.mobileprovision`);
        if (existsSync(target)) continue;
        await copyFile(file.path, target);
        cleanups.push(() => rm(target, { force: true }));
      }
      ctx.log('stdout', `Installed provisioning profile "${info.name}" (${info.uuid}) for ${info.bundleId}`);
      profiles.push(info);
    }
    return profiles;
  }

  async decodeProfile(path: string, label: string): Promise<ProvisioningProfileInfo> {
    const result = await this.options.processes.run('security', ['cms', '-D', '-i', path]);
    if (result.exitCode !== 0) {
      throw new SigningError(`Could not decode provisioning profile ${label}`, {
        hint: 'Make sure the secret points at a valid .mobileprovision file.',
        context: { stderr: result.stderr.slice(0, 500) },
      });
    }
    return parseProvisioningProfile(result.stdout, label);
  }

  private async importCertificate(
    ctx: StepContext,
    cleanups: Array<() => Promise<void>>,
  ): Promise<{ path: string; identity: string }> {
    const { secrets } = this.options;
    const certValue = await secrets.resolve(this.signing.certificateRef!);
    const password = await secrets.resolve(this.signing.certificatePasswordRef!);
    const p12 = await materializeSecretFile(certValue, { fileName: 'certificate.p12', encoding: 'base64', label: this.signing.certificateRef! });
    cleanups.push(p12.cleanup);

    const dir = await mkdtemp(join(tmpdir(), 'caricamento-keychain-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const keychain = join(dir, 'caricamento-signing.keychain-db');
    const keychainPassword = randomBytes(24).toString('hex');

    await this.security(['create-keychain', '-p', keychainPassword, keychain], 'create-keychain');
    cleanups.push(async () => {
      await this.options.processes.run('security', ['delete-keychain', keychain]);
    });
    // No auto-lock during long archives (6h timeout, no lock on sleep).
    await this.security(['set-keychain-settings', '-lut', '21600', keychain], 'set-keychain-settings');
    await this.security(['unlock-keychain', '-p', keychainPassword, keychain], 'unlock-keychain');
    await this.security(
      ['import', p12.path, '-k', keychain, '-P', password, '-f', 'pkcs12', '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'],
      'import',
    );
    // Lets codesign use the key without a UI prompt (headless/CI).
    await this.security(
      ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain],
      'set-key-partition-list',
    );

    const original = await this.listKeychains();
    await this.security(['list-keychains', '-d', 'user', '-s', keychain, ...original], 'list-keychains');
    cleanups.push(async () => {
      await this.options.processes.run('security', ['list-keychains', '-d', 'user', '-s', ...original]);
    });

    const identities = await this.options.processes.run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
    const identity = parseIdentities(identities.stdout)[0];
    if (!identity) {
      throw new SigningError('The imported .p12 contains no valid code signing identity', {
        hint: 'Export the Apple Distribution certificate together with its private key, and check that the WWDR intermediate certificate is installed.',
      });
    }
    ctx.log('stdout', `Imported signing identity "${identity.name}" (${identity.sha1}) into a temporary keychain`);
    return { path: keychain, identity: identity.sha1 };
  }

  private async listKeychains(): Promise<string[]> {
    const result = await this.options.processes.run('security', ['list-keychains', '-d', 'user']);
    return [...result.stdout.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }

  private async security(args: string[], what: string): Promise<void> {
    const result = await this.options.processes.run('security', args);
    if (result.exitCode !== 0) {
      throw new SigningError(`security ${what} failed (exit ${result.exitCode})`, {
        hint: what === 'import' ? 'Check certificatePasswordRef — the .p12 password is probably wrong.' : undefined,
        context: { stderr: result.stderr.slice(0, 500) },
      });
    }
  }

  /** Post-build check: the .ipa's app bundle carries a valid signature (SPEC §6.1). */
  async verify(ctx: StepContext, artifact: Artifact): Promise<SigningVerification> {
    if (this.signing.mode === 'none') {
      ctx.log('stdout', 'Unsigned build (ios.signing.mode "none") — skipping signature verification');
      return { verified: false };
    }
    const dir = await mkdtemp(join(tmpdir(), 'caricamento-ipa-'));
    try {
      const unzip = await this.options.processes.run('unzip', ['-q', artifact.path, '-d', dir]);
      if (unzip.exitCode !== 0) throw new SigningError(`Could not unpack ${artifact.path}`, { context: { stderr: unzip.stderr } });
      const apps = (await readdir(join(dir, 'Payload')).catch(() => [])).filter((f) => f.endsWith('.app'));
      if (!apps[0]) throw new SigningError(`${artifact.path} contains no Payload/*.app`);
      const app = join(dir, 'Payload', apps[0]);

      const check = await this.options.processes.run('codesign', ['--verify', '--deep', '--strict', app]);
      if (check.exitCode !== 0) {
        throw new SigningError('codesign --verify rejected the exported app', {
          hint: 'Check the signing identity and provisioning profile used for the export.',
          context: { stderr: check.stderr.slice(0, 500) },
        });
      }
      const details = await this.options.processes.run('codesign', ['-dvv', app]);
      const output = details.stderr + details.stdout;
      const authority = /^Authority=(.+)$/m.exec(output)?.[1];
      const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
      if (this.signing.teamId && team && team !== this.signing.teamId) {
        throw new SigningError(`App is signed by team ${team}, expected ${this.signing.teamId}`, {
          hint: 'The wrong certificate/profile was picked — check ios.signing.teamId and the installed identities.',
        });
      }
      return { verified: true, identity: authority };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function unsignedBuildSettings(): Record<string, string> {
  return { CODE_SIGNING_ALLOWED: 'NO', CODE_SIGNING_REQUIRED: 'NO', CODE_SIGN_IDENTITY: '' };
}

function authArgs(keyPath: string, keyId: string, issuerId: string): string[] {
  return ['-authenticationKeyPath', keyPath, '-authenticationKeyID', keyId, '-authenticationKeyIssuerID', issuerId];
}

function wildcardMatches(pattern: string, bundleId: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('*') && bundleId.startsWith(pattern.slice(0, -1));
}

/** Parses the decoded (`security cms -D`) XML plist of a .mobileprovision. */
export function parseProvisioningProfile(xml: string, label = 'profile'): ProvisioningProfileInfo {
  let plist: PlistValue;
  try {
    plist = parsePlist(xml);
  } catch (err) {
    throw new SigningError(`Provisioning profile ${label} is not a valid property list`, { cause: err });
  }
  const dict = plist as Record<string, PlistValue>;
  const entitlements = (dict.Entitlements ?? {}) as Record<string, PlistValue>;
  const uuid = dict.UUID;
  const name = dict.Name;
  const appIdentifier = entitlements['application-identifier'];
  if (typeof uuid !== 'string' || typeof name !== 'string' || typeof appIdentifier !== 'string') {
    throw new SigningError(`Provisioning profile ${label} lacks UUID/Name/application-identifier`);
  }
  const teamId = Array.isArray(dict.TeamIdentifier) && typeof dict.TeamIdentifier[0] === 'string' ? dict.TeamIdentifier[0] : undefined;
  const prefix = appIdentifier.indexOf('.');
  const bundleId = prefix === -1 ? appIdentifier : appIdentifier.slice(prefix + 1);
  const expiresAt = dict.ExpirationDate instanceof Date ? dict.ExpirationDate : undefined;
  return { uuid, name, teamId, bundleId, expiresAt };
}

/** Parses `security find-identity -v -p codesigning` output. */
export function parseIdentities(output: string): Array<{ sha1: string; name: string }> {
  return [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ sha1: m[1]!, name: m[2]! }));
}
