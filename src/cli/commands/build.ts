import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { parsePlatform } from '../platform.js';
import { resolveTarget } from '../resolve-target.js';
import { runWithVariants } from './run-variants.js';

export function buildCommand(globals: () => GlobalOptions): Command {
  return new Command('build')
    .description('Build a signed artifact (Android APK/AAB or iOS IPA)')
    .argument('[project]', 'registered project name; default: current directory')
    .option('--platform <platform>', 'target platform: android | ios', 'android')
    .option('--artifact-type <type>', 'apk or aab (Android only; iOS always builds an ipa)', 'apk')
    .option('--variant <name>', 'build variant from the config (`all` runs every variant sequentially)')
    .option('--build <number>', 'versionCode / CFBundleVersion override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName / CFBundleShortVersionString override')
    .action(async (project: string | undefined, opts: { platform: string; artifactType: string; variant?: string; build?: number; version?: string }) => {
      const global = globals();
      const platform = parsePlatform(opts.platform);
      const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
      await runWithVariants(
        { cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles, platform },
        opts.variant,
        (container) =>
          renderEvents(
            container.build.run({
              cwd: target.cwd,
              artifactType: opts.artifactType === 'aab' ? 'aab' : 'apk',
              buildNumber: opts.build,
              versionName: opts.version,
              dryRun: global.dryRun,
            }),
            { json: global.json, verbose: global.verbose },
          ),
      );
    });
}

export function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new ValidationError(`Expected an integer, got "${value}"`);
  return parsed;
}

export function exitCodeOf(error: { exitCode?: unknown }): number {
  return typeof error.exitCode === 'number' ? error.exitCode : 1;
}
