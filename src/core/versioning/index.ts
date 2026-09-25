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
}

/**
 * Android versionCode strategies (SPEC §8).
 * `auto-increment` needs the Play API (max versionCode + 1) which is out of
 * scope for this milestone — the strategy is wired behind the interface and
 * throws a typed error with a clear TODO until Phase 4 lands.
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
      // TODO(phase-4): query max(versionCode) via Play Developer API edits.tracks.get and add 1.
      throw new ValidationError('version.strategy "auto-increment" is not available yet', {
        hint: 'It requires the Google Play API (Phase 4). Use "manual" or "timestamp" for now.',
      });
    }
  }
}
