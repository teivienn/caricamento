import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Layer rules per SPEC.md §3.1:
//   core -> nothing (except zod), application -> core, infra -> core, cli -> all.
// Enforced here via per-folder no-restricted-imports (eslint-plugin-boundaries
// was considered but its flat-config support is still rough; revisit later).
const layerRule = (forbidden) => ({
  'no-restricted-imports': ['error', { patterns: forbidden }],
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'fixtures/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: layerRule([
      {
        group: ['**/application/**', '**/infra/**', '**/cli/**'],
        message: 'core must not depend on outer layers (SPEC.md §3.1)',
      },
    ]),
  },
  {
    files: ['src/application/**/*.ts'],
    rules: layerRule([
      {
        group: ['**/infra/**', '**/cli/**'],
        message: 'application must depend only on core (SPEC.md §3.1)',
      },
    ]),
  },
  {
    files: ['src/infra/**/*.ts'],
    rules: layerRule([
      {
        group: ['**/application/**', '**/cli/**'],
        message: 'infra implements core ports; it must not depend on application/cli',
      },
    ]),
  },
);
