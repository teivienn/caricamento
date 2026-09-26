import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../core/artifact/types.js';
import type { CaricamentoConfig, Platform } from '../core/config/schema.js';
import { ValidationError } from '../core/errors.js';
import type { Step } from '../core/pipeline/types.js';
import type { Builder, ChangelogProvider, Publisher, SigningProvider, VersionCodeProvider } from '../core/ports/index.js';
import { ProjectDetector } from '../core/project/detector.js';
import { resolveVersion } from '../core/versioning/index.js';

export interface VersionOverrides {
  buildNumber?: number;
  versionName?: string;
}

export function detectStep(config: CaricamentoConfig, platform: Platform): Step {
  return {
    id: 'detect',
    title: 'Detect project',
    run: async (ctx) => {
      const descriptor =
        config.project.type !== 'auto'
          ? null
          : new ProjectDetector().detect(ctx.cwd);
      const type = config.project.type !== 'auto' ? config.project.type : descriptor?.type;
      if (!type) {
        throw new ValidationError(`Could not detect project type in ${ctx.cwd}`, {
          hint: 'Set project.type explicitly in caricamento.config.ts.',
        });
      }
      if (config.project.type === 'auto' && descriptor && !descriptor.platforms.includes(platform)) {
        throw new ValidationError(`Project of type "${descriptor.type}" has no ${platform} platform directory`, {
          hint: `Check the project layout or choose a different --platform.`,
        });
      }
      ctx.log('stdout', `Detected project type: ${type} (platform: ${platform})`);
      return { data: { projectType: type } };
    },
  };
}

export function versionStep(
  config: CaricamentoConfig,
  overrides: VersionOverrides,
  versionCodeProvider?: VersionCodeProvider,
  platform: Platform = 'android',
): Step {
  const [codeLabel, nameLabel] = platform === 'ios' ? ['CFBundleVersion', 'CFBundleShortVersionString'] : ['versionCode', 'versionName'];
  return {
    id: 'version',
    title: 'Resolve version',
    run: async (ctx) => {
      let maxVersionCode: number | null | undefined;
      if (config.version.strategy === 'auto-increment') {
        if (!versionCodeProvider) {
          throw new ValidationError('version.strategy "auto-increment" has no version source', {
            hint:
              platform === 'ios'
                ? 'Configure targets.appstore or targets.firebase in caricamento.config.ts (see version.source).'
                : 'Configure targets.play or targets.firebase in caricamento.config.ts (see version.source).',
          });
        }
        maxVersionCode = await versionCodeProvider.maxVersionCode();
        ctx.log('stdout', `Max published ${codeLabel} (${versionCodeProvider.name}): ${maxVersionCode ?? '(no builds yet)'}`);
      }
      const resolved = resolveVersion(
        {
          config,
          buildNumberOverride: overrides.buildNumber,
          versionNameOverride: overrides.versionName,
          maxVersionCode,
        },
        platform,
      );
      ctx.log(
        'stdout',
        `${codeLabel}=${resolved.versionCode}${resolved.versionName ? ` ${nameLabel}=${resolved.versionName}` : ''} (strategy: ${config.version.strategy})`,
      );
      return { data: { versionCode: resolved.versionCode, versionName: resolved.versionName } };
    },
  };
}

/**
 * React Native / Flutter keep the native projects in <root>/android and
 * <root>/ios; native projects are built from the root itself (SPEC §5.3).
 */
export function nativeProjectRoot(cwd: string, projectType: unknown, platform: Platform): string {
  return projectType === 'react-native' || projectType === 'flutter' ? join(cwd, platform) : cwd;
}

export function androidProjectRoot(cwd: string, projectType: unknown): string {
  return nativeProjectRoot(cwd, projectType, 'android');
}

export function iosBuildStep(builder: Builder): Step {
  return {
    id: 'build:ios',
    title: 'Build iOS IPA',
    run: async (ctx) => {
      const artifacts = await builder.build(ctx, {
        platform: 'ios',
        versionCode: ctx.data.get('versionCode') as number | undefined,
        versionName: ctx.data.get('versionName') as string | undefined,
        projectRoot: nativeProjectRoot(ctx.cwd, ctx.data.get('projectType'), 'ios'),
      });
      return { artifacts, data: { artifacts } };
    },
  };
}

export function androidBuildStep(builder: Builder, artifactType: 'aab' | 'apk', switchedFrom?: 'aab' | 'apk'): Step {
  return {
    id: 'build:android',
    title: `Build Android ${artifactType.toUpperCase()}`,
    run: async (ctx) => {
      if (switchedFrom && switchedFrom !== artifactType) {
        ctx.log('stdout', `Artifact type switched ${switchedFrom} → ${artifactType}: Google Play requires AAB`);
      }
      const artifacts = await builder.build(ctx, {
        platform: 'android',
        artifactType,
        versionCode: ctx.data.get('versionCode') as number | undefined,
        versionName: ctx.data.get('versionName') as string | undefined,
        projectRoot: androidProjectRoot(ctx.cwd, ctx.data.get('projectType')),
      });
      return { artifacts, data: { artifacts } };
    },
  };
}

export function verifySigningStep(signing: SigningProvider | null): Step {
  return {
    id: 'verify-signing',
    title: 'Verify artifact signature',
    run: async (ctx) => {
      if (!signing) {
        ctx.log('stdout', 'No signing configured — skipping signature verification');
        return;
      }
      const artifacts = (ctx.data.get('artifacts') as Artifact[] | undefined) ?? [];
      const binary = findBinary(artifacts);
      if (!binary) {
        if (ctx.dryRun) return;
        throw new ValidationError('No built artifact available for signature verification');
      }
      const result = await signing.verify(ctx, binary);
      if (result.sha256) ctx.log('stdout', `Signer certificate SHA-256: ${result.sha256}`);
      if (result.identity) ctx.log('stdout', `Signed by: ${result.identity}`);
    },
  };
}

export function changelogStep(provider: ChangelogProvider): Step {
  return {
    id: 'changelog',
    title: 'Generate release notes',
    run: async (ctx) => {
      if (ctx.dryRun) {
        ctx.log('stdout', `[dry-run] would generate release notes via ${provider.name}`);
        return;
      }
      const notes = await provider.generateReleaseNotes(ctx.cwd);
      ctx.log('stdout', `Release notes (source: ${provider.name}):\n${notes}`);
      return { data: { generatedReleaseNotes: notes } };
    },
  };
}

export function publishStep(publisher: Publisher, releaseNotes?: string): Step {
  return {
    id: `publish:${publisher.target}`,
    title: `Publish to ${publisher.target}`,
    run: async (ctx) => {
      const artifacts = (ctx.data.get('artifacts') as Artifact[] | undefined) ?? [];
      const binary = findBinary(artifacts);
      if (!binary) {
        if (ctx.dryRun) {
          ctx.log('stdout', `[dry-run] would publish artifact to ${publisher.target}`);
          return;
        }
        throw new ValidationError('No artifact to publish. Build first or pass --artifact.');
      }
      const result = await publisher.publish(ctx, {
        artifact: binary,
        artifacts,
        releaseNotes,
        generatedReleaseNotes: ctx.data.get('generatedReleaseNotes') as string | undefined,
        versionCode: ctx.data.get('versionCode') as number | undefined,
        versionName: ctx.data.get('versionName') as string | undefined,
      });
      return { data: { publishResult: result } };
    },
  };
}

function findBinary(artifacts: Artifact[]): Artifact | undefined {
  return artifacts.find((a) => a.kind === 'apk' || a.kind === 'aab' || a.kind === 'ipa');
}

export function locateArtifactStep(artifactPath: string | undefined, artifactType: 'aab' | 'apk' | 'ipa'): Step {
  const platform = artifactType === 'ipa' ? 'ios' : 'android';
  return {
    id: 'locate-artifact',
    title: 'Locate artifact',
    run: async (ctx) => {
      const path = artifactPath ?? (await findNewestArtifact(ctx.cwd, artifactType));
      if (!path) {
        if (ctx.dryRun) {
          ctx.log('stdout', `[dry-run] no .${artifactType} artifact found — would fail here on a real run`);
          return;
        }
        throw new ValidationError(`No .${artifactType} artifact found`, {
          hint: `Pass --artifact <path> or run \`caricamento build --platform ${platform}\` first.`,
        });
      }
      ctx.log('stdout', `Artifact: ${path}`);
      const artifacts: Artifact[] = [{ kind: artifactType, platform, path }];
      return { artifacts, data: { artifacts } };
    },
  };
}

async function findNewestArtifact(root: string, artifactType: 'aab' | 'apk' | 'ipa'): Promise<string | null> {
  // Native projects keep outputs under <root>; RN/Flutter under <root>/android or <root>/ios.
  // iOS exports land directly in build/caricamento/ipa (XcodeBuilder).
  const outputsRoots =
    artifactType === 'ipa'
      ? []
      : [root, join(root, 'android')].map((r) => join(r, 'app', 'build', 'outputs', artifactType === 'aab' ? 'bundle' : 'apk'));
  const candidates: string[] = [];
  if (artifactType === 'ipa') {
    for (const dir of [root, join(root, 'ios')].map((r) => join(r, 'build', 'caricamento', 'ipa'))) {
      const files = await readdir(dir).catch(() => [] as string[]);
      candidates.push(...files.filter((f) => f.endsWith('.ipa')).map((f) => join(dir, f)));
    }
  }
  for (const outputsRoot of outputsRoots) {
    try {
      const variants = await readdir(outputsRoot);
      for (const variant of variants) {
        try {
          const files = await readdir(join(outputsRoot, variant));
          candidates.push(...files.filter((f) => f.endsWith(`.${artifactType}`)).map((f) => join(outputsRoot, variant, f)));
        } catch {
          // not a directory
        }
      }
    } catch {
      // outputs directory does not exist at this root
    }
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const path of candidates) {
    const info = await stat(path);
    if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? null;
}
