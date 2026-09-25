import { describe, expect, it } from 'vitest';
import { configSchema, type CaricamentoConfig } from '../src/core/config/schema.js';
import { SigningError } from '../src/core/errors.js';
import type { StepContext } from '../src/core/pipeline/types.js';
import type { ProcessResult, ProcessRunner } from '../src/core/ports/index.js';
import { AndroidSigningProvider } from '../src/infra/signing/android.js';

// Real `jarsigner -verify -certs` output (JDK 17) for a jar signed with the
// test keystore: exit code is 0 and there are no certificate digests.
const JARSIGNER_VERIFIED = 'jar verified.\n';
// jarsigner also exits 0 for unsigned jars — this line is the only signal.
const JARSIGNER_UNSIGNED = '\njar is unsigned.\n';

// Real `keytool -printcert -jarfile` output (JDK 17), trimmed to the relevant part.
const KEYTOOL_CERT = [
  'Signer #1:',
  '',
  'Certificate #1:',
  'Owner: CN=Caricamento Test, OU=Test, O=Caricamento, L=Test, ST=Test, C=US',
  'Issuer: CN=Caricamento Test, OU=Test, O=Caricamento, L=Test, ST=Test, C=US',
  'Certificate fingerprints:',
  '\t SHA1: 64:5C:CA:56:13:7D:7B:4F:0B:40:EA:A9:E5:58:E6:F1:43:52:61:82',
  '\t SHA256: F4:40:2B:55:68:51:F4:77:C3:20:3B:BC:FD:E6:8C:68:57:1B:27:DB:81:25:C8:08:02:F7:20:18:35:64:28:9D',
  'Signature algorithm name: SHA256withRSA',
  '',
].join('\n');

const TEST_CERT_SHA256 = 'f4402b556851f477c3203bbcfd' + 'e68c68571b27db8125c80802f720183564289d';

const APKSIGNER_OUTPUT = `Signer #1 certificate DN: CN=Caricamento Test\nSigner #1 certificate SHA-256 digest: ${TEST_CERT_SHA256}\n`;

interface FakeProcess {
  tool: string;
  result: ProcessResult;
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly fakes: FakeProcess[]) {}

  async run(command: string, args: string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    const fake = this.fakes.find((f) => command.endsWith(f.tool));
    if (!fake) throw new Error(`unexpected command: ${command}`);
    return fake.result;
  }

  async which(tool: string): Promise<string | null> {
    return this.fakes.some((f) => f.tool === tool) ? `/usr/bin/${tool}` : null;
  }
}

const ctx: StepContext = {
  runId: 'test-run',
  cwd: '/tmp',
  dryRun: false,
  log: () => {},
  progress: () => {},
  data: new Map(),
};

function makeConfig(expectedCertificateSha256?: string): CaricamentoConfig {
  return configSchema.parse({
    android: {
      signing: {
        keystoreRef: 'secret:android/keystore-path',
        keystorePasswordRef: 'secret:android/keystore-password',
        keyAlias: 'upload',
        keyPasswordRef: 'secret:android/key-password',
        expectedCertificateSha256,
      },
    },
  });
}

describe('AndroidSigningProvider — AAB (SPEC §6.2)', () => {
  const aab = { kind: 'aab' as const, platform: 'android' as const, path: '/tmp/app-release.aab' };

  it('verifies via jarsigner and parses the SHA-256 from keytool output', async () => {
    const processes = new FakeProcessRunner([
      { tool: 'jarsigner', result: { exitCode: 0, stdout: JARSIGNER_VERIFIED, stderr: '' } },
      { tool: 'keytool', result: { exitCode: 0, stdout: KEYTOOL_CERT, stderr: '' } },
    ]);
    const provider = new AndroidSigningProvider(processes, makeConfig());

    const result = await provider.verify(ctx, aab);

    expect(result).toEqual({ verified: true, sha256: TEST_CERT_SHA256 });
    expect(processes.calls[0]).toEqual({ command: '/usr/bin/jarsigner', args: ['-verify', '-certs', aab.path] });
    expect(processes.calls[1]).toEqual({ command: '/usr/bin/keytool', args: ['-printcert', '-jarfile', aab.path] });
  });

  it('accepts the matching expectedCertificateSha256 (colon-separated in config)', async () => {
    const processes = new FakeProcessRunner([
      { tool: 'jarsigner', result: { exitCode: 0, stdout: JARSIGNER_VERIFIED, stderr: '' } },
      { tool: 'keytool', result: { exitCode: 0, stdout: KEYTOOL_CERT, stderr: '' } },
    ]);
    const expected = 'F4:40:2B:55:68:51:F4:77:C3:20:3B:BC:FD:E6:8C:68:57:1B:27:DB:81:25:C8:08:02:F7:20:18:35:64:28:9D';
    const provider = new AndroidSigningProvider(processes, makeConfig(expected));

    await expect(provider.verify(ctx, aab)).resolves.toEqual({ verified: true, sha256: TEST_CERT_SHA256 });
  });

  it('rejects an unsigned AAB even though jarsigner exits 0', async () => {
    const processes = new FakeProcessRunner([
      { tool: 'jarsigner', result: { exitCode: 0, stdout: JARSIGNER_UNSIGNED, stderr: '' } },
      { tool: 'keytool', result: { exitCode: 0, stdout: KEYTOOL_CERT, stderr: '' } },
    ]);
    const provider = new AndroidSigningProvider(processes, makeConfig());

    await expect(provider.verify(ctx, aab)).rejects.toThrow(SigningError);
    // keytool is never reached for an unsigned artifact
    expect(processes.calls).toHaveLength(1);
  });

  it('throws when the certificate does not match expectedCertificateSha256', async () => {
    const processes = new FakeProcessRunner([
      { tool: 'jarsigner', result: { exitCode: 0, stdout: JARSIGNER_VERIFIED, stderr: '' } },
      { tool: 'keytool', result: { exitCode: 0, stdout: KEYTOOL_CERT, stderr: '' } },
    ]);
    const wrong = '00'.repeat(32);
    const provider = new AndroidSigningProvider(processes, makeConfig(wrong));

    await expect(provider.verify(ctx, aab)).rejects.toThrow(/unexpected certificate/);
  });

  it('throws a SigningError with a JDK hint when jarsigner is missing', async () => {
    const processes = new FakeProcessRunner([]);
    const provider = new AndroidSigningProvider(processes, makeConfig());

    await expect(provider.verify(ctx, aab)).rejects.toThrow(/jarsigner\/keytool not found/);
  });
});

describe('AndroidSigningProvider — APK (unchanged apksigner path)', () => {
  it('still verifies APKs with apksigner --print-certs', async () => {
    const processes = new FakeProcessRunner([
      { tool: 'apksigner', result: { exitCode: 0, stdout: APKSIGNER_OUTPUT, stderr: '' } },
    ]);
    const provider = new AndroidSigningProvider(processes, makeConfig(TEST_CERT_SHA256));

    const result = await provider.verify(ctx, { kind: 'apk', platform: 'android', path: '/tmp/app-release.apk' });

    expect(result).toEqual({ verified: true, sha256: TEST_CERT_SHA256 });
    expect(processes.calls[0]?.args).toEqual(['verify', '--print-certs', '/tmp/app-release.apk']);
  });
});
