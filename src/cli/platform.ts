import type { Platform } from '../core/config/schema.js';
import { ValidationError } from '../core/errors.js';

export function parsePlatform(value: string): Platform {
  if (value === 'android' || value === 'ios') return value;
  throw new ValidationError(`Unknown platform "${value}"`, { hint: 'Use --platform android or --platform ios.' });
}

/** `asc` is accepted as an alias of the `appstore` target (SPEC §10 wording). */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim();
  return trimmed === 'asc' ? 'appstore' : trimmed;
}
