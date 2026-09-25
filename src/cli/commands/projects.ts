import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { ProjectDetector } from '../../core/project/detector.js';
import { JsonProjectRegistry } from '../../infra/system/registry.js';
import { configTemplate } from '../config-template.js';
import type { GlobalOptions } from '../options.js';

export function projectsCommand(globals: () => GlobalOptions): Command {
  const cmd = new Command('projects').description('Manage the project registry (~/.caricamento/registry.json)');

  cmd
    .command('add <name>')
    .description('Register a project so it can be built by name from any directory')
    .requiredOption('--path <dir>', 'path to the project root')
    .option('--config <path>', 'explicit config path (default: ~/.caricamento/projects/<name>.config.ts)')
    .action(async (name: string, opts: { path: string; config?: string }) => {
      const registry = new JsonProjectRegistry();
      await registry.add({ name, path: opts.path, config: opts.config, addedAt: new Date().toISOString() });

      const detected = new ProjectDetector().detect(opts.path);
      process.stdout.write(`Registered "${name}" -> ${opts.path}${detected ? ` (detected: ${detected.type})` : ''}\n`);

      const hasConfig =
        opts.config !== undefined ||
        existsSync(registry.configPathFor(name)) ||
        existsSync(`${opts.path}/caricamento.config.ts`);
      if (!hasConfig) {
        const target = registry.configPathFor(name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, configTemplate({ typed: false }), 'utf8');
        process.stdout.write(`Created starter config ${target} — edit it before the first release.\n`);
      }
    });

  cmd
    .command('list')
    .description('List registered projects')
    .action(async () => {
      const projects = await new JsonProjectRegistry().list();
      if (globals().json) {
        process.stdout.write(JSON.stringify({ projects }) + '\n');
        return;
      }
      if (projects.length === 0) {
        process.stdout.write('No projects registered. Use `caricamento projects add <name> --path <dir>`.\n');
        return;
      }
      for (const p of projects) {
        process.stdout.write(`${p.name}\t${p.path}${p.config ? `\tconfig: ${p.config}` : ''}\n`);
      }
    });

  cmd
    .command('remove <name>')
    .description('Remove a project from the registry (the project itself is untouched)')
    .action(async (name: string) => {
      await new JsonProjectRegistry().remove(name);
      process.stdout.write(`Removed "${name}" from the registry.\n`);
    });

  return cmd;
}
