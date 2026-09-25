import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { exitCodeOf, parseIntOption } from './build.js';

export function releaseCommand(globals: () => GlobalOptions): Command {
  return new Command('release')
    .description('Build, sign and publish a release in one run')
    .requiredOption('--platform <platform>', 'target platform (android)')
    .requiredOption('--targets <targets>', 'comma-separated distribution targets (firebase)')
    .option('--artifact-type <type>', 'apk or aab', 'apk')
    .option('--build <number>', 'versionCode override (manual strategy)', parseIntOption)
    .option('--version <name>', 'versionName override')
    .option('--release-notes <text>', 'release notes override')
    .action(
      async (opts: {
        platform: string;
        targets: string;
        artifactType: string;
        build?: number;
        version?: string;
        releaseNotes?: string;
      }) => {
        const global = globals();
        if (opts.platform !== 'android') {
          throw new ValidationError(`Platform "${opts.platform}" is not supported yet`, {
            hint: 'This milestone supports Android only. iOS lands in Phase 3.',
          });
        }
        const targets = opts.targets.split(',').map((t) => t.trim());
        const container = await createContainer({ cwd: process.cwd(), configPath: global.config });
        const summary = await renderEvents(
          container.release.run({
            cwd: process.cwd(),
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
