import { ValidationError } from '../errors.js';
import type { CaricamentoConfig } from '../config/schema.js';

export interface ResolvedVersion {
  versionCode: number;
  versionName?: string;
}

export interface VersionStrategyContext {
  config: CaricamentoConfig;
  /** CLI overrides (--build / --version). */
  buildNumberOverride?: number;
  versionNameOverride?: string;
  now?: Date;
  /**
   * Highest published versionCode, resolved beforehand via a
   * VersionCodeProvider (Play API). Required for `auto-increment`;
   * null means the app has no published releases yet.
   */
  maxVersionCode?: number | null;
}

/**
 * Android versionCode strategies (SPEC §8). Pure and synchronous: for
 * `auto-increment` the caller resolves the current maximum via the Play API
 * (VersionCodeProvider) and passes it in as `maxVersionCode`.
 */
export function resolveAndroidVersion(ctx: VersionStrategyContext): ResolvedVersion {
  const strategy = ctx.config.version.strategy;
  const versionName = ctx.versionNameOverride ?? ctx.config.version.name;

  switch (strategy) {
    case 'manual': {
      const code = ctx.buildNumberOverride ?? ctx.config.version.buildNumber;
      if (code === undefined) {
        throw new ValidationError('version.strategy is "manual" but no build number was provided', {
          hint: 'Set version.buildNumber in caricamento.config.ts or pass --build <n>.',
        });
      }
      return { versionCode: code, versionName };
    }
    case 'timestamp': {
      const now = ctx.now ?? new Date();
      return { versionCode: Math.floor(now.getTime() / 1000), versionName };
    }
    case 'auto-increment': {
      if (ctx.maxVersionCode === undefined) {
        throw new ValidationError('version.strategy "auto-increment" requires the Google Play API', {
          hint: 'Configure targets.play (serviceAccountRef + packageName) so the current max versionCode can be queried.',
        });
      }
      return { versionCode: (ctx.maxVersionCode ?? 0) + 1, versionName };
    }
  }
}
