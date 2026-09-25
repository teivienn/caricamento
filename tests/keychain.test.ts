import { describe, expect, it, vi } from 'vitest';
import type { ProcessRunner } from '../src/core/ports/index.js';
import { KeychainSecretStore } from '../src/infra/system/keychain.js';

const makeRunner = (impl: (args: string[]) => { exitCode: number; stdout?: string; stderr?: string }) => {
  const run = vi.fn(async (_cmd: string, args: string[]) => ({ stdout: '', stderr: '', ...impl(args) }));
  const runner: ProcessRunner = { run, which: async () => null };
  return { runner, run };
};

describe('KeychainSecretStore', () => {
  it('reads via security find-generic-password', async () => {
    const { runner, run } = makeRunner(() => ({ exitCode: 0, stdout: 's3cret\n' }));
    const store = new KeychainSecretStore(runner);
    await expect(store.get('android/key-password')).resolves.toBe('s3cret');
    expect(run.mock.calls[0]?.[1]).toEqual(['find-generic-password', '-s', 'caricamento/android/key-password', '-w']);
  });

  it('resolves to null when the item is missing', async () => {
    const { runner } = makeRunner(() => ({ exitCode: 44 }));
    await expect(new KeychainSecretStore(runner).get('nope')).resolves.toBeNull();
  });

  it('stores via add-generic-password -U', async () => {
    const { runner, run } = makeRunner(() => ({ exitCode: 0 }));
    await new KeychainSecretStore(runner).set('android/key-password', 's3cret');
    const args = run.mock.calls[0]?.[1];
    if (!args) throw new Error('security was not invoked');
    expect(args[0]).toBe('add-generic-password');
    expect(args).toContain('-U');
    expect(args[args.indexOf('-s') + 1]).toBe('caricamento/android/key-password');
    expect(args[args.indexOf('-w') + 1]).toBe('s3cret');
  });

  it('throws when the keychain write fails', async () => {
    const { runner } = makeRunner(() => ({ exitCode: 1, stderr: 'denied' }));
    await expect(new KeychainSecretStore(runner).set('a/b', 'v')).rejects.toThrow(/denied/);
  });

  it('deletes and reports whether the item existed', async () => {
    const { runner, run } = makeRunner((args) => ({ exitCode: args.includes('missing') ? 44 : 0 }));
    const store = new KeychainSecretStore(runner);
    await expect(store.delete('android/key-password')).resolves.toBe(true);
    expect(run.mock.calls[0]?.[1]).toEqual(['delete-generic-password', '-s', 'caricamento/android/key-password']);
  });

  it('lists only caricamento items, prefix stripped, sorted', async () => {
    const dump = [
      '"svce"<blob>="caricamento/android/keystore-password"',
      '"svce"<blob>="com.apple.SomeSystemThing"',
      '"svce"<blob>="caricamento/firebase/service-account"',
      '"svce"<blob>="caricamento/android/keystore-password"', // duplicates collapse
    ].join('\n');
    const { runner } = makeRunner(() => ({ exitCode: 0, stdout: dump }));
    await expect(new KeychainSecretStore(runner).list()).resolves.toEqual([
      'android/keystore-password',
      'firebase/service-account',
    ]);
  });
});
