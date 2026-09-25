import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/core/config/schema.js';
import { ValidationError } from '../src/core/errors.js';
import { resolveAndroidVersion } from '../src/core/versioning/index.js';

const baseConfig = (version: object) => configSchema.parse({ version });

describe('Android version strategies (SPEC §8)', () => {
  it('manual: uses buildNumber from config', () => {
    const resolved = resolveAndroidVersion({ config: baseConfig({ strategy: 'manual', buildNumber: 7, name: '1.2.0' }) });
    expect(resolved).toEqual({ versionCode: 7, versionName: '1.2.0' });
  });

  it('manual: CLI --build overrides config', () => {
    const resolved = resolveAndroidVersion({
      config: baseConfig({ strategy: 'manual', buildNumber: 7 }),
      buildNumberOverride: 9,
    });
    expect(resolved.versionCode).toBe(9);
  });

  it('manual: throws a typed error when no build number is available', () => {
    expect(() => resolveAndroidVersion({ config: baseConfig({ strategy: 'manual' }) })).toThrow(ValidationError);
  });

  it('timestamp: uses unix time', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const resolved = resolveAndroidVersion({ config: baseConfig({ strategy: 'timestamp' }), now });
    expect(resolved.versionCode).toBe(Math.floor(now.getTime() / 1000));
  });

  it('auto-increment: stubbed with a clear TODO until the Play API lands', () => {
    expect(() => resolveAndroidVersion({ config: baseConfig({ strategy: 'auto-increment' }) })).toThrow(
      /not available yet/,
    );
  });
});
