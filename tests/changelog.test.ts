import { describe, expect, it } from 'vitest';
import { formatReleaseNotes } from '../src/core/changelog/index.js';
import { ValidationError } from '../src/core/errors.js';
import type { ProcessResult, ProcessRunner } from '../src/core/ports/index.js';
import { GitChangelogProvider } from '../src/infra/changelog/git.js';

describe('formatReleaseNotes', () => {
  it('formats one bullet per commit subject', () => {
    expect(formatReleaseNotes(['Add login screen', 'Fix crash on startup'])).toBe('- Add login screen\n- Fix crash on startup');
  });

  it('trims and drops empty subjects', () => {
    expect(formatReleaseNotes(['  spaced  ', '', '   '])).toBe('- spaced');
  });

  it('returns an empty string for no commits', () => {
    expect(formatReleaseNotes([])).toBe('');
  });
});

describe('GitChangelogProvider', () => {
  const config = { source: 'git' as const, maxCommits: 20 };

  const runner = (handler: (args: string[]) => ProcessResult): { runner: ProcessRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      runner: {
        run: async (_cmd: string, args: string[]) => {
          calls.push(args);
          return handler(args);
        },
        which: async (tool: string) => (tool === 'git' ? '/usr/bin/git' : null),
      },
    };
  };

  it('lists commits since the last tag when tags exist', async () => {
    const { runner: processes, calls } = runner((args) => {
      if (args[0] === 'describe') return { exitCode: 0, stdout: 'v1.2.0\n', stderr: '' };
      if (args[0] === 'log') return { exitCode: 0, stdout: 'Add login\nFix crash\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    const notes = await new GitChangelogProvider(processes, config).generateReleaseNotes('/repo');

    expect(notes).toBe('- Add login\n- Fix crash');
    expect(calls[1]).toEqual(['log', '--no-merges', '--format=%s', 'v1.2.0..HEAD']);
  });

  it('falls back to the last maxCommits when the repo has no tags', async () => {
    const { runner: processes, calls } = runner((args) => {
      if (args[0] === 'describe') return { exitCode: 128, stdout: '', stderr: 'fatal: No names found, cannot describe anything.' };
      if (args[0] === 'log') return { exitCode: 0, stdout: 'Initial commit\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    const notes = await new GitChangelogProvider(processes, { source: 'git', maxCommits: 7 }).generateReleaseNotes('/repo');

    expect(notes).toBe('- Initial commit');
    expect(calls[1]).toEqual(['log', '--no-merges', '--format=%s', '-n', '7']);
  });

  it('throws a ValidationError outside a git repository', async () => {
    const { runner: processes } = runner((args) => {
      if (args[0] === 'describe') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
      if (args[0] === 'rev-parse') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    await expect(new GitChangelogProvider(processes, config).generateReleaseNotes('/nowhere')).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('throws a ValidationError when git is not installed', async () => {
    const processes: ProcessRunner = { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }), which: async () => null };
    await expect(new GitChangelogProvider(processes, config).generateReleaseNotes('/repo')).rejects.toThrow(ValidationError);
  });

  it('throws a ValidationError when no commits are found', async () => {
    const { runner: processes } = runner((args) => {
      if (args[0] === 'describe') return { exitCode: 0, stdout: 'v9.9.9\n', stderr: '' };
      if (args[0] === 'log') return { exitCode: 0, stdout: '\n', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    await expect(new GitChangelogProvider(processes, config).generateReleaseNotes('/repo')).rejects.toThrow(
      /no commits/i,
    );
  });
});
