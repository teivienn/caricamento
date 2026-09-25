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
    checks.push(this.checkGradleWrapper(input.cwd));
    checks.push(await this.checkApksigner());
    checks.push(await this.checkFirebaseCredentials(input.config));
    return checks;
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

  private checkGradleWrapper(cwd: string): DoctorCheck {
    if (existsSync(join(cwd, 'gradlew'))) {
      return { name: 'gradle wrapper', status: 'ok', message: './gradlew found' };
    }
    return {
      name: 'gradle wrapper',
      status: 'fail',
      message: 'gradlew not found in project root',
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
