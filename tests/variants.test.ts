import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/core/config/defineConfig.js';
import { configSchema, type CaricamentoConfig } from '../src/core/config/schema.js';
import { resolveVariantConfig } from '../src/core/config/variants.js';
import { ValidationError } from '../src/core/errors.js';

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the function to throw');
}

const baseConfig = (): CaricamentoConfig =>
  configSchema.parse({
    android: { module: 'app', buildType: 'release' },
    version: { strategy: 'timestamp' },
    targets: {
      firebase: { appIdAndroid: '1:123:android:base', groups: ['qa'] },
    },
    variants: {
      qa: {
        applicationId: 'com.example.app.qa',
        targets: { firebase: { appIdAndroid: '1:123:android:qa', groups: ['qa'] } },
      },
      prod: {
        applicationId: 'com.example.app',
        targets: {
          play: { serviceAccountRef: 'secret:play/service-account', packageName: 'com.example.app' },
        },
        version: { strategy: 'auto-increment' },
      },
      flavored: { flavor: 'dev' },
    },
  });

describe('resolveVariantConfig (SPEC §5.4)', () => {
  it('returns the base config unchanged without a variant name', () => {
    const base = baseConfig();
    expect(resolveVariantConfig(base)).toBe(base);
  });

  it('throws a ValidationError listing available variants for an unknown name', () => {
    const base = baseConfig();
    const error = catchError(() => resolveVariantConfig(base, 'staging'));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).hint).toContain('qa, prod, flavored');
  });

  it('throws a ValidationError when no variants are defined at all', () => {
    const base = configSchema.parse({});
    const error = catchError(() => resolveVariantConfig(base, 'qa'));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).hint).toContain('No variants are defined');
  });

  it('injects the variant applicationId into android', () => {
    const merged = resolveVariantConfig(baseConfig(), 'qa');
    expect(merged.android?.applicationId).toBe('com.example.app.qa');
    expect(merged.android?.module).toBe('app');
  });

  it('replaces targets entirely (no deep merge with base)', () => {
    const merged = resolveVariantConfig(baseConfig(), 'prod');
    expect(merged.targets.firebase).toBeUndefined();
    expect(merged.targets.play?.packageName).toBe('com.example.app');
    expect(merged.targets.play?.track).toBe('internal');
  });

  it('replaces the version block when the variant defines it', () => {
    const merged = resolveVariantConfig(baseConfig(), 'prod');
    expect(merged.version.strategy).toBe('auto-increment');
  });

  it('keeps base version and targets when the variant does not override them', () => {
    const merged = resolveVariantConfig(baseConfig(), 'flavored');
    expect(merged.android?.flavor).toBe('dev');
    expect(merged.version.strategy).toBe('timestamp');
    expect(merged.targets.firebase?.appIdAndroid).toBe('1:123:android:base');
  });

  it('does not mutate the base config', () => {
    const base = baseConfig();
    resolveVariantConfig(base, 'prod');
    expect(base.android?.applicationId).toBeUndefined();
    expect(base.targets.play).toBeUndefined();
    expect(base.version.strategy).toBe('timestamp');
  });
});

describe('variants schema validation', () => {
  it('parses a config with variants', () => {
    const config = defineConfig({
      variants: {
        qa: { applicationId: 'com.example.app.qa' },
        prod: { flavor: 'prod', version: { strategy: 'manual', buildNumber: 5 } },
      },
    });
    expect(config.variants?.qa?.applicationId).toBe('com.example.app.qa');
    expect(config.variants?.prod?.version?.strategy).toBe('manual');
  });

  it('rejects invalid variant target configs', () => {
    expect(() =>
      defineConfig({
        variants: {
          prod: { targets: { play: { packageName: 'com.example.app' } } },
        },
      }),
    ).toThrow();
  });

  it('rejects an empty applicationId', () => {
    expect(() => defineConfig({ variants: { qa: { applicationId: '' } } })).toThrow();
  });
});
