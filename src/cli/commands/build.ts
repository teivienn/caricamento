import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';

export function buildCommand(globals: () => GlobalOptions): Command {
  return new Command('build')
    .description('Build a signed Android artifact')
    .argument('[project]', 'registered project name; default: current directory')
    .option('--platform <platform>', 'target platform', 'android')
    .option('--artifact-type <type>', 'apk or aab', 'apk')
    .option('--build <number>', 'versionCode override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName override')
    .action(async (project: string | undefined, opts: { platform: string; artifactType: string; build?: number; version?: string }) => {
      const global = globals();
      if (opts.platform !== 'android') {
        throw new ValidationError(`Platform "${opts.platform}" is not supported yet`, {
          hint: 'This milestone supports Android only. iOS lands in Phase 3.',
        });
      }
      const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
      const container = await createContainer({ cwd: target.cwd, configPath: target.configPath });
      const summary = await renderEvents(
        container.build.run({
          cwd: target.cwd,
          artifactType: opts.artifactType === 'aab' ? 'aab' : 'apk',
          buildNumber: opts.build,
          versionName: opts.version,
          dryRun: global.dryRun,
        }),
        { json: global.json, verbose: global.verbose },
      );
      if (summary.status === 'failed') process.exitCode = summary.error ? exitCodeOf(summary.error) : 1;
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
