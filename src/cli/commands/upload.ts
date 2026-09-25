import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { exitCodeOf } from './build.js';

export function uploadCommand(globals: () => GlobalOptions): Command {
  return new Command('upload')
    .description('Upload an artifact to a distribution target')
    .requiredOption('--target <target>', 'distribution target (firebase)')
    .option('--artifact <path>', 'path to a prebuilt artifact (default: newest build output)')
    .option('--artifact-type <type>', 'apk or aab', 'apk')
    .option('--release-notes <text>', 'release notes override')
    .action(async (opts: { target: string; artifact?: string; artifactType: string; releaseNotes?: string }) => {
      const global = globals();
      if (opts.target !== 'firebase') {
        throw new ValidationError(`Target "${opts.target}" is not supported yet`, {
          hint: 'This milestone supports Firebase App Distribution only.',
        });
      }
      const container = await createContainer({ cwd: process.cwd(), configPath: global.config });
      const summary = await renderEvents(
        container.upload.run({
          cwd: process.cwd(),
          target: opts.target,
          artifactPath: opts.artifact,
          artifactType: opts.artifactType === 'aab' ? 'aab' : 'apk',
          releaseNotes: opts.releaseNotes,
          dryRun: global.dryRun,
        }),
        { json: global.json, verbose: global.verbose },
      );
      if (summary.status === 'failed') process.exitCode = summary.error ? exitCodeOf(summary.error) : 1;
    });
}
