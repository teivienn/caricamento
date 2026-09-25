import { Command } from 'commander';
import { createBareContainer } from '../../container.js';
import type { GlobalOptions } from '../options.js';

export function statusCommand(globals: () => GlobalOptions): Command {
  return new Command('status')
    .description('Show the summary of a previous run')
    .argument('<runId>', 'run identifier')
    .action(async (runId: string) => {
      const opts = globals();
      const container = createBareContainer({ cwd: process.cwd() });
      const summary = await container.status.summary(runId);
      if (opts.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        return;
      }
      process.stdout.write(`run ${runId}: ${summary.status}\n`);
      process.stdout.write(`started: ${summary.startedAt}, duration: ${(summary.durationMs / 1000).toFixed(1)}s\n`);
      for (const step of summary.steps) {
        process.stdout.write(`  [${step.status}] ${step.title}${step.durationMs !== undefined ? ` (${step.durationMs}ms)` : ''}\n`);
      }
      for (const artifact of summary.artifacts) {
        process.stdout.write(`  artifact: ${artifact.kind} ${artifact.path}\n`);
      }
      if (summary.error) {
        process.stdout.write(`  error: [${summary.error.code}] ${summary.error.message}\n`);
        if (summary.error.hint) process.stdout.write(`  hint: ${summary.error.hint}\n`);
      }
      if (summary.status === 'failed') process.exitCode = 1;
    });
}

export function runsCommand(globals: () => GlobalOptions): Command {
  return new Command('runs')
    .description('List previous runs')
    .action(async () => {
      const opts = globals();
      const container = createBareContainer({ cwd: process.cwd() });
      const runs = await container.status.list();
      if (opts.json) {
        process.stdout.write(JSON.stringify({ runs }, null, 2) + '\n');
        return;
      }
      if (runs.length === 0) {
        process.stdout.write('No runs recorded yet.\n');
        return;
      }
      for (const run of runs) {
        process.stdout.write(`${run.runId}  ${run.status ?? '?'}  ${run.startedAt}\n`);
      }
    });
}
