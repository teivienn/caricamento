import { Command } from 'commander';
import { createBareContainer, createContainer } from '../../container.js';
import { ConfigError } from '../../core/errors.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import type { DoctorCheck } from '../../application/doctor.js';
import type { GlobalOptions } from '../options.js';
import { resolveTarget } from '../resolve-target.js';

export function doctorCommand(globals: () => GlobalOptions): Command {
  return new Command('doctor')
    .description('Check the build environment and credentials')
    .argument('[project]', 'registered project name; default: current directory')
    .action(async (project?: string) => {
      const opts = globals();
      const target = await resolveTarget(project, opts.config, new JsonProjectRegistry());
      let container;
      let config;
      try {
        container = await createContainer({ cwd: target.cwd, configPath: target.configPath, envFiles: target.envFiles });
        config = container.config;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        container = createBareContainer({ cwd: target.cwd, envFiles: target.envFiles });
        config = undefined;
      }
      const checks: DoctorCheck[] = await container.doctor.execute({ cwd: target.cwd, config });

      if (opts.json) {
        process.stdout.write(JSON.stringify({ checks }) + '\n');
      } else {
        for (const check of checks) {
          const icon = check.status === 'ok' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
          process.stdout.write(`[${icon}] ${check.name}${check.message ? ` — ${check.message}` : ''}\n`);
          if (check.hint && check.status !== 'ok') process.stdout.write(`       hint: ${check.hint}\n`);
        }
      }
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });
}
