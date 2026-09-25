import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';
import { exitCodeOf } from './build.js';

export function uploadCommand(globals: () => GlobalOptions): Command {
  return new Command('upload')
    .description('Upload an artifact to a distribution target')
    .argument('[project]', 'registered project name; default: current directory')
    .requiredOption('--target <target>', 'distribution target (firebase, play)')
    .option('--artifact <path>', 'path to a prebuilt artifact (default: newest build output)')
    .option('--artifact-type <type>', 'apk or aab (default: aab for play, apk otherwise)')
    .option('--release-notes <text>', 'release notes override')
    .action(async (project: string | undefined, opts: { target: string; artifact?: string; artifactType?: string; releaseNotes?: string }) => {
      const global = globals();
      if (opts.target !== 'firebase' && opts.target !== 'play') {
        throw new ValidationError(`Target "${opts.target}" is not supported yet`, {
          hint: 'Supported targets: firebase, play.',
        });
      }
      const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
      const container = await createContainer({ cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles });
      const artifactType = opts.artifactType ?? (opts.target === 'play' ? 'aab' : 'apk');
      const summary = await renderEvents(
        container.upload.run({
          cwd: target.cwd,
          target: opts.target,
          artifactPath: opts.artifact,
          artifactType: artifactType === 'aab' ? 'aab' : 'apk',
          releaseNotes: opts.releaseNotes,
          dryRun: global.dryRun,
        }),
        { json: global.json, verbose: global.verbose },
      );
      if (summary.status === 'failed') process.exitCode = summary.error ? exitCodeOf(summary.error) : 1;
    });
}
