import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';
import { NodeProcessRunner } from '../../infra/system/process.js';
import { KeychainSecretStore } from '../../infra/system/keychain.js';
import { promptHidden } from '../prompt.js';
import type { GlobalOptions } from '../options.js';

function normalizeName(name: string): string {
  return name.startsWith('secret:') ? name.slice('secret:'.length) : name;
}

/**
 * Keychain-backed secret management (SPEC §3.5). Items are ordinary generic
 * passwords with service "caricamento/<name>" — visible and editable in
 * Keychain Access.app.
 */
export function secretsCommand(globals: () => GlobalOptions): Command {
  const store = () => new KeychainSecretStore(new NodeProcessRunner());
  const cmd = new Command('secrets').description('Manage secrets in the macOS Keychain');

  cmd
    .command('set <name>')
    .description('Store a secret (prompts without echo; name with or without the secret: prefix)')
    .option('--value <value>', 'non-interactive value (warning: visible in shell history)')
    .action(async (name: string, opts: { value?: string }) => {
      const key = normalizeName(name);
      const value = opts.value ?? (await promptHidden(`Enter value for secret:${key}: `));
      if (value === '') {
        throw new ValidationError('Empty secret value');
      }
      await store().set(key, value);
      process.stdout.write(`Stored secret:${key} in the login Keychain.\n`);
    });

  cmd
    .command('get <name>')
    .description('Print a secret value to stdout')
    .action(async (name: string) => {
      const value = await store().get(normalizeName(name));
      if (value === null) {
        throw new ValidationError(`Secret "${normalizeName(name)}" not found in the Keychain`, {
          hint: 'Store it with `caricamento secrets set <name>`.',
        });
      }
      process.stdout.write(`${value}\n`);
    });

  cmd
    .command('delete <name>')
    .description('Remove a secret from the Keychain')
    .action(async (name: string) => {
      const removed = await store().delete(normalizeName(name));
      if (!removed) {
        throw new ValidationError(`Secret "${normalizeName(name)}" not found in the Keychain`);
      }
      process.stdout.write(`Deleted secret:${normalizeName(name)}.\n`);
    });

  cmd
    .command('list')
    .description('List secret names (never values)')
    .action(async () => {
      const names = await store().list();
      if (globals().json) {
        process.stdout.write(JSON.stringify({ secrets: names }) + '\n');
        return;
      }
      if (names.length === 0) {
        process.stdout.write('No secrets in the Keychain. Use `caricamento secrets set <name>`.\n');
        return;
      }
      for (const name of names) process.stdout.write(`${name}\n`);
    });

  return cmd;
}
