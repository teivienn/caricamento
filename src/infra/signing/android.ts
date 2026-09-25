import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../../core/artifact/types.js';
import type { CaricamentoConfig } from '../../core/config/schema.js';
import { SigningError } from '../../core/errors.js';
import type { StepContext } from '../../core/pipeline/types.js';
import type { ProcessRunner, SigningProvider, SigningVerification } from '../../core/ports/index.js';

/**
 * Post-build signature verification via `apksigner verify --print-certs` (SPEC §6.2):
 * the SHA-256 of the signer certificate is compared against the expected value
 * from config, guarding against "signed with the wrong key".
 */
export class AndroidSigningProvider implements SigningProvider {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly config: CaricamentoConfig,
  ) {}

  async verify(ctx: StepContext, artifact: Artifact): Promise<SigningVerification> {
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

    const sha256 = this.parseSha256(result.stdout);
    const expected = this.config.android?.signing?.expectedCertificateSha256;
    if (expected && sha256 && sha256.toLowerCase() !== expected.replace(/:/g, '').toLowerCase()) {
      throw new SigningError('Artifact was signed with an unexpected certificate', {
        hint: 'Check that the keystore referenced in caricamento.config.ts is the correct upload key.',
        context: { expectedSha256: expected, actualSha256: sha256 },
      });
    }
    return { verified: true, sha256 };
  }

  private parseSha256(output: string): string | undefined {
    const line = output.split('\n').find((l) => l.includes('SHA-256 digest'));
    const match = line?.match(/:\s*([0-9a-fA-F]{64})/);
    return match?.[1];
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
