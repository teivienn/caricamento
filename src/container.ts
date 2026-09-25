import { join } from 'node:path';
import { BuildUseCase } from './application/build.js';
import { DetectUseCase } from './application/detect.js';
import { DoctorUseCase } from './application/doctor.js';
import { ReleaseUseCase } from './application/release.js';
import { StatusUseCase } from './application/status.js';
import { UploadUseCase } from './application/upload.js';
import { configSchema, type CaricamentoConfig } from './core/config/schema.js';
import type { Publisher } from './core/ports/index.js';
import { GradleBuilder } from './infra/builders/gradle.js';
import { createGoogleTokenProvider, type TokenProvider } from './infra/publishers/firebase/auth.js';
import { FirebasePublisher } from './infra/publishers/firebase/publisher.js';
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

  const configPath = resolveConfigPath(cwd, options.configPath);
  const config = await new JitiConfigLoader().loadValidated(configPath);

  const builder = new GradleBuilder(processes, secrets, config);
  const signing = config.android?.signing ? new AndroidSigningProvider(processes, config) : null;

  const publishers: Record<string, Publisher> = {};
  if (config.targets.firebase) {
    const firebaseConfig = config.targets.firebase;
    let lazyProvider: TokenProvider | null = null;
    const tokenProvider: TokenProvider = async () => {
      if (!lazyProvider) {
        const credential = firebaseConfig.serviceAccountRef
          ? await secrets.resolve(firebaseConfig.serviceAccountRef)
          : undefined;
        lazyProvider = createGoogleTokenProvider(credential);
      }
      return lazyProvider();
    };
    publishers.firebase = new FirebasePublisher({ config: firebaseConfig, platform: 'android', tokenProvider });
  }

  return {
    cwd,
    config,
    processes,
    secrets,
    runs,
    detect: new DetectUseCase(),
    doctor: new DoctorUseCase(processes, secrets),
    build: new BuildUseCase({ config, builder, signing, recorder: runs }),
    upload: new UploadUseCase({ publishers, recorder: runs }),
    release: new ReleaseUseCase({ config, builder, signing, publishers, recorder: runs }),
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
