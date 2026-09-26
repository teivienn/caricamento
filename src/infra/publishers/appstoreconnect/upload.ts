import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { UploadError } from '../../../core/errors.js';
import type { StepContext } from '../../../core/pipeline/types.js';
import type { ProcessRunner } from '../../../core/ports/index.js';
import { materializeSecretFile } from '../../system/secret-file.js';
import type { AppStoreConnectClient } from './client.js';
import type { AscCredentials } from './jwt.js';

export interface BuildUploadInput {
  ipaPath: string;
  appId: string;
  bundleId: string;
  /** CFBundleShortVersionString. */
  shortVersion: string;
  /** CFBundleVersion. */
  bundleVersion: string;
}

export interface BuildUploadResult {
  /** Build Uploads API resource id (api mechanism only). */
  buildUploadId?: string;
}

/** Port for getting an .ipa into App Store Connect (SPEC §7.1). */
export interface AscBuildUploader {
  readonly name: 'api' | 'altool';
  upload(ctx: StepContext, input: BuildUploadInput): Promise<BuildUploadResult>;
}

/**
 * Build Uploads REST API (App Store Connect API, WWDC25), per Apple's
 * reference:
 *   1. POST /v1/buildUploads — cfBundleShortVersionString, cfBundleVersion,
 *      platform, relationship to the app;
 *   2. POST /v1/buildUploadFiles — reserve the file (assetType ASSET,
 *      uti com.apple.ipa, fileName, fileSize); the response lists
 *      uploadOperations (method, url, offset, length, requestHeaders);
 *   3. perform every operation with its byte range;
 *   4. PATCH /v1/buildUploadFiles/{id} with uploaded: true to commit.
 * Processing progress is then visible on GET /v1/buildUploads/{id}.
 */
export class ApiBuildUploader implements AscBuildUploader {
  readonly name = 'api';

  constructor(private readonly client: AppStoreConnectClient) {}

  async upload(ctx: StepContext, input: BuildUploadInput): Promise<BuildUploadResult> {
    const fileSize = (await stat(input.ipaPath)).size;
    const buildUpload = await this.client.createBuildUpload({
      appId: input.appId,
      shortVersion: input.shortVersion,
      bundleVersion: input.bundleVersion,
    });
    ctx.log('stdout', `Build upload created: ${buildUpload.id}`);

    const file = await this.client.createBuildUploadFile({
      buildUploadId: buildUpload.id,
      fileName: basename(input.ipaPath),
      fileSize,
    });
    const operations = file.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new UploadError('App Store Connect returned no upload operations for the build file', {
        context: { buildUploadId: buildUpload.id, fileId: file.id },
      });
    }

    const handle = await open(input.ipaPath, 'r');
    try {
      let sent = 0;
      for (const [index, operation] of operations.entries()) {
        const offset = operation.offset ?? 0;
        const length = operation.length ?? fileSize - offset;
        const chunk = new Uint8Array(length);
        const { bytesRead } = await handle.read(chunk, 0, length, offset);
        if (bytesRead !== length) {
          throw new UploadError(`Short read of ${input.ipaPath} at offset ${offset}`, { context: { bytesRead, length } });
        }
        await this.client.performUploadOperation(operation, chunk);
        sent += length;
        ctx.progress(10 + Math.round((sent / fileSize) * 30), `Uploaded part ${index + 1}/${operations.length}`);
      }
    } finally {
      await handle.close();
    }

    await this.client.commitBuildUploadFile(file.id);
    ctx.log('stdout', `Upload committed (${operations.length} part(s), ${fileSize} bytes)`);
    return { buildUploadId: buildUpload.id };
  }
}

/**
 * Fallback: `xcrun altool --upload-app` (ships with Xcode). Flags follow
 * altool 26's own --help: --api-key / --api-issuer / --p8-file-path.
 */
export class AltoolBuildUploader implements AscBuildUploader {
  readonly name = 'altool';

  constructor(
    private readonly processes: ProcessRunner,
    private readonly credentials: () => Promise<AscCredentials>,
  ) {}

  async upload(ctx: StepContext, input: BuildUploadInput): Promise<BuildUploadResult> {
    const credentials = await this.credentials();
    const keyFile = await materializeSecretFile(credentials.privateKey, {
      fileName: `AuthKey_${credentials.keyId}.p8`,
      encoding: 'pem',
      label: 'App Store Connect API key',
    });
    const args = altoolArgs(input.ipaPath, credentials.keyId, credentials.issuerId, keyFile.path);
    try {
      ctx.log('stdout', `xcrun ${args.join(' ')}`);
      const errors: string[] = [];
      const result = await this.processes.run('xcrun', args, {
        onLine: (stream, line) => {
          if (/error/i.test(line)) errors.push(line.trim());
          ctx.log(stream, line);
        },
      });
      if (result.exitCode !== 0) {
        throw new UploadError(`altool upload failed (exit ${result.exitCode})${errors[0] ? `: ${errors[0]}` : ''}`, {
          hint: 'Check the API key permissions and that the CFBundleVersion was not uploaded before.',
          context: { errors: errors.slice(0, 10) },
        });
      }
    } finally {
      await keyFile.cleanup();
    }
    return {};
  }
}

export function altoolArgs(ipaPath: string, keyId: string, issuerId: string, p8Path: string): string[] {
  return ['altool', '--upload-app', '-f', ipaPath, '-t', 'ios', '--api-key', keyId, '--api-issuer', issuerId, '--p8-file-path', p8Path];
}
