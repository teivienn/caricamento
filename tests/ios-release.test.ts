import { describe, expect, it } from 'vitest';
import { BuildUseCase } from '../src/application/build.js';
import { ReleaseUseCase } from '../src/application/release.js';
import type { Artifact } from '../src/core/artifact/types.js';
import { configSchema } from '../src/core/config/schema.js';
import { ValidationError } from '../src/core/errors.js';
import type { RunEvent } from '../src/core/pipeline/types.js';
import type { Builder, BuildRequest, Publisher, PublishRequest } from '../src/core/ports/index.js';

const config = (mode: 'automatic' | 'none' = 'automatic') =>
  configSchema.parse({
    project: { type: 'ios' },
    ios: { project: 'App.xcodeproj', scheme: 'App', signing: { mode, teamId: 'ABCDE12345', bundleId: 'com.example.app' } },
    version: { strategy: 'auto-increment', name: '1.4.0' },
    targets: { appstore: { apiKeyRef: 'secret:asc/key', keyId: 'K', issuerId: 'I', bundleId: 'com.example.app' } },
  });

const ipa: Artifact = { kind: 'ipa', platform: 'ios', path: '/tmp/App.ipa' };

function fakes() {
  const builds: BuildRequest[] = [];
  const published: PublishRequest[] = [];
  const builder: Builder = {
    build: async (_ctx, request) => {
      builds.push(request);
      return [ipa, { kind: 'dsym', platform: 'ios', path: '/tmp/dSYMs' }];
    },
  };
  const publisher: Publisher = {
    target: 'appstore',
    publish: async (_ctx, request) => {
      published.push(request);
      return { target: 'appstore' };
    },
  };
  return { builds, published, builder, publisher };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('iOS release use case', () => {
  it('builds with the App Store Connect max + 1 and publishes the .ipa', async () => {
    const { builds, published, builder, publisher } = fakes();
    const events = await collect(
      new ReleaseUseCase({
        config: config(),
        platform: 'ios',
        builder,
        signing: { verify: async () => ({ verified: true, identity: 'Apple Distribution: Example (ABCDE12345)' }) },
        publishers: { appstore: publisher },
        versionCodeProvider: { name: 'appstore', maxVersionCode: async () => 41 },
      }).run({ cwd: '/tmp/project', targets: ['appstore'] }),
    );

    const done = events.find((e) => e.type === 'run:done');
    expect(done?.type === 'run:done' && done.summary.status).toBe('success');
    expect(events.filter((e) => e.type === 'step:start').map((e) => (e.type === 'step:start' ? e.stepId : ''))).toEqual([
      'detect',
      'version',
      'build:ios',
      'verify-signing',
      'publish:appstore',
    ]);
    expect(builds).toEqual([{ platform: 'ios', versionCode: 42, versionName: '1.4.0', projectRoot: '/tmp/project' }]);
    expect(published[0]).toMatchObject({ artifact: ipa, versionCode: 42, versionName: '1.4.0' });
    const logs = events.flatMap((e) => (e.type === 'step:log' ? [e.line] : []));
    expect(logs.some((l) => l.includes('CFBundleVersion') && l.includes('42'))).toBe(true);
  });

  it('refuses to publish an unsigned build to App Store Connect', () => {
    const { builder, publisher } = fakes();
    const release = new ReleaseUseCase({
      config: config('none'),
      platform: 'ios',
      builder,
      signing: null,
      publishers: { appstore: publisher },
    });
    expect(() => release.run({ cwd: '/tmp/project', targets: ['appstore'] })).toThrow(ValidationError);
  });

  it('build --platform ios runs the Xcode build step and resolves the RN ios/ root', async () => {
    const { builds, builder } = fakes();
    const rn = configSchema.parse({
      project: { type: 'react-native' },
      ios: { workspace: 'App.xcworkspace', scheme: 'App', signing: { mode: 'none' } },
      version: { strategy: 'manual', buildNumber: 7, name: '2.0.0' },
    });
    await collect(new BuildUseCase({ config: rn, platform: 'ios', builder, signing: null }).run({ cwd: '/tmp/rn' }));
    expect(builds).toEqual([{ platform: 'ios', versionCode: 7, versionName: '2.0.0', projectRoot: '/tmp/rn/ios' }]);
  });
});
