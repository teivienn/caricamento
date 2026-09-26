import { Command } from 'commander';
import { createContainer } from '../../container.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { renderEvents } from '../render/renderer.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';
import { exitCodeOf } from './build.js';

export function apkCommand(globals: () => GlobalOptions): Command {
  return new Command('apk')
    .description('Convert an AAB to a universal APK for local install (via bundletool)')
    .argument('[project]', 'registered project name; default: current directory')
    .option('--artifact <path>', 'path to an AAB (default: newest AAB in the build outputs)')
    .option('--out <path>', 'output APK path (default: alongside the AAB as <name>-universal.apk)')
    .action(async (project: string | undefined, opts: { artifact?: string; out?: string }) => {
      const global = globals();
      const target = await resolveTarget(project, global.config, new JsonProjectRegistry());
      const container = await createContainer({ cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles });
      const summary = await renderEvents(
        container.apk.run({
          cwd: target.cwd,
          artifactPath: opts.artifact,
          outPath: opts.out,
          dryRun: global.dryRun,
        }),
        { json: global.json, verbose: global.verbose },
      );
      if (summary.status === 'failed') process.exitCode = summary.error ? exitCodeOf(summary.error) : 1;
    });
}
