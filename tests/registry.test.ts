import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, ValidationError } from '../src/core/errors.js';
import { JsonProjectRegistry } from '../src/infra/system/registry.js';
import { resolveTarget } from '../src/cli/resolve-target.js';

describe('JsonProjectRegistry', () => {
  let dir: string;
  let projectDir: string;
  let registry: JsonProjectRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-registry-'));
    projectDir = join(dir, 'my-project');
    await writeFile(join(dir, 'marker.txt'), 'x');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir);
    registry = new JsonProjectRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry = (name: string) => ({ name, path: projectDir, addedAt: new Date().toISOString() });

  it('adds, gets and lists projects', async () => {
    await registry.add(entry('beta'));
    await registry.add(entry('alpha'));

    expect(await registry.get('alpha')).toMatchObject({ name: 'alpha', path: projectDir });
    expect((await registry.list()).map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('persists across instances', async () => {
    await registry.add(entry('myapp'));
    const fresh = new JsonProjectRegistry(dir);
    expect(await fresh.get('myapp')).not.toBeNull();
  });

  it('rejects duplicates, invalid names and missing paths', async () => {
    await registry.add(entry('myapp'));
    await expect(registry.add(entry('myapp'))).rejects.toThrow(ValidationError);
    await expect(registry.add(entry('1 bad name!'))).rejects.toThrow(ValidationError);
    await expect(registry.add({ ...entry('ghost'), path: join(dir, 'nope') })).rejects.toThrow(ValidationError);
  });

  it('removes projects and fails on unknown names', async () => {
    await registry.add(entry('myapp'));
    await registry.remove('myapp');
    expect(await registry.get('myapp')).toBeNull();
    await expect(registry.remove('myapp')).rejects.toThrow(ValidationError);
  });
});

describe('resolveTarget', () => {
  let dir: string;
  let projectDir: string;
  let registry: JsonProjectRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caricamento-target-'));
    projectDir = join(dir, 'project');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir);
    registry = new JsonProjectRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes through the current directory when no project name is given', async () => {
    const target = await resolveTarget(undefined, undefined, registry);
    expect(target.cwd).toBe(process.cwd());
    expect(target.configPath).toBeUndefined();
  });

  it('resolves a registered project with a registry config', async () => {
    await registry.add({ name: 'myapp', path: projectDir, addedAt: new Date().toISOString() });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'projects'));
    await writeFile(registry.configPathFor('myapp'), 'export default {}');

    const target = await resolveTarget('myapp', undefined, registry);
    expect(target.cwd).toBe(projectDir);
    expect(target.configPath).toBe(registry.configPathFor('myapp'));
    expect(target.envFiles).toEqual([registry.envPathFor('myapp')]);
  });

  it('falls back to the project-local config when no registry config exists', async () => {
    await registry.add({ name: 'myapp', path: projectDir, addedAt: new Date().toISOString() });
    const target = await resolveTarget('myapp', undefined, registry);
    expect(target.cwd).toBe(projectDir);
    expect(target.configPath).toBeUndefined(); // loader falls back to <cwd>/caricamento.config.ts
  });

  it('prefers an explicit --config over everything', async () => {
    await registry.add({ name: 'myapp', path: projectDir, addedAt: new Date().toISOString() });
    const target = await resolveTarget('myapp', '/tmp/custom.config.ts', registry);
    expect(target.configPath).toBe('/tmp/custom.config.ts');
  });

  it('fails with a helpful error for unknown projects', async () => {
    await registry.add({ name: 'known', path: projectDir, addedAt: new Date().toISOString() });
    const err = await resolveTarget('unknown', undefined, registry).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).hint).toContain('known');
  });

  it('fails when the registered path was moved away', async () => {
    await registry.add({ name: 'myapp', path: projectDir, addedAt: new Date().toISOString() });
    await rm(projectDir, { recursive: true });
    await expect(resolveTarget('myapp', undefined, registry)).rejects.toThrow(/no longer exists/);
  });
});
