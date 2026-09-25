import { randomUUID } from 'node:crypto';
import type { Artifact } from '../artifact/types.js';
import { toCaricamentoError, BuildError } from '../errors.js';
import type { RunEvent, RunSummary, Step, StepContext, StepPlan } from './types.js';

export interface RunRecorder {
  record(runId: string, event: RunEvent): void;
  flush?(): Promise<void>;
}

export interface PipelineOptions {
  runId?: string;
  cwd: string;
  dryRun?: boolean;
  recorder?: RunRecorder;
}

/**
 * Sequential step engine. Progress is exposed ONLY as an AsyncIterable<RunEvent>
 * (SPEC §3.3) — core/application code never writes to the console.
 */
export class Pipeline {
  constructor(private readonly steps: Step[]) {}

  run(options: PipelineOptions): AsyncIterable<RunEvent> {
    const runId = options.runId ?? randomUUID();
    const queue: RunEvent[] = [];
    let done = false;
    let failure: unknown = null;
    let waiting: (() => void) | null = null;

    const push = (event: RunEvent) => {
      queue.push(event);
      options.recorder?.record(runId, event);
      waiting?.();
    };

    const execute = async () => {
      const startedAt = new Date();
      const plan: StepPlan[] = this.steps.map((s) => ({ stepId: s.id, title: s.title }));
      push({ type: 'run:start', runId, plan });

      const summary: RunSummary = {
        status: options.dryRun ? 'dry-run' : 'success',
        startedAt: startedAt.toISOString(),
        durationMs: 0,
        steps: [],
        artifacts: [] as Artifact[],
      };
      const data = new Map<string, unknown>();

      for (const step of this.steps) {
        push({ type: 'step:start', stepId: step.id, title: step.title });
        const stepStart = Date.now();
        const ctx: StepContext = {
          runId,
          cwd: options.cwd,
          dryRun: options.dryRun ?? false,
          log: (stream, line) => push({ type: 'step:log', stepId: step.id, stream, line }),
          progress: (percent, message) => push({ type: 'step:progress', stepId: step.id, percent, message }),
          data,
        };
        try {
          const result = (await step.run(ctx)) ?? {};
          const durationMs = Date.now() - stepStart;
          if (result.data) {
            for (const [k, v] of Object.entries(result.data)) data.set(k, v);
          }
          if (result.artifacts) summary.artifacts.push(...result.artifacts);
          summary.steps.push({ stepId: step.id, title: step.title, status: 'success', durationMs });
          push({ type: 'step:done', stepId: step.id, durationMs, artifacts: result.artifacts });
        } catch (err) {
          const error = toCaricamentoError(
            err,
            new BuildError(`Step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          const durationMs = Date.now() - stepStart;
          summary.steps.push({ stepId: step.id, title: step.title, status: 'failed', durationMs });
          summary.status = 'failed';
          summary.error = error.toJSON();
          push({ type: 'step:failed', stepId: step.id, error });
          break;
        }
      }

      summary.durationMs = Date.now() - startedAt.getTime();
      push({ type: 'run:done', runId, summary });
    };

    const generator = (async function* (): AsyncGenerator<RunEvent> {
      const execution = execute()
        .catch((err) => {
          failure = err;
        })
        .finally(() => {
          done = true;
          waiting?.();
        });

      try {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift() as RunEvent;
          }
          if (done) break;
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
        if (failure) throw failure;
      } finally {
        await execution;
      }
    })();

    return generator;
  }
}
