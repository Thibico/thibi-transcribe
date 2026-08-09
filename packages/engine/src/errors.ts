/**
 * The engine's error taxonomy.
 *
 * The classification exists so callers can decide *without string matching* whether to
 * retry, re-plan, fail the run, or tell the operator to fix their configuration. A
 * provider's own message is always preserved — the old app's habit of replacing it with a
 * guess is exactly what made a misconfigured project look like a regional restriction.
 */

export abstract class EngineError extends Error {
  abstract readonly retryable: boolean;
  /** Advice for a human, when there is something actionable to say. */
  readonly hint?: string;
  /** Milliseconds the provider asked us to wait, from a Retry-After header. */
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { hint?: string; retryAfterMs?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options?.hint !== undefined) this.hint = options.hint;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** The provider is rate limiting us. Honour Retry-After when it gave one. */
export class RateLimitedError extends EngineError {
  readonly retryable = true;
}

/** 5xx. Transient by assumption; the retry budget decides how long we believe that. */
export class ProviderUnavailableError extends EngineError {
  readonly retryable = true;
}

/**
 * The provider rejected the language code.
 *
 * Not retryable, and the hint points at the probe rather than at a guess: the matrix is a
 * dated snapshot and a provider widening or narrowing its list is a normal event.
 */
export class UnsupportedLanguageError extends EngineError {
  readonly retryable = false;
}

/**
 * The chunk exceeded a provider limit.
 *
 * Not retryable as-is, but *re-plannable*: the planner re-cuts that one chunk at half
 * length and tries once more. A bitrate spike in the middle of a long file is the usual
 * cause and it should not fail the run.
 */
export class ChunkTooLargeError extends EngineError {
  readonly retryable = false;
  readonly replannable = true;
}

/** Credentials missing, wrong, or lacking a role. Always an operator problem. */
export class NotConfiguredError extends EngineError {
  readonly retryable = false;
}

/** Anything else the provider said. Its message travels verbatim. */
export class ProviderError extends EngineError {
  readonly retryable = false;
  constructor(
    message: string,
    readonly status?: number,
    options?: { hint?: string; cause?: unknown },
  ) {
    super(message, options);
  }
}

/** ffprobe says the file has no audio stream, or ffmpeg cannot decode it. */
export class UnsupportedMediaError extends EngineError {
  readonly retryable = false;
}

export class FfmpegError extends EngineError {
  readonly retryable = false;
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** The run was cancelled — by an operator, or by the process shutting down. */
export class AbortedError extends EngineError {
  readonly retryable = false;
  constructor(message = 'Aborted') {
    super(message);
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof EngineError) return err.retryable;
  // An AbortError from fetch is a cancellation, not a failure to retry.
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Unknown failures — a socket reset, a DNS blip — are worth one more try.
  return err instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message);
}

export function isReplannable(err: unknown): err is ChunkTooLargeError {
  return err instanceof ChunkTooLargeError;
}
