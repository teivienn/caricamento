import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Artifact } from '../../core/artifact/types.js';
import type { CaricamentoConfig, IosConfig } from '../../core/config/schema.js';
import { BuildError, SigningError, ValidationError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { Builder, BuildRequest, ProcessRunner } from '../../core/ports/index.js';
import type { IosSigningPreparer, IosSigningSession } from '../signing/ios.js';
import { buildExportOptionsPlist } from './export-options.js';

export interface XcodeBuildPlan {
  outputDir: string;
  archivePath: string;
  exportPath: string;
  exportOptionsPath: string;
  archiveArgs: string[];
  /** Undefined for unsigned builds: the .app is packaged without exportArchive. */
  exportArgs?: string[];
}

/**
 * Orchestrates `xcodebuild archive` + `xcodebuild -exportArchive` (SPEC §5.2).
 *
 * Zero-touch: version, bundle ID and signing are passed as build settings
 * (MARKETING_VERSION, CURRENT_PROJECT_VERSION, PRODUCT_BUNDLE_IDENTIFIER,
 * CODE_SIGN_*) on the command line; exportOptions.plist is generated. The
 * project's Info.plist must reference $(MARKETING_VERSION) /
 * $(CURRENT_PROJECT_VERSION) — the default for Xcode 13+ templates — which is
 * verified on the archived app after every build.
 */
export class XcodeBuilder implements Builder {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly config: CaricamentoConfig,
    private readonly signing: IosSigningPreparer,
  ) {}

  private ios(): IosConfig {
    const ios = this.config.ios;
    if (!ios) {
      throw new ValidationError('No ios block in the config', {
        hint: 'Add ios: { project | workspace, scheme } to caricamento.config.ts.',
      });
    }
    return ios;
  }

  plan(ctx: Pick<StepContext, 'cwd'>, request: BuildRequest, session: Omit<IosSigningSession, 'cleanup'>): XcodeBuildPlan {
    const ios = this.ios();
    const projectRoot = request.projectRoot ?? ctx.cwd;
    const outputDir = join(projectRoot, 'build', 'caricamento');
    const archivePath = join(outputDir, `${ios.scheme}.xcarchive`);
    const exportPath = join(outputDir, 'ipa');
    const exportOptionsPath = join(outputDir, 'exportOptions.plist');

    const settings: Record<string, string> = {};
    if (request.versionName !== undefined) settings.MARKETING_VERSION = request.versionName;
    if (request.versionCode !== undefined) settings.CURRENT_PROJECT_VERSION = String(request.versionCode);
    if (ios.signing.bundleId) settings.PRODUCT_BUNDLE_IDENTIFIER = ios.signing.bundleId;
    Object.assign(settings, session.buildSettings);

    const archiveArgs = [
      'archive',
      ...this.containerArgs(ios, projectRoot, ctx.cwd),
      '-scheme',
      ios.scheme,
      '-configuration',
      ios.configuration,
      '-destination',
      ios.destination,
      '-archivePath',
      archivePath,
      ...session.xcodebuildArgs,
      ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    ];
    const exportArgs = session.exportOptions
      ? [
          '-exportArchive',
          '-archivePath',
          archivePath,
          '-exportPath',
          exportPath,
          '-exportOptionsPlist',
          exportOptionsPath,
          ...session.xcodebuildArgs,
        ]
      : undefined;
    return { outputDir, archivePath, exportPath, exportOptionsPath, archiveArgs, exportArgs };
  }

  /**
   * Paths are resolved against the native project root (<root>/ios for
   * RN/Flutter) first, then against the project root, so both
   * 'App.xcworkspace' and 'ios/App.xcworkspace' work.
   */
  private containerArgs(ios: IosConfig, projectRoot: string, cwd: string): string[] {
    const [flag, path] = ios.workspace ? ['-workspace', ios.workspace] : ['-project', ios.project!];
    if (isAbsolute(path)) return [flag, path];
    const candidates = [join(projectRoot, path), join(cwd, path)];
    return [flag, candidates.find((c) => existsSync(c)) ?? candidates[0]!];
  }

  async build(ctx: StepContext, request: BuildRequest): Promise<Artifact[]> {
    if (ctx.dryRun) {
      const preview = this.signing.describe();
      const plan = this.plan(ctx, request, preview);
      ctx.log('stdout', `[dry-run] xcodebuild ${plan.archiveArgs.join(' ')}`);
      if (plan.exportArgs && preview.exportOptions) {
        ctx.log('stdout', `[dry-run] exportOptions.plist:\n${buildExportOptionsPlist(preview.exportOptions)}`);
        ctx.log('stdout', `[dry-run] xcodebuild ${plan.exportArgs.join(' ')}`);
      } else {
        ctx.log('stdout', '[dry-run] unsigned build: would package Payload/*.app into an .ipa (no exportArchive)');
      }
      return [];
    }

    const session = await this.signing.prepare(ctx);
    let plan: XcodeBuildPlan;
    try {
      plan = this.plan(ctx, request, session);
      await rm(plan.archivePath, { recursive: true, force: true });
      await rm(plan.exportPath, { recursive: true, force: true });
      await mkdir(plan.outputDir, { recursive: true });

      ctx.progress(5, 'xcodebuild archive');
      await this.xcodebuild(ctx, plan.archiveArgs, 'archive');
      const app = await this.archivedApp(plan.archivePath);
      await this.checkArchivedVersion(ctx, app, request);

      ctx.progress(70, session.exportOptions ? 'xcodebuild -exportArchive' : 'Packaging unsigned .ipa');
      if (plan.exportArgs && session.exportOptions) {
        await writeFile(plan.exportOptionsPath, buildExportOptionsPlist(session.exportOptions));
        await this.xcodebuild(ctx, plan.exportArgs, 'export');
      } else {
        await this.packageUnsigned(app, plan);
      }
    } finally {
      await session.cleanup();
    }
    return this.collectArtifacts(plan);
  }

  private async xcodebuild(ctx: StepContext, args: string[], phase: 'archive' | 'export'): Promise<void> {
    ctx.log('stdout', `xcodebuild ${args.join(' ')}`);
    const errors: string[] = [];
    const result = await this.processes.run('xcodebuild', args, {
      onLine: (stream, line) => {
        if (/\berror:/.test(line)) errors.push(line.trim());
        ctx.log(stream, line);
      },
    });
    if (result.exitCode === 0) return;

    const first = errors[0];
    const context = { phase, errors: errors.slice(0, 10) };
    if (errors.some((e) => SIGNING_ERROR.test(e))) {
      throw new SigningError(`xcodebuild ${phase} failed: ${first}`, {
        hint:
          'Signing problem. automatic: check ios.signing.teamId and the ASC API key (Admin/App Manager role). ' +
          'manual: check that the profiles match the bundle ID and certificate. Local unsigned build: ios.signing.mode "none".',
        context,
      });
    }
    throw new BuildError(`xcodebuild ${phase} failed with exit code ${result.exitCode}${first ? `: ${first}` : ''}`, {
      hint: 'Run the logged xcodebuild command manually (or with --verbose) to see the full output.',
      context,
    });
  }

  private async archivedApp(archivePath: string): Promise<string> {
    const appsDir = join(archivePath, 'Products', 'Applications');
    const apps = (await readdir(appsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.app'));
    if (!apps[0]) {
      throw new BuildError(`Archive contains no application: ${appsDir}`, {
        hint: 'Check that ios.scheme builds an iOS app target (not a framework) and that SKIP_INSTALL is NO for it.',
      });
    }
    return join(appsDir, apps[0]);
  }

  /**
   * Guards against silently ignored version injection: projects with
   * hard-coded CFBundleVersion in Info.plist would otherwise produce
   * duplicate builds in App Store Connect.
   */
  private async checkArchivedVersion(ctx: StepContext, app: string, request: BuildRequest): Promise<void> {
    const plist = join(app, 'Info.plist');
    const expected: Array<[string, string | undefined]> = [
      ['CFBundleVersion', request.versionCode !== undefined ? String(request.versionCode) : undefined],
      ['CFBundleShortVersionString', request.versionName],
    ];
    for (const [key, want] of expected) {
      if (want === undefined) continue;
      const result = await this.processes.run('plutil', ['-extract', key, 'raw', '-o', '-', plist]);
      const actual = result.stdout.trim();
      if (result.exitCode !== 0 || actual === '') {
        ctx.log('stderr', `Could not read ${key} from the archived Info.plist — skipping version check`);
        continue;
      }
      if (actual !== want) {
        throw new BuildError(`Archived app has ${key}=${actual}, expected ${want}`, {
          hint: `Info.plist must use $(${key === 'CFBundleVersion' ? 'CURRENT_PROJECT_VERSION' : 'MARKETING_VERSION'}) instead of a hard-coded value.`,
        });
      }
    }
  }

  private async packageUnsigned(app: string, plan: XcodeBuildPlan): Promise<void> {
    const staging = join(plan.outputDir, 'unsigned');
    await rm(staging, { recursive: true, force: true });
    const appName = app.split('/').pop()!;
    await mkdir(join(staging, 'Payload'), { recursive: true });
    await mkdir(plan.exportPath, { recursive: true });
    await this.run('ditto', [app, join(staging, 'Payload', appName)]);
    // --norsrc/--noextattr: no __MACOSX/ resource-fork entries in the .ipa.
    await this.run('ditto', [
      '-c',
      '-k',
      '--norsrc',
      '--noextattr',
      '--keepParent',
      join(staging, 'Payload'),
      join(plan.exportPath, `${appName.replace(/\.app$/, '')}.ipa`),
    ]);
    await rm(staging, { recursive: true, force: true });
  }

  private async run(command: string, args: string[]): Promise<void> {
    const result = await this.processes.run(command, args);
    if (result.exitCode !== 0) {
      throw new BuildError(`${command} ${args.join(' ')} failed`, { context: { stderr: result.stderr.slice(0, 500) } });
    }
  }

  private async collectArtifacts(plan: XcodeBuildPlan): Promise<Artifact[]> {
    const files = await readdir(plan.exportPath).catch(() => [] as string[]);
    const ipa = files.find((f) => f.endsWith('.ipa'));
    if (!ipa) {
      throw new BuildError(`No .ipa found in ${plan.exportPath}`, {
        hint: 'Check the export log; the export method must be allowed by the signing identity and profiles.',
      });
    }
    const ipaPath = join(plan.exportPath, ipa);
    const artifacts: Artifact[] = [{ kind: 'ipa', platform: 'ios', path: ipaPath, sizeBytes: (await stat(ipaPath)).size }];

    const dsymDir = join(plan.archivePath, 'dSYMs');
    const dsyms = await readdir(dsymDir).catch(() => [] as string[]);
    if (dsyms.some((f) => f.endsWith('.dSYM'))) artifacts.push({ kind: 'dsym', platform: 'ios', path: dsymDir });
    return artifacts;
  }
}

const SIGNING_ERROR =
  /(provisioning profile|signing certificate|Signing for .* requires|No profiles for|code ?sign|No Account for Team|development team)/i;
