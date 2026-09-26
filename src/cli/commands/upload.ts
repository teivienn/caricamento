import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { normalizeTarget, parsePlatform } from '../platform.js';
import { resolveTarget } from '../resolve-target.js';
import { runWithVariants } from './run-variants.js';

const SUPPORTED_TARGETS = ['firebase', 'play', 'playsharing', 'appstore'];

export function uploadCommand(globals: () => GlobalOptions): Command {
  return new Command('upload')
    .description('Upload an artifact to a distribution target')
    .argument('[project]', 'registered project name; default: current directory')
    .requiredOption('--target <target>', 'distribution target (firebase, play, playsharing, appstore|asc)')
    .option('--platform <platform>', 'android | ios (default: ios for appstore or an .ipa artifact, else android)')
    .option('--artifact <path>', 'path to a prebuilt artifact (default: newest build output)')
    .option('--artifact-type <type>', 'apk or aab (default: aab for play, apk otherwise; ipa on iOS)')
    .option('--variant <name>', 'build variant from the config (`all` runs every variant sequentially)')
    .option('--release-notes <text>', 'release notes / TestFlight "What to Test" override')
    .action(
      async (
        project: string | undefined,
        opts: { target: string; platform?: string; artifact?: string; artifactType?: string; variant?: string; releaseNotes?: string },
      ) => {
        const global = globals();
        const uploadTarget = normalizeTarget(opts.target);
        if (!SUPPORTED_TARGETS.includes(uploadTarget)) {
          throw new ValidationError(`Target "${opts.target}" is not supported`, {
            hint: `Supported targets: ${SUPPORTED_TARGETS.join(', ')}.`,
          });
        }
        const platform = opts.platform
          ? parsePlatform(opts.platform)
          : uploadTarget === 'appstore' || opts.artifact?.endsWith('.ipa')
            ? 'ios'
            : 'android';
        const artifactType =
          platform === 'ios' ? 'ipa' : (opts.artifactType ?? (uploadTarget === 'play' ? 'aab' : 'apk')) === 'aab' ? 'aab' : 'apk';
        const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
        await runWithVariants(
          { cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles, platform },
          opts.variant,
          (container) =>
            renderEvents(
              container.upload.run({
                cwd: target.cwd,
                target: uploadTarget,
                artifactPath: opts.artifact,
                artifactType,
                releaseNotes: opts.releaseNotes,
                dryRun: global.dryRun,
              }),
              { json: global.json, verbose: global.verbose },
            ),
        );
      },
    );
}
