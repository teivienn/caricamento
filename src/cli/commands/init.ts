import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { ValidationError } from '../../core/errors.js';

const TEMPLATE = `import { defineConfig } from 'caricamento';

export default defineConfig({
  project: { type: 'auto' }, // auto | ios | android | react-native | flutter

  android: {
    module: 'app',
    // flavor: 'prod',
    buildType: 'release',
    signing: {
      // Values are NAMES of secrets, never the secrets themselves (SPEC §3.5).
      // Resolution chain: env var (ANDROID_KEYSTORE_PATH etc.) -> macOS Keychain -> .env
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
      // Optional: expected SHA-256 of the upload certificate, verified post-build.
      // expectedCertificateSha256: 'AA:BB:...',
    },
  },

  version: {
    strategy: 'timestamp', // manual | timestamp | auto-increment (auto-increment: Phase 4)
    // buildNumber: 1,     // required for strategy 'manual'
    // name: '1.0.0',
  },

  targets: {
    firebase: {
      appIdAndroid: '1:1234567890:android:abcdef', // from the Firebase console
      groups: ['qa'],
      // serviceAccountRef: 'secret:firebase/service-account', // or set GOOGLE_APPLICATION_CREDENTIALS
      // releaseNotes: 'Default release notes',
    },
  },
});
`;

export function initCommand(): Command {
  return new Command('init')
    .description('Generate a caricamento.config.ts template in the current directory')
    .option('--force', 'overwrite an existing config file', false)
    .action(async (opts: { force: boolean }) => {
      const target = join(process.cwd(), 'caricamento.config.ts');
      if (existsSync(target) && !opts.force) {
        throw new ValidationError('caricamento.config.ts already exists', {
          hint: 'Use --force to overwrite it.',
        });
      }
      await writeFile(target, TEMPLATE, 'utf8');
      process.stdout.write(`Created ${target}\n`);
    });
}
