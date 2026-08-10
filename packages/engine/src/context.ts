import type { Readable } from 'node:stream';
import type { Db } from '@thibi/db';
import type { LanguageRegistry } from '@thibi/languages';
import type { ObjectStore, TempDir } from '@thibi/storage';
import type { StagingStore } from './staging/types.js';

/**
 * Everything the engine needs, supplied by its caller.
 *
 * **The engine never reads `process.env`, `process.cwd()` or `__dirname`** — an ESLint rule
 * and a CI grep enforce it. Every stage is `(ctx, input) => Promise<output>`; no stage
 * constructs a client, opens a file by convention, or consults the environment.
 *
 * The concrete consequence, and the reason it is a rule rather than a convention:
 * `google/auth.ts` cannot contain `resolveServiceAccountJson()`. Turning
 * `GOOGLE_APPLICATION_CREDENTIALS` into a JSON string is a CLI concern; the engine receives
 * the string through `ctx.settings`. That single move is what makes the provider testable
 * without a filesystem, runnable in a worker with settings from Postgres, and configurable
 * from a browser in Phase 10 — which the overview names as a hard requirement.
 */
export interface EngineContext {
  db: Db;
  store: ObjectStore;
  /**
   * GCS staging for `batchRecognize`.
   *
   * Optional, and its absence is a supported configuration rather than a degraded one:
   * spike S3 measured chunked parallel sync 3.6-7x faster than batch at every size, so an
   * instance with no staging bucket is the *faster* one and simply pays 5.3x more.
   */
  staging?: StagingStore;
  settings: SettingsPort;
  /** Phase 6. */
  llm?: unknown;
  /** Phase 3/4. */
  sidecar?: unknown;
  ffmpeg: FfmpegPort;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  languages: LanguageRegistry;
  concurrency: ConcurrencyLimits;
  tmp: TempDirPort;
  signal?: AbortSignal;
  engineVersion: string;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(o: object, msg?: string): void;
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface RunEvent {
  runId: string;
  kind: string;
  data?: Record<string, unknown>;
}

/**
 * CLI: pretty-prints progress to stderr.
 * Worker (Phase 9): INSERT into `run_events` + `pg_notify` in one transaction, coalesced
 * to at most one per run per 500 ms.
 */
export interface EventSink {
  emit(event: RunEvent): void | Promise<void>;
}

export interface FfmpegPort {
  /** Buffered. Rejects with an error carrying stderr on a non-zero exit. */
  run(
    bin: 'ffmpeg' | 'ffprobe',
    args: string[],
    opts?: { maxBuffer?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }>;

  /**
   * Streaming stdout.
   *
   * Needed because normalize produces the FLAC and the raw PCM for waveform peaks in a
   * single pass — the decode and the filter are the expensive part, and running them twice
   * to get the peaks separately is waste.
   */
  spawn(
    bin: 'ffmpeg',
    args: string[],
    opts?: { signal?: AbortSignal },
  ): { stdout: Readable; stderr: Readable; done: Promise<void> };
}

export interface SettingsPort {
  get(key: string): Promise<string | null>;
  getJson<T>(key: string): Promise<T | null>;
  set(key: string, value: string): Promise<void>;
}

export interface ConcurrencyLimits {
  asrChunks: number;
  ffmpeg: number;
}

export interface TempDirPort {
  dir(prefix: string): Promise<TempDir>;
}

/**
 * The GCS prefix `batchRecognize` reads from. Not an object store — a wire format.
 *
 * Phase 1 sketched a three-method stub here. The real port lives in `staging/types.ts`
 * alongside its adapters, and this re-export is what keeps `EngineContext` from importing
 * the implementation. The stub's `assertLifecycleRule(): Promise<void>` became
 * `assertLifecycle(prefix): Promise<LifecycleCheck>`: a thrown error cannot carry the
 * distinction between "no rule", "the rule is too slow" and "we are not allowed to look",
 * and those three lead an operator to three different fixes.
 */
export type { StagingStore } from './staging/types.js';

export class MissingCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(
      `This stage needs ctx.${capability}, which the caller did not provide. ` +
        `Build the EngineContext with it, or route to a stage that does not need it.`,
    );
    this.name = 'MissingCapabilityError';
  }
}

/**
 * Typed guard for optional ports, used by Phase 2/3 stages so they do not each invent one.
 */
export function assertContext<K extends keyof EngineContext>(
  ctx: EngineContext,
  keys: readonly K[],
): asserts ctx is EngineContext & Required<Pick<EngineContext, K>> {
  for (const key of keys) {
    if (ctx[key] == null) throw new MissingCapabilityError(String(key));
  }
}
