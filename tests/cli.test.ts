import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/cli/program.js';

function findCommand(parent: Command, name: string): Command {
  const cmd = parent.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`command ${name} not found`);
  return cmd;
}

/** Replaces the action of `path` so parsing can be observed without running a build. */
function captureAction(path: string[]) {
  const cli = createProgram();
  const cmd = path.reduce<Command>((parent, name) => findCommand(parent, name), cli.program);
  const calls: { args: unknown[]; opts: Record<string, unknown> }[] = [];
  cmd.action((...args: unknown[]) => {
    calls.push({ args: args.slice(0, -2), opts: args.at(-2) as Record<string, unknown> });
  });
  return { ...cli, calls };
}

describe('CLI --version', () => {
  it('prints the package version at program level', async () => {
    for (const flag of ['--version', '-V']) {
      const { program } = createProgram();
      let out = '';
      program.exitOverride().configureOutput({ writeOut: (s) => (out += s) });
      await expect(program.parseAsync([flag], { from: 'user' })).rejects.toMatchObject({
        code: 'commander.version',
        exitCode: 0,
      });
      expect(out.trim()).toBe(pkg.version);
    }
  });

  it('build --help lists the per-command --version <name>', () => {
    const { program } = createProgram();
    expect(findCommand(program, 'build').helpInformation()).toContain('--version <name>');
    expect(findCommand(program, 'release').helpInformation()).toContain('--version <name>');
  });

  it.each(['build', 'release'])('%s --version <name> sets versionName instead of printing the tool version', async (name) => {
    const { program, calls } = captureAction([name]);
    await program.parseAsync([name, '--version', '9.9.9'], { from: 'user' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.version).toBe('9.9.9');
  });
});

describe('CLI global options', () => {
  it('are honored before the subcommand', async () => {
    const { program, globals, calls } = captureAction(['build']);
    await program.parseAsync(['--dry-run', '--json', '--config', 'a.ts', 'build', '--version', '1.2.3'], { from: 'user' });
    expect(calls[0]?.opts.version).toBe('1.2.3');
    expect(globals()).toEqual({ config: 'a.ts', verbose: false, json: true, dryRun: true });
  });

  it('are honored after the subcommand', async () => {
    const { program, globals, calls } = captureAction(['release']);
    await program.parseAsync(['release', '--version', '1.2.3', '--dry-run', '--verbose', '--config', 'b.ts'], {
      from: 'user',
    });
    expect(calls[0]?.opts.version).toBe('1.2.3');
    expect(globals()).toEqual({ config: 'b.ts', verbose: true, json: false, dryRun: true });
  });

  it('forward from nested subcommands', async () => {
    const { program, globals } = captureAction(['secrets', 'list']);
    await program.parseAsync(['secrets', 'list', '--json'], { from: 'user' });
    expect(globals().json).toBe(true);
  });

  it('do not shadow a subcommand option with the same name', async () => {
    const { program, globals, calls } = captureAction(['projects', 'add']);
    await program.parseAsync(['projects', 'add', 'app', '--path', '/tmp/app', '--config', 'own.ts'], { from: 'user' });
    expect(calls[0]?.args).toEqual(['app']);
    expect(calls[0]?.opts).toMatchObject({ path: '/tmp/app', config: 'own.ts' });
    expect(globals().config).toBeUndefined();
  });
});
