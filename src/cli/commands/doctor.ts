import { Command } from 'commander';
import { createBareContainer, createContainer } from '../../container.js';
import { ConfigError } from '../../core/errors.js';
import type { DoctorCheck } from '../../application/doctor.js';
import type { GlobalOptions } from '../options.js';

export function doctorCommand(globals: () => GlobalOptions): Command {
  return new Command('doctor')
    .description('Check the build environment and credentials')
    .action(async () => {
      const opts = globals();
      let container;
      let config;
      try {
        container = await createContainer({ cwd: process.cwd(), configPath: opts.config });
        config = container.config;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        container = createBareContainer({ cwd: process.cwd() });
        config = undefined;
      }
      const checks: DoctorCheck[] = await container.doctor.execute({ cwd: process.cwd(), config });

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
