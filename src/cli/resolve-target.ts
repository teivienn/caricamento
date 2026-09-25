import { existsSync } from 'node:fs';
import { ConfigError } from '../core/errors.js';
import type { JsonProjectRegistry } from '../infra/system/registry.js';

export interface ResolvedTarget {
  /** Directory the run executes in (the project root). */
  cwd: string;
  /** Explicit config path; undefined lets the loader fall back to <cwd>/caricamento.config.ts. */
  configPath?: string;
  projectName?: string;
}

/**
 * Maps CLI input to a run target. Without a project name the current
 * directory is used (classic in-project mode). With a name, the project is
 * resolved through the registry and its config comes from
 * --config -> registry entry -> ~/.caricamento/projects/<name>.config.ts
 * -> <project>/caricamento.config.ts.
 */
export async function resolveTarget(
  projectName: string | undefined,
  explicitConfig: string | undefined,
  registry: JsonProjectRegistry,
): Promise<ResolvedTarget> {
  if (!projectName) {
    return { cwd: process.cwd(), configPath: explicitConfig };
  }

  const entry = await registry.get(projectName);
  if (!entry) {
    const names = (await registry.list()).map((p) => p.name);
    throw new ConfigError(`Project "${projectName}" is not registered`, {
      hint: names.length
        ? `Registered projects: ${names.join(', ')}. Add one with \`caricamento projects add <name> --path <dir>\`.`
        : 'Register one with `caricamento projects add <name> --path <dir>`.',
    });
  }
  if (!existsSync(entry.path)) {
    throw new ConfigError(`Registered path for "${projectName}" no longer exists: ${entry.path}`, {
      hint: 'Re-register with `caricamento projects remove` + `projects add`, or restore the directory.',
    });
  }

  const registryConfig = registry.configPathFor(projectName);
  const configPath = explicitConfig ?? entry.config ?? (existsSync(registryConfig) ? registryConfig : undefined);
  return { cwd: entry.path, configPath, projectName };
}
