import { ValidationError } from '../../../core/errors.js';
import type { FirebaseTargetConfig } from '../../../core/config/schema.js';

/**
 * "projects/<number>/apps/<appId>" for the configured platform.
 * Shared by FirebasePublisher and FirebaseVersionCodeProvider.
 */
export function firebaseAppResource(config: FirebaseTargetConfig, platform: 'android' | 'ios'): string {
  const appId = platform === 'android' ? config.appIdAndroid : config.appIdIos;
  if (!appId) {
    throw new ValidationError(`targets.firebase.appId${platform === 'android' ? 'Android' : 'Ios'} is not configured`, {
      hint: 'Copy the app ID from the Firebase console into caricamento.config.ts.',
    });
  }
  const projectNumber = appId.split(':')[1];
  if (!projectNumber) {
    throw new ValidationError(`Malformed Firebase app ID: ${appId}`, {
      hint: 'Expected format "1:<projectNumber>:android:<hash>".',
    });
  }
  return `projects/${projectNumber}/apps/${appId}`;
}
