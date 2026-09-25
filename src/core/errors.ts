export const ExitCode = {
  Success: 0,
  Generic: 1,
  Validation: 2,
  Build: 3,
  Signing: 4,
  Upload: 5,
  Config: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorContext {
  [key: string]: unknown;
}

export abstract class CaricamentoError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: ExitCodeValue;
  /** Human-readable hint on how to fix the problem. */
  readonly hint?: string;
  readonly context: ErrorContext;

  constructor(message: string, options?: { hint?: string; context?: ErrorContext; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.hint = options?.hint;
    this.context = options?.context ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      context: this.context,
      exitCode: this.exitCode,
    };
  }
}

export class ValidationError extends CaricamentoError {
  readonly code = 'VALIDATION_ERROR';
  readonly exitCode = ExitCode.Validation;
}

export class ConfigError extends CaricamentoError {
  readonly code = 'CONFIG_ERROR';
  readonly exitCode = ExitCode.Config;
}

export class BuildError extends CaricamentoError {
  readonly code = 'BUILD_ERROR';
  readonly exitCode = ExitCode.Build;
}

export class SigningError extends CaricamentoError {
  readonly code = 'SIGNING_ERROR';
  readonly exitCode = ExitCode.Signing;
}

export class UploadError extends CaricamentoError {
  readonly code = 'UPLOAD_ERROR';
  readonly exitCode = ExitCode.Upload;
}

export function toCaricamentoError(err: unknown, fallback: CaricamentoError): CaricamentoError {
  if (err instanceof CaricamentoError) return err;
  fallback.cause = err;
  return fallback;
}
