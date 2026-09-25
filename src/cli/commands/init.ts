import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { configTemplate } from '../config-template.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Generate a caricamento.config.ts template in the current directory')
    .option('--force', 'overwrite an existing config file', false)
    .action(async (opts: { force: boolean }) => {
      const target = join(process.cwd(), 'caricamento.config.ts');
      if (existsSync(target) && !opts.force) {
        throw new ValidationError('caricamento.config.ts already exists', {
          hint: 'Use --force to overwrite it. Or keep the project clean: `caricamento projects add <name> --path .` stores the config in ~/.caricamento instead.',
        });
      }
      await writeFile(target, configTemplate({ typed: true }), 'utf8');
      process.stdout.write(`Created ${target}\n`);
    });
}
