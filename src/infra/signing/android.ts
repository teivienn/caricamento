import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../../core/artifact/types.js';
import type { CaricamentoConfig } from '../../core/config/schema.js';
import { SigningError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { ProcessRunner, SigningProvider, SigningVerification } from '../../core/ports/index.js';

/**
 * Post-build signature verification (SPEC §6.2): the SHA-256 of the signer
 * certificate is compared against the expected value from config, guarding
 * against "signed with the wrong key".
 *
 * APKs are verified with `apksigner verify --print-certs`. AABs are JAR-signed
 * ZIPs, which apksigner rejects (ApkFormatException), so they are verified with
 * the JDK instead: `jarsigner -verify -certs` for the signature itself and
 * `keytool -printcert -jarfile` for the certificate fingerprint (jarsigner
 * does not print certificate digests on JDK 17).
 */
export class AndroidSigningProvider implements SigningProvider {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly config: CaricamentoConfig,
  ) {}

  async verify(ctx: StepContext, artifact: Artifact): Promise<SigningVerification> {
    return artifact.kind === 'aab' ? this.verifyAab(ctx, artifact) : this.verifyApk(ctx, artifact);
  }

  private async verifyApk(ctx: StepContext, artifact: Artifact): Promise<SigningVerification> {
    const apksigner = await this.locateApksigner();
    if (!apksigner) {
      throw new SigningError('apksigner not found', {
        hint: 'Install the Android SDK build-tools and/or set ANDROID_HOME.',
      });
    }

    if (ctx.dryRun) {
      ctx.log('stdout', `[dry-run] ${apksigner} verify --print-certs ${artifact.path}`);
      return { verified: true };
    }

    const result = await this.processes.run(apksigner, ['verify', '--print-certs', artifact.path], {
      cwd: ctx.cwd,
      onLine: (stream, line) => ctx.log(stream, line),
    });
    if (result.exitCode !== 0) {
      throw new SigningError(`apksigner failed to verify ${artifact.path}`, {
        hint: 'The artifact is unsigned or corrupted. Check the signing configuration.',
        context: { stderr: result.stderr.trim() },
      });
    }

    const sha256 = this.parseApksignerSha256(result.stdout);
    this.assertExpectedCertificate(sha256);
    return { verified: true, sha256 };
  }

  private async verifyAab(ctx: StepContext, artifact: Artifact): Promise<SigningVerification> {
    const jarsigner = await this.processes.which('jarsigner');
    const keytool = await this.processes.which('keytool');
    if (!jarsigner || !keytool) {
      throw new SigningError('jarsigner/keytool not found', {
        hint: 'AAB verification needs the JDK (jarsigner + keytool) on PATH. Install a JDK 17+.',
      });
    }

    if (ctx.dryRun) {
      ctx.log('stdout', `[dry-run] ${jarsigner} -verify -certs ${artifact.path}`);
      return { verified: true };
    }

    const result = await this.processes.run(jarsigner, ['-verify', '-certs', artifact.path], {
      cwd: ctx.cwd,
      onLine: (stream, line) => ctx.log(stream, line),
    });
    // jarsigner exits 0 even for unsigned jars — the "jar is unsigned"
    // diagnostic on stdout is the only signal.
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /jar is unsigned/i.test(output)) {
      throw new SigningError(`jarsigner failed to verify ${artifact.path}`, {
        hint: 'The AAB is unsigned or corrupted. Check the signing configuration.',
        context: { output: output.trim().slice(0, 500) },
      });
    }

    const certs = await this.processes.run(keytool, ['-printcert', '-jarfile', artifact.path], { cwd: ctx.cwd });
    if (certs.exitCode !== 0) {
      throw new SigningError(`keytool could not read the signer certificate of ${artifact.path}`, {
        hint: 'The AAB is signed but its certificate could not be parsed.',
        context: { stderr: certs.stderr.trim() },
      });
    }

    const sha256 = this.parseKeytoolSha256(certs.stdout);
    this.assertExpectedCertificate(sha256);
    return { verified: true, sha256 };
  }

  private assertExpectedCertificate(sha256: string | undefined): void {
    const expected = this.config.android?.signing?.expectedCertificateSha256;
    if (expected && sha256 && sha256.toLowerCase() !== expected.replace(/:/g, '').toLowerCase()) {
      throw new SigningError('Artifact was signed with an unexpected certificate', {
        hint: 'Check that the keystore referenced in caricamento.config.ts is the correct upload key.',
        context: { expectedSha256: expected, actualSha256: sha256 },
      });
    }
  }

  /** apksigner prints "Signer #1 certificate SHA-256 digest: <64 hex>". */
  private parseApksignerSha256(output: string): string | undefined {
    const line = output.split('\n').find((l) => l.includes('SHA-256 digest'));
    const match = line?.match(/:\s*([0-9a-fA-F]{64})/);
    return match?.[1];
  }

  /** keytool prints "SHA256: F4:40:..." (colon-separated); normalized to bare hex. */
  private parseKeytoolSha256(output: string): string | undefined {
    const match = output.match(/SHA-?256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/);
    return match?.[1]?.replace(/:/g, '').toLowerCase();
  }

  private async locateApksigner(): Promise<string | null> {
    const onPath = await this.processes.which('apksigner');
    if (onPath) return onPath;
    const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdkRoot) return null;
    try {
      const versions = await readdir(join(sdkRoot, 'build-tools'));
      const latest = versions.sort().reverse()[0];
      if (!latest) return null;
      return join(sdkRoot, 'build-tools', latest, 'apksigner');
    } catch {
      return null;
    }
  }
}
