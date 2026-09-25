import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createJiti } from 'jiti';
import type { ConfigLoader } from '../../core/ports/index.js';
import { ConfigError } from '../../core/errors.js';
import { configSchema, type CaricamentoConfig } from '../../core/config/schema.js';

export const CONFIG_FILE_NAME = 'caricamento.config.ts';

/**
 * Loads `caricamento.config.ts` from a target project via jiti.
 * Lives in infra (not core/config) to keep core free of npm deps beyond zod
 * (SPEC §2 principle) — core defines the ConfigLoader port instead.
 */
export class JitiConfigLoader implements ConfigLoader {
  async load(configPath: string): Promise<unknown> {
    const jiti = createJiti(import.meta.url);
    const mod: unknown = await jiti.import(configPath);
    if (mod && typeof mod === 'object' && 'default' in mod) {
      return (mod as { default: unknown }).default;
    }
    return mod;
  }

  async loadValidated(configPath: string): Promise<CaricamentoConfig> {
    const raw = await this.load(configPath);
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`Invalid configuration in ${configPath}: ${parsed.error.message}`, {
        hint: 'Fix the config or regenerate a template with `caricamento init`.',
      });
    }
    return parsed.data;
  }
}

export function resolveConfigPath(projectDir: string, explicitPath?: string): string {
  if (explicitPath) {
    const path = isAbsolute(explicitPath) ? explicitPath : join(process.cwd(), explicitPath);
    if (!existsSync(path)) {
      throw new ConfigError(`Config file not found: ${path}`, {
        hint: 'Run `caricamento init` in the target project to generate one.',
      });
    }
    return path;
  }
  const candidate = join(projectDir, CONFIG_FILE_NAME);
  if (!existsSync(candidate)) {
    throw new ConfigError(`No ${CONFIG_FILE_NAME} found in ${projectDir}`, {
      hint: 'Run `caricamento init` in the target project to generate one.',
    });
  }
  return candidate;
}
