import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaricamentoConfig } from '../core/config/schema.js';
import type { ProcessRunner, SecretResolver } from '../core/ports/index.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
  hint?: string;
}

export interface DoctorInput {
  cwd: string;
  config?: CaricamentoConfig;
}

export class DoctorUseCase {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly secrets: SecretResolver,
  ) {}

  async execute(input: DoctorInput): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.checkJava());
    checks.push(this.checkGradleWrapper(input.cwd, input.config));
    checks.push(await this.checkApksigner());
    checks.push(await this.checkFirebaseCredentials(input.config));
    checks.push(await this.checkXcode(input.config));
    checks.push(await this.checkCodesignIdentities(input.config));
    const asc = await this.checkAppStoreCredentials(input.config);
    if (asc) checks.push(asc);
    return checks;
  }

  /** Failing only matters when the project actually builds for iOS. */
  private async checkXcode(config?: CaricamentoConfig): Promise<DoctorCheck> {
    const missing: DoctorCheck['status'] = config?.ios ? 'fail' : 'warn';
    if (process.platform !== 'darwin') {
      return { name: 'xcode', status: missing, message: 'iOS builds require macOS', hint: 'Run iOS builds on a Mac with Xcode installed.' };
    }
    try {
      const result = await this.processes.run('xcodebuild', ['-version']);
      if (result.exitCode === 0) {
        return { name: 'xcode', status: 'ok', message: result.stdout.trim().split('\n').join(', ') };
      }
      return {
        name: 'xcode',
        status: missing,
        message: (result.stderr || result.stdout).trim().split('\n')[0],
        hint: 'Install Xcode and select it: `sudo xcode-select -s /Applications/Xcode.app` (Command Line Tools alone are not enough).',
      };
    } catch {
      return { name: 'xcode', status: missing, message: 'xcodebuild not found', hint: 'Install Xcode from the App Store.' };
    }
  }

  /** Warn-only: unsigned local builds (ios.signing.mode "none") need no identity. */
  private async checkCodesignIdentities(config?: CaricamentoConfig): Promise<DoctorCheck> {
    if (process.platform !== 'darwin') {
      return { name: 'codesign identities', status: 'warn', message: 'not on macOS' };
    }
    try {
      const result = await this.processes.run('security', ['find-identity', '-v', '-p', 'codesigning']);
      const count = Number(/(\d+) valid identit/.exec(result.stdout)?.[1] ?? 0);
      if (result.exitCode === 0 && count > 0) {
        return { name: 'codesign identities', status: 'ok', message: `${count} valid identit${count === 1 ? 'y' : 'ies'} in the keychain` };
      }
      return {
        name: 'codesign identities',
        status: 'warn',
        message: 'no valid code signing identities in the keychain search list',
        hint:
          config?.ios?.signing.mode === 'manual'
            ? 'Fine when ios.signing.certificateRef is set — the .p12 is imported into a temporary keychain at build time.'
            : 'Local builds can stay unsigned (ios.signing.mode "none"); automatic signing creates certificates via -allowProvisioningUpdates.',
      };
    } catch {
      return { name: 'codesign identities', status: 'warn', message: '`security` not available' };
    }
  }

  private async checkAppStoreCredentials(config?: CaricamentoConfig): Promise<DoctorCheck | null> {
    const asc = config?.targets.appstore;
    if (!asc) return null;
    const value = await this.secrets.tryResolve(asc.apiKeyRef);
    if (value === null) {
      return {
        name: 'app store connect key',
        status: 'fail',
        message: `${asc.apiKeyRef} could not be resolved`,
        hint: 'Store the AuthKey_<KEYID>.p8 path or its PEM content under that secret name (env, Keychain, or .env).',
      };
    }
    if (!value.includes('-----BEGIN') && !existsSync(value)) {
      return {
        name: 'app store connect key',
        status: 'fail',
        message: `${asc.apiKeyRef} is neither a file path nor PEM content`,
        hint: 'Point the secret at the .p8 file downloaded from App Store Connect → Users and Access → Integrations.',
      };
    }
    return { name: 'app store connect key', status: 'ok', message: `key ${asc.keyId} resolved via ${asc.apiKeyRef}` };
  }

  private async checkJava(): Promise<DoctorCheck> {
    try {
      const result = await this.processes.run('java', ['-version']);
      if (result.exitCode === 0) {
        const versionLine = (result.stderr + result.stdout).split('\n')[0]?.trim();
        return { name: 'java', status: 'ok', message: versionLine };
      }
      return { name: 'java', status: 'fail', hint: 'Install a JDK (17+ recommended for Android builds).' };
    } catch {
      return { name: 'java', status: 'fail', hint: 'Install a JDK (17+ recommended for Android builds).' };
    }
  }

  private checkGradleWrapper(cwd: string, config?: CaricamentoConfig): DoctorCheck {
    if (existsSync(join(cwd, 'gradlew'))) {
      return { name: 'gradle wrapper', status: 'ok', message: './gradlew found' };
    }
    // React Native / Flutter projects keep the Android wrapper in android/
    if (existsSync(join(cwd, 'android', 'gradlew'))) {
      return { name: 'gradle wrapper', status: 'ok', message: './android/gradlew found' };
    }
    return {
      name: 'gradle wrapper',
      status: config?.ios && !config.android ? 'warn' : 'fail',
      message: 'gradlew not found in project root or android/',
      hint: 'Generate it with `gradle wrapper` in the project, or use a project that already has one.',
    };
  }

  private async checkApksigner(): Promise<DoctorCheck> {
    const onPath = await this.processes.which('apksigner');
    if (onPath) return { name: 'apksigner', status: 'ok', message: onPath };
    const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (sdkRoot) {
      try {
        const versions = await readdir(join(sdkRoot, 'build-tools'));
        if (versions.length > 0) {
          return { name: 'apksigner', status: 'ok', message: join(sdkRoot, 'build-tools', versions.sort().reverse()[0] ?? '', 'apksigner') };
        }
      } catch {
        // fall through
      }
    }
    return {
      name: 'apksigner',
      status: 'warn',
      message: 'not found on PATH and no Android SDK build-tools located',
      hint: 'Only needed for post-build signature verification. Install Android SDK build-tools or set ANDROID_HOME.',
    };
  }

  private async checkFirebaseCredentials(config?: CaricamentoConfig): Promise<DoctorCheck> {
    const ref = config?.targets.firebase?.serviceAccountRef;
    if (ref) {
      const value = await this.secrets.tryResolve(ref);
      if (value !== null) {
        return { name: 'firebase credentials', status: 'ok', message: `resolved via ${ref}` };
      }
      return {
        name: 'firebase credentials',
        status: 'fail',
        message: `${ref} could not be resolved`,
        hint: 'Store the service-account JSON path/content under that secret name (env, Keychain, or .env).',
      };
    }
    const adc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (adc && existsSync(adc)) {
      return { name: 'firebase credentials', status: 'ok', message: `GOOGLE_APPLICATION_CREDENTIALS=${adc}` };
    }
    return {
      name: 'firebase credentials',
      status: 'warn',
      message: 'GOOGLE_APPLICATION_CREDENTIALS is not set',
      hint: 'Required for `upload --target firebase`. Set it to a service-account JSON key file.',
    };
  }
}
