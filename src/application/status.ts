import type { RunSummary } from '../core/pipeline/types.js';
import type { RunJournal, RunRecordEntry } from '../core/ports/index.js';
import { ValidationError } from '../core/errors.js';

export class StatusUseCase {
  constructor(private readonly runs: RunJournal) {}

  async summary(runId: string): Promise<RunSummary> {
    const summary = await this.runs.readSummary(runId).catch(() => null);
    if (!summary) {
      throw new ValidationError(`No run found with id "${runId}"`, {
        hint: 'List known runs with `caricamento runs`.',
      });
    }
    return summary;
  }

  list(): Promise<RunRecordEntry[]> {
    return this.runs.list();
  }
}
