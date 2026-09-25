#!/usr/bin/env node
import { Command } from 'commander';
import { CaricamentoError } from '../core/errors.js';
import { buildCommand } from './commands/build.js';
import { detectCommand } from './commands/detect.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { releaseCommand } from './commands/release.js';
import { runsCommand, statusCommand } from './commands/status.js';
import { uploadCommand } from './commands/upload.js';
import type { GlobalOptions } from './options.js';

const program = new Command();

program
  .name('caricamento')
  .description('Build, sign and distribute mobile app releases (MVP: Android + Firebase App Distribution)')
  .version('0.1.0')
  .option('--config <path>', 'path to caricamento.config.ts')
  .option('--verbose', 'stream step logs', false)
  .option('--json', 'machine-readable output', false)
  .option('--dry-run', 'print the plan without executing', false);

const globals = (): GlobalOptions => {
  const opts = program.opts<{ config?: string; verbose: boolean; json: boolean; dryRun: boolean }>();
  return { config: opts.config, verbose: opts.verbose, json: opts.json, dryRun: opts.dryRun };
};

program.addCommand(initCommand());
program.addCommand(doctorCommand(globals));
program.addCommand(detectCommand(globals));
program.addCommand(buildCommand(globals));
program.addCommand(uploadCommand(globals));
program.addCommand(releaseCommand(globals));
program.addCommand(statusCommand(globals));
program.addCommand(runsCommand(globals));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CaricamentoError) {
    if (globals().json) {
      process.stderr.write(JSON.stringify({ error: err.toJSON() }) + '\n');
    } else {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
    }
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
