import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';

export function buildCommand(globals: () => GlobalOptions): Command {
  return new Command('build')
    .description('Build a signed Android artifact')
    .requiredOption('--platform <platform>', 'target platform (android)')
    .option('--artifact-type <type>', 'apk or aab', 'apk')
    .option('--build <number>', 'versionCode override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName override')
    .action(async (opts: { platform: string; artifactType: string; build?: number; version?: string }) => {
      const global = globals();
      if (opts.platform !== 'android') {
        throw new ValidationError(`Platform "${opts.platform}" is not supported yet`, {
          hint: 'This milestone supports Android only. iOS lands in Phase 3.',
        });
      }
      const container = await createContainer({ cwd: process.cwd(), configPath: global.config });
      const summary = await renderEvents(
        container.build.run({
          cwd: process.cwd(),
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
