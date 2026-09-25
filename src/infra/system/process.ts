import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../core/ports/index.js';

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuf = '';
      let stderrBuf = '';

      const handleChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stream === 'stdout') {
          stdout += text;
          stdoutBuf += text;
        } else {
          stderr += text;
          stderrBuf += text;
        }
        let buf = stream === 'stdout' ? stdoutBuf : stderrBuf;
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          options.onLine?.(stream, line);
        }
        if (stream === 'stdout') stdoutBuf = buf;
        else stderrBuf = buf;
      };

      child.stdout.on('data', (c: Buffer) => handleChunk('stdout', c));
      child.stderr.on('data', (c: Buffer) => handleChunk('stderr', c));
      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (stdoutBuf) options.onLine?.('stdout', stdoutBuf);
        if (stderrBuf) options.onLine?.('stderr', stderrBuf);
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }

  async which(tool: string): Promise<string | null> {
    const pathEnv = process.env.PATH ?? '';
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, tool);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return null;
  }
}
