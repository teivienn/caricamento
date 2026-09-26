import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { normalizeTarget, parsePlatform } from '../platform.js';
import { resolveTarget } from '../resolve-target.js';
import { parseIntOption } from './build.js';
import { runWithVariants } from './run-variants.js';

export function releaseCommand(globals: () => GlobalOptions): Command {
  return new Command('release')
    .description('Build, sign and publish a release in one run')
    .argument('[project]', 'registered project name (see `caricamento projects list`); default: current directory')
    .option('--platform <platform>', 'target platform: android | ios', 'android')
    .option('--targets <targets>', 'comma-separated distribution targets (default: all configured for the platform)')
    .option('--variant <name>', 'build variant from the config (`all` runs every variant sequentially)')
    .option('--artifact-type <type>', 'apk or aab (Android only)', 'apk')
    .option('--build <number>', 'versionCode / CFBundleVersion override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName / CFBundleShortVersionString override')
    .option('--release-notes <text>', 'release notes / TestFlight "What to Test" override')
    .action(
      async (
        project: string | undefined,
        opts: {
          platform: string;
          targets?: string;
          variant?: string;
          artifactType: string;
          build?: number;
          version?: string;
          releaseNotes?: string;
        },
      ) => {
        const global = globals();
        const platform = parsePlatform(opts.platform);
        const target = await resolveTarget(project, global.config, new JsonProjectRegistry());

        await runWithVariants(
          { cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles, platform },
          opts.variant,
          async (container) => {
            const targets = opts.targets ? opts.targets.split(',').map(normalizeTarget) : container.targets;
            if (targets.length === 0) {
              throw new ValidationError(`No distribution targets given and none configured for ${platform}`, {
                hint:
                  platform === 'ios'
                    ? 'Configure targets.appstore (or targets.firebase with appIdIos) in caricamento.config.ts.'
                    : 'Pass --targets firebase or configure targets in caricamento.config.ts.',
              });
            }
            return renderEvents(
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
          },
        );
      },
    );
}
