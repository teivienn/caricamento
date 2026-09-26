import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';
import { runWithVariants } from './run-variants.js';

export function uploadCommand(globals: () => GlobalOptions): Command {
  return new Command('upload')
    .description('Upload an artifact to a distribution target')
    .argument('[project]', 'registered project name; default: current directory')
    .requiredOption('--target <target>', 'distribution target (firebase, play, playsharing)')
    .option('--artifact <path>', 'path to a prebuilt artifact (default: newest build output)')
    .option('--artifact-type <type>', 'apk or aab (default: aab for play, apk otherwise)')
    .option('--variant <name>', 'build variant from the config (`all` runs every variant sequentially)')
    .option('--release-notes <text>', 'release notes override')
    .action(async (project: string | undefined, opts: { target: string; artifact?: string; artifactType?: string; variant?: string; releaseNotes?: string }) => {
      const global = globals();
      if (opts.target !== 'firebase' && opts.target !== 'play' && opts.target !== 'playsharing') {
        throw new ValidationError(`Target "${opts.target}" is not supported yet`, {
          hint: 'Supported targets: firebase, play, playsharing.',
        });
      }
      const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
      const artifactType = opts.artifactType ?? (opts.target === 'play' ? 'aab' : 'apk');
      await runWithVariants(
        { cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles },
        opts.variant,
        (container) =>
          renderEvents(
            container.upload.run({
              cwd: target.cwd,
              target: opts.target,
              artifactPath: opts.artifact,
              artifactType: artifactType === 'aab' ? 'aab' : 'apk',
              releaseNotes: opts.releaseNotes,
              dryRun: global.dryRun,
            }),
            { json: global.json, verbose: global.verbose },
          ),
      );
    });
}
