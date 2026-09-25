import { configSchema, type CaricamentoConfig } from './schema.js';

export function defineConfig(config: unknown): CaricamentoConfig {
  return configSchema.parse(config);
}
