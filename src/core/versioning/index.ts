import { ValidationError } from '../errors.js';
import type { CaricamentoConfig, Platform } from '../config/schema.js';

export interface ResolvedVersion {
  /** Android versionCode / iOS CFBundleVersion. */
  versionCode: number;
  /** Android versionName / iOS CFBundleShortVersionString. */
  versionName?: string;
}

export type VersionSource = 'play' | 'appstore' | 'firebase';

export interface VersionStrategyContext {
  config: CaricamentoConfig;
  /** CLI overrides (--build / --version). */
  buildNumberOverride?: number;
  versionNameOverride?: string;
  now?: Date;
  /**
   * Highest published build number, resolved beforehand via a
   * VersionCodeProvider (Play / App Store Connect / Firebase). Required for
   * `auto-increment`; null means the app has no published builds yet.
   */
  maxVersionCode?: number | null;
}

/**
 * Build number strategies (SPEC §8). Pure and synchronous: for
 * `auto-increment` the caller resolves the current maximum via a
 * VersionCodeProvider and passes it in as `maxVersionCode`.
 *
 * `timestamp` differs per platform: Android uses Unix seconds, iOS uses
 * YYYYMMDDHHMM (UTC) — a readable CFBundleVersion that still increases.
 */
export function resolveVersion(ctx: VersionStrategyContext, platform: Platform): ResolvedVersion {
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
      return { versionCode: platform === 'ios' ? iosTimestamp(now) : Math.floor(now.getTime() / 1000), versionName };
    }
    case 'auto-increment': {
      if (ctx.maxVersionCode === undefined) {
        throw new ValidationError(
          platform === 'ios'
            ? 'version.strategy "auto-increment" requires the App Store Connect API'
            : 'version.strategy "auto-increment" requires the Google Play API',
          {
            hint:
              platform === 'ios'
                ? 'Configure targets.appstore (apiKeyRef + keyId + issuerId + bundleId) so the current max CFBundleVersion can be queried.'
                : 'Configure targets.play (serviceAccountRef + packageName) so the current max versionCode can be queried.',
          },
        );
      }
      return { versionCode: (ctx.maxVersionCode ?? 0) + 1, versionName };
    }
  }
}

export function resolveAndroidVersion(ctx: VersionStrategyContext): ResolvedVersion {
  return resolveVersion(ctx, 'android');
}

function iosTimestamp(now: Date): number {
  const pad = (n: number) => String(n).padStart(2, '0');
  return Number(
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
  );
}

/**
 * Which API backs `auto-increment` (SPEC §8). An explicit version.source
 * always wins — even across platforms, e.g. to share one numbering between
 * Android and iOS. Otherwise the priority is play > appstore > firebase,
 * considering only configured targets native to the platform: play for
 * Android, appstore for iOS, firebase for both. Returns undefined when
 * nothing applicable is configured.
 */
export function resolveVersionSource(config: CaricamentoConfig, platform: Platform): VersionSource | undefined {
  if (config.version.source) return config.version.source;
  if (platform === 'android' && config.targets.play) return 'play';
  if (platform === 'ios' && config.targets.appstore) return 'appstore';
  if (config.targets.firebase) return 'firebase';
  return undefined;
}
