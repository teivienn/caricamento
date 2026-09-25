import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunRecorder } from '../../core/pipeline/pipeline.js';
import type { RunEvent, RunSummary } from '../../core/pipeline/types.js';
import type { RunRecordEntry } from '../../core/ports/index.js';

/** JSONL journal of every run at ~/.caricamento/runs/<runId>.jsonl (SPEC §3.3, §9). */
export class RunStore implements RunRecorder {
  constructor(private readonly baseDir: string = join(homedir(), '.caricamento', 'runs')) {}

  record(runId: string, event: RunEvent): void {
    // Fire-and-forget: journaling must never break a run.
    void mkdir(this.baseDir, { recursive: true })
      .then(() => appendFile(this.filePath(runId), JSON.stringify(serializeEvent(event)) + '\n', 'utf8'))
      .catch(() => undefined);
  }

  filePath(runId: string): string {
    return join(this.baseDir, `${runId}.jsonl`);
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    const content = await readFile(this.filePath(runId), 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEvent);
  }

  async readSummary(runId: string): Promise<RunSummary | null> {
    const events = await this.readEvents(runId);
    const done = events.find((e) => e.type === 'run:done');
    return done && done.type === 'run:done' ? done.summary : null;
  }

  async list(): Promise<RunRecordEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const entries: RunRecordEntry[] = [];
    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      const runId = file.replace(/\.jsonl$/, '');
      try {
        const events = await this.readEvents(runId);
        const start = events.find((e) => e.type === 'run:start');
        const done = events.find((e) => e.type === 'run:done');
        entries.push({
          runId,
          file: this.filePath(runId),
          startedAt: done && done.type === 'run:done' ? done.summary.startedAt : (start ? new Date(0).toISOString() : ''),
          status: done && done.type === 'run:done' ? done.summary.status : 'incomplete',
        });
      } catch {
        entries.push({ runId, file: this.filePath(runId), startedAt: '', status: 'unreadable' });
      }
    }
    return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

function serializeEvent(event: RunEvent): unknown {
  if (event.type === 'step:failed') {
    return { ...event, error: event.error.toJSON() };
  }
  return event;
}