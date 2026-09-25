import ora, { type Ora } from 'ora';
import type { CaricamentoError } from '../../core/errors.js';
import type { RunEvent, RunSummary } from '../../core/pipeline/types.js';

export interface RenderOptions {
  json: boolean;
  verbose: boolean;
}

/** Subscribes to the RunEvent stream and renders spinners (or JSON lines with --json). */
export async function renderEvents(events: AsyncIterable<RunEvent>, options: RenderOptions): Promise<RunSummary> {
  let summary: RunSummary | null = null;
  let spinner: Ora | null = null;

  for await (const event of events) {
    if (options.json) {
      process.stdout.write(JSON.stringify(serialize(event)) + '\n');
      if (event.type === 'run:done') summary = event.summary;
      continue;
    }

    switch (event.type) {
      case 'run:start':
        ora(`Run ${event.runId} — ${event.plan.length} steps`).start().succeed();
        break;
      case 'step:start':
        spinner = ora(event.title).start();
        break;
      case 'step:log':
        if (options.verbose) {
          if (spinner?.isSpinning) spinner.stop();
          const dim = event.stream === 'stderr';
          process.stdout.write(`${dim ? '!' : '>'} ${event.line}\n`);
          spinner?.start();
        }
        break;
      case 'step:progress':
        if (spinner) spinner.text = `${spinner.text.replace(/ \(\d+%.*\)$/, '')} (${event.percent}%${event.message ? ` ${event.message}` : ''})`;
        break;
      case 'step:done':
        spinner?.succeed();
        spinner = null;
        for (const artifact of event.artifacts ?? []) {
          ora(`artifact: ${artifact.path}`).start().info();
        }
        break;
      case 'step:failed':
        spinner?.fail();
        spinner = null;
        renderError(event.error);
        break;
      case 'run:done':
        summary = event.summary;
        if (event.summary.status === 'success') {
          ora(`Run finished in ${(event.summary.durationMs / 1000).toFixed(1)}s`).start().succeed();
        } else if (event.summary.status === 'dry-run') {
          ora('Dry run finished — nothing was executed').start().info();
        } else {
          ora('Run failed').start().fail();
        }
        break;
    }
  }

  if (!summary) {
    throw new Error('Event stream ended without run:done');
  }
  return summary;
}

function renderError(error: CaricamentoError): void {
  process.stderr.write(`\nError [${error.code}]: ${error.message}\n`);
  if (error.hint) process.stderr.write(`Hint: ${error.hint}\n`);
}

function serialize(event: RunEvent): unknown {
  if (event.type === 'step:failed') {
    return { ...event, error: event.error.toJSON() };
  }
  return event;
}
