import type { IosExportMethod } from '../../core/config/schema.js';
import { SigningError } from '../../core/errors.js';
import { buildPlist, type PlistValue } from '../system/plist.js';

export interface ExportOptionsInput {
  method: IosExportMethod;
  signingStyle: 'automatic' | 'manual';
  teamId?: string;
  /** manual: bundle identifier -> provisioning profile UUID (or name). */
  provisioningProfiles?: Record<string, string>;
  /** manual: certificate name, SHA-1 or automatic selector ("Apple Distribution"). */
  signingCertificate?: string;
}

/**
 * Config keeps the classic method names; Xcode 15.3+ renamed them and marks
 * the old ones deprecated (`xcodebuild -help`: "app-store (deprecated: use
 * app-store-connect), ad-hoc (deprecated: use release-testing), and
 * development (deprecated: use debugging)").
 */
const METHOD_NAMES: Record<IosExportMethod, string> = {
  'app-store': 'app-store-connect',
  'ad-hoc': 'release-testing',
  development: 'debugging',
  enterprise: 'enterprise',
};

export function exportMethodName(method: IosExportMethod): string {
  return METHOD_NAMES[method];
}

export function renderExportOptions(input: ExportOptionsInput): Record<string, PlistValue> {
  const options: Record<string, PlistValue> = {
    method: exportMethodName(input.method),
    signingStyle: input.signingStyle,
    destination: 'export',
  };
  if (input.teamId) options.teamID = input.teamId;
  if (input.method === 'app-store') {
    // Xcode otherwise rewrites CFBundleVersion during an App Store export when
    // it can reach ASC — the resolved build number must stay authoritative.
    options.manageAppVersionAndBuildNumber = false;
  }
  if (input.signingStyle === 'manual') {
    const profiles = input.provisioningProfiles ?? {};
    if (Object.keys(profiles).length === 0) {
      throw new SigningError('Manual export requires at least one provisioning profile', {
        hint: 'List the .mobileprovision files in ios.signing.profileRefs.',
      });
    }
    options.provisioningProfiles = profiles;
    if (input.signingCertificate) options.signingCertificate = input.signingCertificate;
  }
  return options;
}

export function buildExportOptionsPlist(input: ExportOptionsInput): string {
  return buildPlist(renderExportOptions(input));
}
