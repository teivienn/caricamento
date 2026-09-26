import { createContainer, type Container, type ContainerOptions } from '../../container.js';
import { resolveVariantConfig } from '../../core/config/variants.js';
import { ValidationError } from '../../core/errors.js';
import type { RunSummary } from '../../core/pipeline/types.js';
import { exitCodeOf } from './build.js';

export interface VariantRunResult {
  /** undefined for the base config (no --variant). */
  variant?: string;
  summary: RunSummary;
}

/**
 * Runs a command once per build variant (SPEC §5.4). `--variant <name>` runs
 * a single merged config; `--variant all` runs every variant sequentially,
 * each in its own container and pipeline run (own runId). A failing variant
 * does not stop the remaining ones; the process exit code is non-zero when
 * any variant failed.
 */
export async function runWithVariants(
  options: ContainerOptions,
  variantFlag: string | undefined,
  fn: (container: Container) => Promise<RunSummary>,
): Promise<VariantRunResult[]> {
  const base = await createContainer(options);
  const names = resolveVariantNames(base.config.variants, variantFlag);

  const results: VariantRunResult[] = [];
  for (const name of names) {
    const container =
      name === undefined ? base : await createContainer({ ...options, configOverride: resolveVariantConfig(base.config, name) });
    if (names.length > 1) process.stdout.write(`\n=== Variant: ${name} ===\n`);
    const summary = await fn(container);
    results.push({ variant: name, summary });
  }

  if (variantFlag !== undefined) printVariantSummary(results);

  const firstFailure = results.find((r) => r.summary.status === 'failed');
  if (firstFailure) {
    process.exitCode = firstFailure.summary.error ? exitCodeOf(firstFailure.summary.error) : 1;
  }
  return results;
}

function resolveVariantNames(variants: Container['config']['variants'], flag: string | undefined): Array<string | undefined> {
  if (flag === undefined) return [undefined];
  const names = Object.keys(variants ?? {});
  if (flag === 'all') {
    if (names.length === 0) {
      throw new ValidationError('--variant all was passed but no variants are defined', {
        hint: 'Add a `variants` block to caricamento.config.ts.',
      });
    }
    return names;
  }
  return [flag];
}

function printVariantSummary(results: VariantRunResult[]): void {
  process.stdout.write('\nVariant summary:\n');
  for (const { variant, summary } of results) {
    const name = variant ?? '(base)';
    const status = summary.status === 'failed' ? 'FAILED' : summary.status;
    process.stdout.write(`  ${name}: ${status} (${(summary.durationMs / 1000).toFixed(1)}s)\n`);
  }
}
