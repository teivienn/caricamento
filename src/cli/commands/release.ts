import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';
import { exitCodeOf, parseIntOption } from './build.js';

export function releaseCommand(globals: () => GlobalOptions): Command {
  return new Command('release')
    .description('Build, sign and publish a release in one run')
    .argument('[project]', 'registered project name (see `caricamento projects list`); default: current directory')
    .option('--platform <platform>', 'target platform', 'android')
    .option('--targets <targets>', 'comma-separated distribution targets (default: all configured)')
    .option('--artifact-type <type>', 'apk or aab', 'apk')
    .option('--build <number>', 'versionCode override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName override')
    .option('--release-notes <text>', 'release notes override')
    .action(
      async (
        project: string | undefined,
        opts: {
          platform: string;
          targets?: string;
          artifactType: string;
          build?: number;
          version?: string;
          releaseNotes?: string;
        },
      ) => {
        const global = globals();
        if (opts.platform !== 'android') {
          throw new ValidationError(`Platform "${opts.platform}" is not supported yet`, {
            hint: 'This milestone supports Android only. iOS lands in Phase 3.',
          });
        }
        const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
        const container = await createContainer({ cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles });

        const targets = opts.targets
          ? opts.targets.split(',').map((t) => t.trim())
          : Object.keys(container.config.targets);
        if (targets.length === 0) {
          throw new ValidationError('No distribution targets given and none configured', {
            hint: 'Pass --targets firebase or configure targets in caricamento.config.ts.',
          });
        }

        const summary = await renderEvents(
          container.release.run({
            cwd: target.cwd,
            targets,
            artifactType: opts.artifactType === 'aab' ? 'aab' : 'apk',
            buildNumber: opts.build,
            versionName: opts.version,
            releaseNotes: opts.releaseNotes,
            dryRun: global.dryRun,
          }),
          { json: global.json, verbose: global.verbose },
        );
        if (summary.status === 'failed') process.exitCode = summary.error ? exitCodeOf(summary.error) : 1;
      },
    );
}
