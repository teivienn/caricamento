import { describe, expect, it } from 'vitest';
import type { IosExportMethod } from '../src/core/config/schema.js';
import { SigningError } from '../src/core/errors.js';
import { buildExportOptionsPlist, exportMethodName, renderExportOptions } from '../src/infra/builders/export-options.js';
import { buildPlist, parsePlist } from '../src/infra/system/plist.js';

describe('exportOptions.plist generation (SPEC §5.2)', () => {
  const methods: Array<[IosExportMethod, string]> = [
    ['app-store', 'app-store-connect'],
    ['ad-hoc', 'release-testing'],
    ['development', 'debugging'],
    ['enterprise', 'enterprise'],
  ];

  it.each(methods)('maps method %s to the Xcode 15.3+ name %s (automatic)', (method, xcodeName) => {
    const options = renderExportOptions({ method, signingStyle: 'automatic', teamId: 'ABCDE12345' });
    expect(options.method).toBe(xcodeName);
    expect(options.signingStyle).toBe('automatic');
    expect(options.teamID).toBe('ABCDE12345');
    expect(options.destination).toBe('export');
    expect(options.provisioningProfiles).toBeUndefined();
    expect(exportMethodName(method)).toBe(xcodeName);
  });

  it.each(methods)('lists provisioning profiles explicitly for manual signing (%s)', (method, xcodeName) => {
    const options = renderExportOptions({
      method,
      signingStyle: 'manual',
      teamId: 'ABCDE12345',
      provisioningProfiles: { 'com.example.app': 'uuid-app', 'com.example.app.widget': 'uuid-widget' },
      signingCertificate: 'A'.repeat(40),
    });
    expect(options.method).toBe(xcodeName);
    expect(options.signingStyle).toBe('manual');
    expect(options.provisioningProfiles).toEqual({ 'com.example.app': 'uuid-app', 'com.example.app.widget': 'uuid-widget' });
    expect(options.signingCertificate).toBe('A'.repeat(40));
  });

  it('pins the build number for App Store exports only', () => {
    expect(renderExportOptions({ method: 'app-store', signingStyle: 'automatic' }).manageAppVersionAndBuildNumber).toBe(false);
    expect(renderExportOptions({ method: 'ad-hoc', signingStyle: 'automatic' }).manageAppVersionAndBuildNumber).toBeUndefined();
  });

  it('omits teamID when no team is configured', () => {
    expect(renderExportOptions({ method: 'development', signingStyle: 'automatic' })).not.toHaveProperty('teamID');
  });

  it('rejects manual signing without profiles', () => {
    expect(() => renderExportOptions({ method: 'app-store', signingStyle: 'manual' })).toThrow(SigningError);
  });

  it('serializes a valid XML plist that round-trips', () => {
    const xml = buildExportOptionsPlist({
      method: 'app-store',
      signingStyle: 'manual',
      teamId: 'ABCDE12345',
      provisioningProfiles: { 'com.example.app': 'Example & <Distribution>' },
    });
    expect(xml).toContain('<!DOCTYPE plist');
    expect(xml).toContain('\t<key>method</key>\n\t<string>app-store-connect</string>');
    expect(xml).toContain('\t<key>manageAppVersionAndBuildNumber</key>\n\t<false/>');
    expect(xml).toContain('Example &amp; &lt;Distribution&gt;');
    expect(parsePlist(xml)).toEqual({
      method: 'app-store-connect',
      signingStyle: 'manual',
      destination: 'export',
      teamID: 'ABCDE12345',
      manageAppVersionAndBuildNumber: false,
      provisioningProfiles: { 'com.example.app': 'Example & <Distribution>' },
    });
  });
});

describe('plist parser', () => {
  it('parses dates, integers, arrays, data and nested dicts', () => {
    const xml = buildPlist({
      Name: 'Profile',
      Count: 3,
      Enabled: true,
      Teams: ['ABCDE12345'],
      ExpirationDate: new Date('2027-01-02T03:04:05Z'),
      Blob: Buffer.from('hello'),
      Entitlements: { 'application-identifier': 'ABCDE12345.com.example.app', empty: {} },
    });
    const parsed = parsePlist(xml) as Record<string, unknown>;
    expect(parsed.Name).toBe('Profile');
    expect(parsed.Count).toBe(3);
    expect(parsed.Enabled).toBe(true);
    expect(parsed.Teams).toEqual(['ABCDE12345']);
    expect((parsed.ExpirationDate as Date).toISOString()).toBe('2027-01-02T03:04:05.000Z');
    expect((parsed.Blob as Buffer).toString()).toBe('hello');
    expect(parsed.Entitlements).toEqual({ 'application-identifier': 'ABCDE12345.com.example.app', empty: {} });
  });

  it('rejects non-plist input', () => {
    expect(() => parsePlist('<html></html>')).toThrow(/not an XML property list/);
  });
});
