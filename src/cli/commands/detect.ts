import { Command } from 'commander';
import { createBareContainer, createContainer } from '../../container.js';
import { ConfigError } from '../../core/errors.js';
import type { GlobalOptions } from '../options.js';

export function detectCommand(globals: () => GlobalOptions): Command {
  return new Command('detect')
    .description('Show the detected ProjectDescriptor for the current directory')
    .action(async () => {
      const opts = globals();
      let container;
      try {
        container = await createContainer({ cwd: process.cwd(), configPath: opts.config });
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        container = createBareContainer({ cwd: process.cwd() });
      }
      const descriptor = container.detect.execute({ cwd: process.cwd(), config: container.config });
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
