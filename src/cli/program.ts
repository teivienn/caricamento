import { Command, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { apkCommand } from './commands/apk.js';
import { buildCommand } from './commands/build.js';
import { detectCommand } from './commands/detect.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { projectsCommand } from './commands/projects.js';
import { releaseCommand } from './commands/release.js';
import { secretsCommand } from './commands/secrets.js';
import { runsCommand, statusCommand } from './commands/status.js';
import { uploadCommand } from './commands/upload.js';
import type { GlobalOptions } from './options.js';

const GLOBAL_OPTIONS = [
  { flags: '--config <path>', description: 'path to caricamento.config.ts' },
  { flags: '--verbose', description: 'stream step logs' },
  { flags: '--json', description: 'machine-readable output' },
  { flags: '--dry-run', description: 'print the plan without executing' },
] as const;

export interface CliProgram {
  program: Command;
  globals: () => GlobalOptions;
}

export function createProgram(): CliProgram {
  const program = new Command();

  // Positional options must be enabled before .version(): options before the
  // subcommand belong to the program, options after it to the subcommand. This
  // is what lets `build --version <name>` coexist with the program's `--version`.
  program
    .name('caricamento')
    .description('Build, sign and distribute mobile app releases (MVP: Android + Firebase App Distribution)')
    .enablePositionalOptions()
    .version(pkg.version);

  for (const { flags, description } of GLOBAL_OPTIONS) {
    const option = new Option(flags, description);
    if (option.isBoolean()) option.default(false);
    program.addOption(option);
  }

  const globals = (): GlobalOptions => {
    const opts = program.opts<{ config?: string; verbose: boolean; json: boolean; dryRun: boolean }>();
    return { config: opts.config, verbose: opts.verbose, json: opts.json, dryRun: opts.dryRun };
  };

  program.addCommand(initCommand());
  program.addCommand(projectsCommand(globals));
  program.addCommand(secretsCommand(globals));
  program.addCommand(doctorCommand(globals));
  program.addCommand(detectCommand(globals));
  program.addCommand(buildCommand(globals));
  program.addCommand(uploadCommand(globals));
  program.addCommand(releaseCommand(globals));
  program.addCommand(apkCommand(globals));
  program.addCommand(statusCommand(globals));
  program.addCommand(runsCommand(globals));

  for (const cmd of program.commands) forwardGlobalOptions(program, cmd);

  return { program, globals };
}

/**
 * With positional options the program no longer sees flags placed after the
 * subcommand, so `build --dry-run` would be rejected. Register the global
 * options on every leaf command too and copy their values onto the program.
 * A leaf that defines its own flag with the same name (e.g. `projects add
 * --config`) keeps its own meaning.
 */
function forwardGlobalOptions(program: Command, cmd: Command): void {
  if (cmd.commands.length > 0) {
    for (const sub of cmd.commands) forwardGlobalOptions(program, sub);
    return;
  }
  for (const { flags, description } of GLOBAL_OPTIONS) {
    const option = new Option(flags, description);
    if (cmd.options.some((existing) => existing.long === option.long)) continue;
    cmd.addOption(option);
    cmd.on(`option:${option.name()}`, (value?: string) => {
      program.setOptionValueWithSource(option.attributeName(), value ?? true, 'cli');
    });
  }
}
