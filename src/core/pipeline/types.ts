import type { Artifact } from '../artifact/types.js';
import type { CaricamentoError } from '../errors.js';

export type RunEvent =
  | { type: 'run:start'; runId: string; plan: StepPlan[] }
  | { type: 'step:start'; stepId: string; title: string }
  | { type: 'step:log'; stepId: string; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'step:progress'; stepId: string; percent: number; message?: string }
  | { type: 'step:done'; stepId: string; durationMs: number; artifacts?: Artifact[] }
  | { type: 'step:failed'; stepId: string; error: CaricamentoError }
  | { type: 'run:done'; runId: string; summary: RunSummary };

export interface StepPlan {
  stepId: string;
  title: string;
}

export interface RunSummary {
  status: 'success' | 'failed' | 'dry-run';
  startedAt: string;
  durationMs: number;
  steps: Array<{ stepId: string; title: string; status: 'success' | 'failed' | 'skipped'; durationMs?: number }>;
  artifacts: Artifact[];
  error?: ReturnType<CaricamentoError['toJSON']>;
}

export interface StepContext {
  runId: string;
  /** Working directory of the target project. */
  cwd: string;
  dryRun: boolean;
  log(stream: 'stdout' | 'stderr', line: string): void;
  progress(percent: number, message?: string): void;
  /** Values produced by earlier steps (e.g. resolved version, built artifacts). */
  data: Map<string, unknown>;
}

export interface StepResult {
  artifacts?: Artifact[];
  /** Values exposed to later steps via StepContext.data. */
  data?: Record<string, unknown>;
}

export interface Step {
  id: string;
  title: string;
  run(ctx: StepContext): Promise<StepResult | void>;
}

export interface UseCase<Input> {
  run(input: Input): AsyncIterable<RunEvent>;
}
