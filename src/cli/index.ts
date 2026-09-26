#!/usr/bin/env node
import { CaricamentoError } from '../core/errors.js';
import { createProgram } from './program.js';

const { program, globals } = createProgram();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CaricamentoError) {
    if (globals().json) {
      process.stderr.write(JSON.stringify({ error: err.toJSON() }) + '\n');
    } else {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
    }
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
