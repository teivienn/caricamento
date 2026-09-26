import { join } from 'node:path';
import { BuildUseCase } from './application/build.js';
import { DetectUseCase } from './application/detect.js';
import { DoctorUseCase } from './application/doctor.js';
import { ReleaseUseCase } from './application/release.js';
import { StatusUseCase } from './application/status.js';
import { UploadUseCase } from './application/upload.js';
import { configSchema, type CaricamentoConfig } from './core/config/schema.js';
import { ConfigError } from './core/errors.js';
import type { Publisher, VersionCodeProvider } from './core/ports/index.js';
import { GradleBuilder } from './infra/builders/gradle.js';
import { createGoogleTokenProvider, type TokenProvider } from './infra/publishers/firebase/auth.js';
import { FirebasePublisher } from './infra/publishers/firebase/publisher.js';
import { FirebaseVersionCodeProvider } from './infra/publishers/firebase/version-code.js';
import { PlayPublisher } from './infra/publishers/googleplay/publisher.js';
import { PlayVersionCodeProvider } from './infra/publishers/googleplay/version-code.js';
import { AndroidSigningProvider } from './infra/signing/android.js';
import { JitiConfigLoader, resolveConfigPath } from './infra/system/config-loader.js';
import { DotenvSecretStore } from './infra/system/dotenv.js';
import { EnvSecretStore } from './infra/system/env.js';
import { KeychainSecretStore } from './infra/system/keychain.js';
import { NodeProcessRunner } from './infra/system/process.js';
import { RunStore } from './infra/system/runstore.js';
import { ChainedSecretResolver } from './infra/system/secrets.js';

export interface ContainerOptions {
  cwd: string;
  configPath?: string;
  /** Extra .env files consulted before <cwd>/.env (SPEC §3.5, registry mode). */
  envFiles?: string[];
  /**
   * Pre-resolved config (e.g. a merged build variant). When present, the
   * config file is not loaded.
   */
  configOverride?: CaricamentoConfig;
}

/** Composition root (SPEC §3.1): plain factory object, no DI framework. */
export interface Container {
  cwd: string;
  config: CaricamentoConfig;
  processes: NodeProcessRunner;
  secrets: ChainedSecretResolver;
  runs: RunStore;
  detect: DetectUseCase;
  doctor: DoctorUseCase;
  build: BuildUseCase;
  upload: UploadUseCase;
  release: ReleaseUseCase;
  status: StatusUseCase;
}

export async function createContainer(options: ContainerOptions): Promise<Container> {
  const { cwd } = options;
  const processes = new NodeProcessRunner();
  // SPEC §3.5 chain: env vars -> macOS Keychain -> registry .env -> project .env
  const secrets = new ChainedSecretResolver([
    new EnvSecretStore(),
    new KeychainSecretStore(processes),
    new DotenvSecretStore([...(options.envFiles ?? []), join(cwd, '.env')]),
  ]);
  const runs = new RunStore();

  const config = options.configOverride ?? (await new JitiConfigLoader().loadValidated(resolveConfigPath(cwd, options.configPath)));

  const builder = new GradleBuilder(processes, secrets, config);
  const signing = config.android?.signing ? new AndroidSigningProvider(processes, config) : null;

  const publishers: Record<string, Publisher> = {};

  let firebaseTokenProvider: TokenProvider | undefined;
  if (config.targets.firebase) {
    const firebaseConfig = config.targets.firebase;
    let lazyProvider: TokenProvider | null = null;
    firebaseTokenProvider = async () => {
      if (!lazyProvider) {
        const credential = firebaseConfig.serviceAccountRef
          ? await secrets.resolve(firebaseConfig.serviceAccountRef)
          : undefined;
        lazyProvider = createGoogleTokenProvider(credential, { service: 'Firebase App Distribution' });
      }
      return lazyProvider();
    };
    publishers.firebase = new FirebasePublisher({ config: firebaseConfig, platform: 'android', tokenProvider: firebaseTokenProvider });
  }

  let playTokenProvider: TokenProvider | undefined;
  if (config.targets.play) {
    const playConfig = config.targets.play;
    let lazyProvider: TokenProvider | null = null;
    playTokenProvider = async () => {
      if (!lazyProvider) {
        const credential = await secrets.resolve(playConfig.serviceAccountRef);
        lazyProvider = createGoogleTokenProvider(credential, {
          scopes: ['https://www.googleapis.com/auth/androidpublisher'],
          service: 'Google Play',
        });
      }
      return lazyProvider();
    };
    publishers.play = new PlayPublisher({ config: playConfig, tokenProvider: playTokenProvider });
  }

  // auto-increment source: explicit version.source, else play when configured,
  // else firebase (SPEC §8).
  let versionCodeProvider: VersionCodeProvider | undefined;
  if (config.version.strategy === 'auto-increment') {
    const source = config.version.source ?? (config.targets.play ? 'play' : 'firebase');
    if (source === 'play') {
      if (!config.targets.play || !playTokenProvider) {
        throw new ConfigError('version.source is "play" but targets.play is not configured', {
          hint: 'Configure targets.play (serviceAccountRef + packageName) or set version.source to "firebase".',
        });
      }
      versionCodeProvider = new PlayVersionCodeProvider({ packageName: config.targets.play.packageName, tokenProvider: playTokenProvider });
    } else {
      if (!config.targets.firebase || !firebaseTokenProvider) {
        throw new ConfigError('version.source is "firebase" but targets.firebase is not configured', {
          hint: 'Configure targets.firebase (appIdAndroid + credentials) or set version.source to "play".',
        });
      }
      versionCodeProvider = new FirebaseVersionCodeProvider({
        config: config.targets.firebase,
        platform: 'android',
        tokenProvider: firebaseTokenProvider,
      });
    }
  }

  return {
    cwd,
    config,
    processes,
    secrets,
    runs,
    detect: new DetectUseCase(),
    doctor: new DoctorUseCase(processes, secrets),
    build: new BuildUseCase({ config, builder, signing, versionCodeProvider, recorder: runs }),
    upload: new UploadUseCase({ publishers, recorder: runs }),
    release: new ReleaseUseCase({ config, builder, signing, publishers, versionCodeProvider, recorder: runs }),
    status: new StatusUseCase(runs),
  };
}

/** Container for commands that must work without a config file (detect, doctor, init). */
export function createBareContainer(options: ContainerOptions): Omit<Container, 'config' | 'build' | 'upload' | 'release'> & { config: CaricamentoConfig } {
  const { cwd } = options;
  const processes = new NodeProcessRunner();
  const secrets = new ChainedSecretResolver([
    new EnvSecretStore(),
    new KeychainSecretStore(processes),
    new DotenvSecretStore([...(options.envFiles ?? []), join(cwd, '.env')]),
  ]);
  const runs = new RunStore();
  return {
    cwd,
    config: configSchema.parse({}),
    processes,
    secrets,
    runs,
    detect: new DetectUseCase(),
    doctor: new DoctorUseCase(processes, secrets),
    status: new StatusUseCase(runs),
  };
}
