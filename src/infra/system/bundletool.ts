import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CaricamentoConfig } from '../../core/config/schema.js';
import { BuildError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { ApkConverter, ProcessRunner, SecretResolver } from '../../core/ports/index.js';

// The GitHub "latest/download" alias does not exist for bundletool (the
// asset name is versioned: bundletool-all-<version>.jar), so resolve the
// real URL through the releases API first.
const BUNDLETOOL_LATEST_API = 'https://api.github.com/repos/google/bundletool/releases/latest';

/** How bundletool is invoked: brew binary directly, or `java -jar <jar>`. */
export interface BundletoolInvocation {
  executable: string;
  prefixArgs: string[];
}

export interface BundletoolResolverDeps {
  env: NodeJS.ProcessEnv;
  which: (tool: string) => Promise<string | null>;
  exists: (path: string) => boolean;
  download: (url: string, dest: string) => Promise<void>;
  toolsDir: string;
}

/**
 * bundletool resolution order: $BUNDLETOOL_PATH -> `bundletool` on PATH ->
 * ~/.caricamento/tools/bundletool.jar (downloaded once from the GitHub
 * release and cached) -> BuildError with a brew hint.
 */
export async function resolveBundletool(deps: BundletoolResolverDeps): Promise<BundletoolInvocation> {
  const fromEnv = deps.env.BUNDLETOOL_PATH;
  if (fromEnv) {
    if (!deps.exists(fromEnv)) {
      throw new BuildError(`BUNDLETOOL_PATH points at a missing file: ${fromEnv}`, {
        hint: 'Fix the variable or unset it to use PATH/auto-download.',
      });
    }
    return invocationFor(fromEnv);
  }

  const onPath = await deps.which('bundletool');
  if (onPath) return invocationFor(onPath);

  const cached = join(deps.toolsDir, 'bundletool.jar');
  if (!deps.exists(cached)) {
    await deps.download(BUNDLETOOL_LATEST_API, cached);
  }
  return invocationFor(cached);
}

function invocationFor(path: string): BundletoolInvocation {
  return path.endsWith('.jar') ? { executable: 'java', prefixArgs: ['-jar', path] } : { executable: path, prefixArgs: [] };
}

export interface BundletoolApkConverterOptions {
  processes: ProcessRunner;
  secrets: SecretResolver;
  config: CaricamentoConfig;
  fetchImpl?: typeof fetch;
  /** Overrides the cache dir (~/.caricamento/tools) — used in tests. */
  toolsDir?: string;
}

/**
 * AAB -> universal APK for local installs (SPEC §5.5):
 * `bundletool build-apks --mode=universal`, signed with the project's
 * android.signing secrets, then `universal.apk` is extracted from the
 * resulting .apks zip.
 */
export class BundletoolApkConverter implements ApkConverter {
  private readonly fetchImpl: typeof fetch;
  private readonly toolsDir: string;

  constructor(private readonly options: BundletoolApkConverterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.toolsDir = options.toolsDir ?? join(homedir(), '.caricamento', 'tools');
  }

  async buildUniversalApk(ctx: StepContext, aabPath: string, outPath: string): Promise<string> {
    const bundletool = await resolveBundletool({
      env: process.env,
      which: (tool) => this.options.processes.which(tool),
      exists: existsSync,
      download: (url, dest) => this.download(url, dest, ctx),
      toolsDir: this.toolsDir,
    }).catch((err) => {
      if (err instanceof BuildError) throw err;
      throw new BuildError('bundletool is not available', {
        hint: 'Install it with `brew install bundletool`, or set BUNDLETOOL_PATH.',
        cause: err,
      });
    });

    const workDir = await mkdtemp(join(tmpdir(), 'caricamento-apks-'));
    const apksPath = join(workDir, 'bundle.apks');
    try {
      const signingArgs = await this.signingArgs();
      if (signingArgs.length === 0) {
        ctx.log('stdout', 'No android.signing configured — the universal APK will be debug-signed by bundletool');
      }
      const args = [
        ...bundletool.prefixArgs,
        'build-apks',
        `--bundle=${aabPath}`,
        `--output=${apksPath}`,
        '--mode=universal',
        ...signingArgs,
      ];
      ctx.log('stdout', `${bundletool.executable} ${args.map(redactSigningArg).join(' ')}`);
      const result = await this.options.processes.run(bundletool.executable, args, {
        cwd: ctx.cwd,
        onLine: (stream, line) => ctx.log(stream, line),
      });
      if (result.exitCode !== 0) {
        throw new BuildError(`bundletool build-apks failed with exit code ${result.exitCode}`, {
          hint: 'Run the same command manually to see the full error output.',
          context: { stderr: result.stderr.trim().slice(0, 500) },
        });
      }

      const unzip = await this.options.processes.which('unzip');
      if (!unzip) {
        throw new BuildError('unzip not found — cannot extract universal.apk from the .apks archive', {
          hint: 'Install unzip (preinstalled on macOS).',
        });
      }
      const extract = await this.options.processes.run(unzip, ['-o', apksPath, 'universal.apk', '-d', workDir], { cwd: ctx.cwd });
      if (extract.exitCode !== 0) {
        throw new BuildError('Failed to extract universal.apk from the .apks archive', {
          context: { stderr: extract.stderr.trim().slice(0, 500) },
        });
      }
      await rename(join(workDir, 'universal.apk'), outPath);
      ctx.log('stdout', `Universal APK: ${outPath}`);
      return outPath;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async signingArgs(): Promise<string[]> {
    const signing = this.options.config.android?.signing;
    if (!signing) return [];
    const [storeFile, storePassword, keyPassword] = await Promise.all([
      this.options.secrets.resolve(signing.keystoreRef),
      this.options.secrets.resolve(signing.keystorePasswordRef),
      this.options.secrets.resolve(signing.keyPasswordRef),
    ]);
    return [
      `--ks=${storeFile}`,
      `--ks-key-alias=${signing.keyAlias}`,
      `--ks-pass=pass:${storePassword}`,
      `--key-pass=pass:${keyPassword}`,
    ];
  }

  private async download(url: string, dest: string, ctx: StepContext): Promise<void> {
    const jarUrl = await this.resolveDownloadUrl(url);
    ctx.log('stdout', `Downloading bundletool from ${jarUrl}`);
    const response = await this.fetchImpl(jarUrl);
    if (!response.ok || !response.body) {
      throw new BuildError(`Failed to download bundletool: HTTP ${response.status}`, {
        hint: 'Check the network, or install manually with `brew install bundletool`.',
      });
    }
    await mkdir(this.toolsDir, { recursive: true });
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
  }

  private async resolveDownloadUrl(url: string): Promise<string> {
    if (url !== BUNDLETOOL_LATEST_API) return url;
    const response = await this.fetchImpl(BUNDLETOOL_LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      throw new BuildError(`Failed to look up the latest bundletool release: HTTP ${response.status}`, {
        hint: 'Check the network, or install manually with `brew install bundletool`.',
      });
    }
    const release = (await response.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
    const asset = release.assets?.find((a) => a.name.startsWith('bundletool-all-') && a.name.endsWith('.jar'));
    if (!asset) {
      throw new BuildError('Latest bundletool release has no bundletool-all jar asset', {
        hint: 'Install manually with `brew install bundletool`.',
      });
    }
    return asset.browser_download_url;
  }
}

function redactSigningArg(arg: string): string {
  if (arg.startsWith('--ks-pass=')) return '--ks-pass=***';
  if (arg.startsWith('--key-pass=')) return '--key-pass=***';
  return arg;
}
