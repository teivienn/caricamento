import { join } from 'node:path';
import { ApkUseCase } from './application/apk.js';
import { BuildUseCase } from './application/build.js';
import { DetectUseCase } from './application/detect.js';
import { DoctorUseCase } from './application/doctor.js';
import { ReleaseUseCase } from './application/release.js';
import { StatusUseCase } from './application/status.js';
import { UploadUseCase } from './application/upload.js';
import { configSchema, type CaricamentoConfig, type Platform } from './core/config/schema.js';
import { ConfigError } from './core/errors.js';
import type { Builder, Publisher, SigningProvider, VersionCodeProvider } from './core/ports/index.js';
import { resolveVersionSource } from './core/versioning/index.js';
import { GradleBuilder } from './infra/builders/gradle.js';
import { XcodeBuilder } from './infra/builders/xcode.js';
import { AppStoreConnectClient } from './infra/publishers/appstoreconnect/client.js';
import { UnzipIpaInfoReader } from './infra/publishers/appstoreconnect/ipa-info.js';
import { createAscTokenProvider, type AscCredentials } from './infra/publishers/appstoreconnect/jwt.js';
import { AppStorePublisher } from './infra/publishers/appstoreconnect/publisher.js';
import { AltoolBuildUploader, ApiBuildUploader } from './infra/publishers/appstoreconnect/upload.js';
import { AppStoreVersionCodeProvider } from './infra/publishers/appstoreconnect/version-code.js';
import { GitChangelogProvider } from './infra/changelog/git.js';
import { createGoogleTokenProvider, type TokenProvider } from './infra/publishers/firebase/auth.js';
import { FirebasePublisher } from './infra/publishers/firebase/publisher.js';
import { FirebaseVersionCodeProvider } from './infra/publishers/firebase/version-code.js';
import { PlayPublisher } from './infra/publishers/googleplay/publisher.js';
import { PlaySharingPublisher } from './infra/publishers/googleplay/sharing.js';
import { PlayVersionCodeProvider } from './infra/publishers/googleplay/version-code.js';
import { AndroidSigningProvider } from './infra/signing/android.js';
import { IosSigningProvider } from './infra/signing/ios.js';
import { BundletoolApkConverter } from './infra/system/bundletool.js';
import { JitiConfigLoader, resolveConfigPath } from './infra/system/config-loader.js';
import { DotenvSecretStore } from './infra/system/dotenv.js';
import { EnvSecretStore } from './infra/system/env.js';
import { KeychainSecretStore } from './infra/system/keychain.js';
import { NodeProcessRunner } from './infra/system/process.js';
import { RunStore } from './infra/system/runstore.js';
import { readPemSecret } from './infra/system/secret-file.js';
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
  /** Platform to wire builder, signing, publishers and version source for. Default: android. */
  platform?: Platform;
}

/** Composition root (SPEC §3.1): plain factory object, no DI framework. */
export interface Container {
  cwd: string;
  config: CaricamentoConfig;
  platform: Platform;
  /** Names of distribution targets usable for this platform (configured and compatible). */
  targets: string[];
  processes: NodeProcessRunner;
  secrets: ChainedSecretResolver;
  runs: RunStore;
  detect: DetectUseCase;
  doctor: DoctorUseCase;
  build: BuildUseCase;
  upload: UploadUseCase;
  release: ReleaseUseCase;
  apk: ApkUseCase;
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

  // Configs are executable TS and may read project files (e.g. versionName
  // from package.json); registry configs live outside the project, so the
  // project dir is exposed via this env var before the config is evaluated.
  process.env.CARICAMENTO_PROJECT_DIR = cwd;
  const config = options.configOverride ?? (await new JitiConfigLoader().loadValidated(resolveConfigPath(cwd, options.configPath)));

  const platform: Platform = options.platform ?? 'android';
  let builder: Builder;
  let signing: SigningProvider | null;
  if (platform === 'ios') {
    const iosSigning = new IosSigningProvider({ processes, secrets, config });
    builder = new XcodeBuilder(processes, config, iosSigning);
    signing = iosSigning;
  } else {
    builder = new GradleBuilder(processes, secrets, config);
    signing = config.android?.signing ? new AndroidSigningProvider(processes, config) : null;
  }

  // Publishers are registered only for targets that accept this platform's
  // artifacts; token providers are created regardless (a version source may
  // come from another platform's store, e.g. shared numbering).
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
    publishers.firebase = new FirebasePublisher({ config: firebaseConfig, platform, tokenProvider: firebaseTokenProvider });
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
    if (platform === 'android') publishers.play = new PlayPublisher({ config: playConfig, tokenProvider: playTokenProvider });
  }

  if (config.targets.playsharing && platform === 'android') {
    const sharingConfig = config.targets.playsharing;
    let lazyProvider: TokenProvider | null = null;
    const tokenProvider: TokenProvider = async () => {
      if (!lazyProvider) {
        const credential = await secrets.resolve(sharingConfig.serviceAccountRef);
        lazyProvider = createGoogleTokenProvider(credential, {
          scopes: ['https://www.googleapis.com/auth/androidpublisher'],
          service: 'Google Play Internal App Sharing',
        });
      }
      return lazyProvider();
    };
    publishers.playsharing = new PlaySharingPublisher({ config: sharingConfig, tokenProvider });
  }

  let ascClient: AppStoreConnectClient | undefined;
  let ascCredentials: (() => Promise<AscCredentials>) | undefined;
  if (config.targets.appstore) {
    const ascConfig = config.targets.appstore;
    ascCredentials = async () => ({
      privateKey: await readPemSecret(await secrets.resolve(ascConfig.apiKeyRef), ascConfig.apiKeyRef),
      keyId: ascConfig.keyId,
      issuerId: ascConfig.issuerId,
    });
    ascClient = new AppStoreConnectClient({ tokenProvider: createAscTokenProvider(ascCredentials) });
    if (platform === 'ios') {
      publishers.appstore = new AppStorePublisher({
        config: ascConfig,
        client: ascClient,
        uploader: ascConfig.upload === 'altool' ? new AltoolBuildUploader(processes, ascCredentials) : new ApiBuildUploader(ascClient),
        ipaInfo: new UnzipIpaInfoReader(processes),
      });
    }
  }

  // auto-increment source: explicit version.source, else play > appstore >
  // firebase among the targets native to the platform (SPEC §8).
  let versionCodeProvider: VersionCodeProvider | undefined;
  if (config.version.strategy === 'auto-increment') {
    const source = resolveVersionSource(config, platform);
    if (source === 'play') {
      if (!config.targets.play || !playTokenProvider) {
        throw new ConfigError('version.source is "play" but targets.play is not configured', {
          hint: 'Configure targets.play (serviceAccountRef + packageName) or set version.source to "firebase".',
        });
      }
      versionCodeProvider = new PlayVersionCodeProvider({ packageName: config.targets.play.packageName, tokenProvider: playTokenProvider });
    } else if (source === 'appstore') {
      if (!config.targets.appstore || !ascClient) {
        throw new ConfigError('version.source is "appstore" but targets.appstore is not configured', {
          hint: 'Configure targets.appstore (apiKeyRef + keyId + issuerId + bundleId) or pick another version.source.',
        });
      }
      versionCodeProvider = new AppStoreVersionCodeProvider({ client: ascClient, bundleId: config.targets.appstore.bundleId });
    } else if (source === 'firebase') {
      if (!config.targets.firebase || !firebaseTokenProvider) {
        throw new ConfigError('version.source is "firebase" but targets.firebase is not configured', {
          hint: `Configure targets.firebase (appId${platform === 'ios' ? 'Ios' : 'Android'} + credentials) or pick another version.source.`,
        });
      }
      versionCodeProvider = new FirebaseVersionCodeProvider({
        config: config.targets.firebase,
        platform,
        tokenProvider: firebaseTokenProvider,
      });
    }
  }

  const changelog = config.changelog ? new GitChangelogProvider(processes, config.changelog) : undefined;

  return {
    cwd,
    config,
    platform,
    targets: Object.keys(publishers),
    processes,
    secrets,
    runs,
    detect: new DetectUseCase(),
    doctor: new DoctorUseCase(processes, secrets),
    build: new BuildUseCase({ config, platform, builder, signing, versionCodeProvider, recorder: runs }),
    upload: new UploadUseCase({ publishers, recorder: runs }),
    release: new ReleaseUseCase({ config, platform, builder, signing, publishers, versionCodeProvider, changelog, recorder: runs }),
    apk: new ApkUseCase({ converter: new BundletoolApkConverter({ processes, secrets, config }), recorder: runs }),
    status: new StatusUseCase(runs),
  };
}

/** Container for commands that must work without a config file (detect, doctor, init). */
export function createBareContainer(
  options: ContainerOptions,
): Omit<Container, 'config' | 'platform' | 'targets' | 'build' | 'upload' | 'release' | 'apk'> & { config: CaricamentoConfig } {
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
