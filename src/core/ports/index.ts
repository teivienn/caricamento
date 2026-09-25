import type { Artifact } from '../artifact/types.js';
import type { Platform } from '../config/schema.js';
import type { RunSummary, StepContext } from '../pipeline/types.js';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  /** Resolve a tool path (PATH lookup or well-known locations); null when not found. */
  which(tool: string): Promise<string | null>;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
}

export interface SecretResolver {
  /** Resolve a `secret:<name>` reference through the store chain (SPEC §3.5). */
  resolve(ref: string): Promise<string>;
  tryResolve(ref: string): Promise<string | null>;
}

export interface BuildRequest {
  platform: Platform;
  /** 'aab' | 'apk' for Android; ignored elsewhere for now. */
  artifactType?: 'aab' | 'apk';
  versionCode?: number;
  versionName?: string;
  /**
   * Directory containing the native build entrypoint (gradlew for Android).
   * Differs from the run cwd for React Native / Flutter projects, where the
   * Android project lives in <root>/android (SPEC §5.3).
   */
  projectRoot?: string;
}

export interface Builder {
  build(ctx: StepContext, request: BuildRequest): Promise<Artifact[]>;
}

export interface PublishRequest {
  artifact: Artifact;
  releaseNotes?: string;
  versionName?: string;
  versionCode?: number;
}

export interface PublishResult {
  target: string;
  releaseName?: string;
  url?: string;
}

export interface Publisher {
  readonly target: string;
  publish(ctx: StepContext, request: PublishRequest): Promise<PublishResult>;
}

export interface SigningVerification {
  verified: boolean;
  sha256?: string;
}

export interface SigningProvider {
  verify(ctx: StepContext, artifact: Artifact): Promise<SigningVerification>;
}

export interface RunRecordEntry {
  runId: string;
  startedAt: string;
  status?: string;
  file: string;
}

export interface ConfigLoader {
  load(configPath: string): Promise<unknown>;
}

/** Read-side port of the JSONL run journal (implemented by infra RunStore). */
export interface RunJournal {
  readSummary(runId: string): Promise<RunSummary | null>;
  list(): Promise<RunRecordEntry[]>;
}
