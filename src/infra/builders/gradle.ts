import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../../core/artifact/types.js';
import type { CaricamentoConfig } from '../../core/config/schema.js';
import { BuildError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { Builder, BuildRequest, ProcessRunner, SecretResolver } from '../../core/ports/index.js';

export interface GradleBuildPlan {
  task: string;
  args: string[];
  outputDir: string;
  artifactExtension: 'aab' | 'apk';
  mappingDir: string;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Orchestrates `./gradlew` for Android (SPEC §5.1). Signing is injected via
 * -P project properties — the target project's build.gradle must read them
 * (the `caricamento init` template and fixtures show how).
 */
export class GradleBuilder implements Builder {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly secrets: SecretResolver,
    private readonly config: CaricamentoConfig,
  ) {}

  plan(request: BuildRequest): GradleBuildPlan {
    const android = this.config.android;
    const module = android?.module ?? 'app';
    const flavor = android?.flavor;
    const buildType = android?.buildType ?? 'release';
    const variant = `${flavor ? capitalize(flavor) : ''}${capitalize(buildType)}`;
    const artifactType = request.artifactType ?? 'apk';
    const taskVerb = artifactType === 'aab' ? 'bundle' : 'assemble';

    return {
      task: `:${module}:${taskVerb}${variant}`,
      args: [],
      outputDir: join(
        module,
        'build',
        'outputs',
        artifactType === 'aab' ? 'bundle' : 'apk',
        flavor ? `${flavor}${capitalize(buildType)}` : buildType,
      ),
      artifactExtension: artifactType,
      mappingDir: join(module, 'build', 'outputs', 'mapping', flavor ? `${flavor}${capitalize(buildType)}` : buildType),
    };
  }

  async buildSigningArgs(): Promise<string[]> {
    const signing = this.config.android?.signing;
    if (!signing) return [];
    const [storeFile, storePassword, keyPassword] = await Promise.all([
      this.secrets.resolve(signing.keystoreRef),
      this.secrets.resolve(signing.keystorePasswordRef),
      this.secrets.resolve(signing.keyPasswordRef),
    ]);
    return [
      `-PCARICAMENTO_STORE_FILE=${storeFile}`,
      `-PCARICAMENTO_STORE_PASSWORD=${storePassword}`,
      `-PCARICAMENTO_KEY_ALIAS=${signing.keyAlias}`,
      `-PCARICAMENTO_KEY_PASSWORD=${keyPassword}`,
    ];
  }

  async build(ctx: StepContext, request: BuildRequest): Promise<Artifact[]> {
    const plan = this.plan(request);
    const signingArgs = ctx.dryRun ? redactedSigningArgs(this.config) : await this.buildSigningArgs();
    const args = [plan.task, ...signingArgs];

    if (request.versionCode !== undefined) args.push(`-PCARICAMENTO_VERSION_CODE=${request.versionCode}`);
    if (request.versionName !== undefined) args.push(`-PCARICAMENTO_VERSION_NAME=${request.versionName}`);

    if (ctx.dryRun) {
      ctx.log('stdout', `[dry-run] ./gradlew ${args.map(redactSigningArg).join(' ')}`);
      return [];
    }

    ctx.log('stdout', `./gradlew ${args.map(redactSigningArg).join(' ')}`);
    const result = await this.processes.run('./gradlew', args, {
      cwd: ctx.cwd,
      onLine: (stream, line) => ctx.log(stream, line),
    });
    if (result.exitCode !== 0) {
      throw new BuildError(`Gradle task ${plan.task} failed with exit code ${result.exitCode}`, {
        hint: 'Run the same gradlew command manually to see the full error output.',
        context: { task: plan.task },
      });
    }

    return this.collectArtifacts(ctx.cwd, plan);
  }

  private async collectArtifacts(root: string, plan: GradleBuildPlan): Promise<Artifact[]> {
    const dir = join(root, plan.outputDir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      throw new BuildError(`Gradle reported success but output directory is missing: ${dir}`, {
        hint: 'Check that the module/flavor/buildType in caricamento.config.ts match the project.',
      });
    }
    const artifactFile = files.find((f) => f.endsWith(`.${plan.artifactExtension}`));
    if (!artifactFile) {
      throw new BuildError(`No .${plan.artifactExtension} found in ${dir}`, {
        hint: 'Check that the module/flavor/buildType in caricamento.config.ts match the project.',
      });
    }
    const artifactPath = join(dir, artifactFile);
    const info = await stat(artifactPath);
    const artifacts: Artifact[] = [
      { kind: plan.artifactExtension, platform: 'android', path: artifactPath, sizeBytes: info.size },
    ];

    try {
      const mappingFiles = await readdir(join(root, plan.mappingDir));
      if (mappingFiles.includes('mapping.txt')) {
        artifacts.push({ kind: 'mapping', platform: 'android', path: join(root, plan.mappingDir, 'mapping.txt') });
      }
    } catch {
      // mapping.txt only exists when minification is enabled
    }
    return artifacts;
  }
}

function redactedSigningArgs(config: CaricamentoConfig): string[] {
  const signing = config.android?.signing;
  if (!signing) return [];
  return [
    `-PCARICAMENTO_STORE_FILE=<${signing.keystoreRef}>`,
    '-PCARICAMENTO_STORE_PASSWORD=***',
    `-PCARICAMENTO_KEY_ALIAS=${signing.keyAlias}`,
    '-PCARICAMENTO_KEY_PASSWORD=***',
  ];
}

function redactSigningArg(arg: string): string {
  if (arg.startsWith('-PCARICAMENTO_STORE_PASSWORD=')) return '-PCARICAMENTO_STORE_PASSWORD=***';
  if (arg.startsWith('-PCARICAMENTO_KEY_PASSWORD=')) return '-PCARICAMENTO_KEY_PASSWORD=***';
  return arg;
}
