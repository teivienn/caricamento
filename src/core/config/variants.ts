import { ValidationError } from '../errors.js';
import type { CaricamentoConfig } from './schema.js';

/**
 * Applies a named build variant to the base config (SPEC §5.4).
 *
 * Merge rules (deliberately shallow and predictable):
 * - `android.flavor` / `android.applicationId` are overridden when the
 *   variant sets them, other android fields are inherited;
 * - `bundleId` overrides `ios.signing.bundleId` (other ios fields inherited);
 * - `targets` is REPLACED entirely when the variant defines it (no deep
 *   merge — a variant publishes exactly where it says);
 * - `version` is REPLACED entirely when the variant defines it.
 *
 * Without a variantName the base config is returned unchanged; an unknown
 * name is a ValidationError listing the available variants.
 */
export function resolveVariantConfig(base: CaricamentoConfig, variantName?: string): CaricamentoConfig {
  if (variantName === undefined) return base;

  const variants = base.variants ?? {};
  const variant = variants[variantName];
  if (!variant) {
    const available = Object.keys(variants);
    throw new ValidationError(`Unknown variant "${variantName}"`, {
      hint: available.length > 0 ? `Available variants: ${available.join(', ')}.` : 'No variants are defined in the config.',
    });
  }

  const merged: CaricamentoConfig = { ...base };

  if (variant.flavor !== undefined || variant.applicationId !== undefined) {
    merged.android = {
      module: 'app',
      buildType: 'release',
      ...base.android,
      flavor: variant.flavor ?? base.android?.flavor,
      applicationId: variant.applicationId ?? base.android?.applicationId,
    };
  }
  // Without a base ios block there is nothing to build for iOS, so a variant
  // bundleId is irrelevant (it cannot create the block: scheme is required).
  if (variant.bundleId !== undefined && base.ios) {
    merged.ios = { ...base.ios, signing: { ...base.ios.signing, bundleId: variant.bundleId } };
  }
  if (variant.targets !== undefined) merged.targets = variant.targets;
  if (variant.version !== undefined) merged.version = variant.version;

  return merged;
}
