import { describe, expect, it } from 'vitest';
import { SigningError } from '../src/core/errors.js';
import { Pipeline, type RunRecorder } from '../src/core/pipeline/pipeline.js';
import type { RunEvent, Step } from '../src/core/pipeline/types.js';

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const step = (id: string, run?: () => Promise<{ data?: Record<string, unknown> } | void>): Step => ({
  id,
  title: `Step ${id}`,
  run: run ?? (async () => {}),
});

describe('Pipeline', () => {
  it('streams the full event sequence for a successful run', async () => {
    const steps = [
      step('a', async () => ({ data: { fromA: 1 } })),
      {
        id: 'b',
        title: 'Step b',
        run: async (ctx) => {
          expect(ctx.data.get('fromA')).toBe(1);
          ctx.log('stdout', 'hello');
          ctx.progress(50, 'halfway');
        },
      } satisfies Step,
      step('c'),
    ];
    const events = await collect(new Pipeline(steps).run({ cwd: '/tmp', runId: 'run-1' }));

    expect(events.map((e) => e.type)).toEqual([
      'run:start',
      'step:start',
      'step:done',
      'step:start',
      'step:log',
      'step:progress',
      'step:done',
      'step:start',
      'step:done',
      'run:done',
    ]);
    const start = events[0];
    expect(start?.type === 'run:start' && start.plan.map((p) => p.stepId)).toEqual(['a', 'b', 'c']);
    const done = events.at(-1);
    expect(done?.type === 'run:done' && done.summary.status).toBe('success');
    expect(done?.type === 'run:done' && done.summary.steps).toHaveLength(3);
  });

  it('stops after a failed step and reports a typed error', async () => {
    const steps = [
      step('a'),
      step('boom', async () => {
        throw new SigningError('bad signature', { hint: 'check the keystore' });
      }),
      step('never'),
    ];
    const events = await collect(new Pipeline(steps).run({ cwd: '/tmp' }));

    const failed = events.find((e) => e.type === 'step:failed');
    expect(failed?.type === 'step:failed' && failed.stepId).toBe('boom');
    expect(failed?.type === 'step:failed' && failed.error).toBeInstanceOf(SigningError);
    expect(failed?.type === 'step:failed' && failed.error.exitCode).toBe(4);

    const done = events.at(-1);
    expect(done?.type === 'run:done' && done.summary.status).toBe('failed');
    expect(done?.type === 'run:done' && done.summary.steps.map((s) => s.stepId)).toEqual(['a', 'boom']);
  });

  it('records every event through the recorder', async () => {
    const recorded: RunEvent[] = [];
    const recorder: RunRecorder = { record: (_runId, event) => recorded.push(event) };
    const events = await collect(new Pipeline([step('a')]).run({ cwd: '/tmp', recorder }));
    expect(recorded).toHaveLength(events.length);
  });

  it('marks dry-run summaries', async () => {
    const events = await collect(new Pipeline([step('a')]).run({ cwd: '/tmp', dryRun: true }));
    const done = events.at(-1);
    expect(done?.type === 'run:done' && done.summary.status).toBe('dry-run');
  });
});
