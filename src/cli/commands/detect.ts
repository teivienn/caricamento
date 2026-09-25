import { Command } from 'commander';
import { createBareContainer, createContainer } from '../../container.js';
import { ConfigError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';

export function detectCommand(globals: () => GlobalOptions): Command {
  return new Command('detect')
    .description('Show the detected ProjectDescriptor for a project')
    .argument('[project]', 'registered project name; default: current directory')
    .action(async (project?: string) => {
      const opts = globals();
      const target = await resolveTarget(project, opts.config, new JsonProjectRegistry());
      let container;
      try {
        container = await createContainer({ cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles });
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        container = createBareContainer({ cwd: target.cwd, envFiles: target.envFiles });
      }
      const descriptor = container.detect.execute({ cwd: target.cwd, config: container.config });
      if (opts.json) {
        process.stdout.write(JSON.stringify(descriptor, null, 2) + '\n');
      } else {
        process.stdout.write(`type:      ${descriptor.type}\n`);
        process.stdout.write(`platforms: ${descriptor.platforms.join(', ')}\n`);
        process.stdout.write(`root:      ${descriptor.paths.root}\n`);
        if (descriptor.paths.ios) process.stdout.write(`ios:       ${descriptor.paths.ios}\n`);
        if (descriptor.paths.android) process.stdout.write(`android:   ${descriptor.paths.android}\n`);
      }
    });
}
