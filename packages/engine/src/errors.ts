/**
 * The engine's error taxonomy.
 *
 * The classification exists so callers can decide *without string matching* whether to
 * retry, re-plan, fail the run, or tell the operator to fix their configuration. A
 * provider's own message is always preserved — the old app's habit of replacing it with a
 * guess is exactly what made a misconfigured project look like a regional restriction.
 */

/**
 * Marks an error whose `message` is the whole story for a human.
 *
 * The CLI's top-level handler prints a stack trace for anything it does not recognise,
 * which is right for a bug and wrong for "your key is missing" — a trace over a sentence
 * that already says what to do is how a good message gets ignored. That handler grew an
 * `instanceof` chain and a comment saying a fourth case should become a shared marker; this
 * is that marker, added when the fourth case arrived (`THIBI_TMP_DIR` pointing nowhere).
 *
 * `Symbol.for` rather than a class check on purpose: the marked classes live in three
 * different packages, and a registered symbol survives duplicate module instances where
 * `instanceof` quietly does not.
 */
export const USER_FACING = Symbol.for('thibi.user-facing');

/** An error that should reach a human as its message, never as a trace. */
export interface UserFacing {
  readonly [USER_FACING]: true;
  readonly message: string;
  readonly hint?: string;
}

export function isUserFacing(err: unknown): err is Error & UserFacing {
  return err instanceof Error && (err as Partial<UserFacing>)[USER_FACING] === true;
}

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
  // Always actionable and never a bug in this code: the message plus its hint is the entire
  // useful output, so it must not arrive wrapped in a trace from wherever it was thrown.
  readonly [USER_FACING] = true as const;
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

/**
 * The staging bucket is not fit to stage into, and the operator has to change something.
 *
 * Its own class rather than a `NotConfiguredError` because the two lead somewhere different:
 * `NotConfiguredError` means credentials, and this means a bucket's region, its storage
 * class, or — the case §6 of the Phase 2 plan exists for — a lifecycle rule we cannot see or
 * that does not exist. The message always carries the fix.
 */
export class StagingRefusedError extends EngineError {
  readonly retryable = false;
}

/**
 * The run was cancelled — by an operator, or by the process shutting down.
 *
 * Phase 9's design calls this `CancelledError`; it is this class, and there is deliberately
 * not a second one. Cancellation must be non-retryable, and without that rule cancelling a
 * run schedules five more attempts of the thing you just cancelled.
 */
export class AbortedError extends EngineError {
  readonly retryable = false;
  constructor(message = 'Aborted') {
    super(message);
  }
}

/**
 * A handler asserting finality about something the taxonomy cannot classify.
 *
 * The escape hatch for "this failed for a reason that will still be true in thirty seconds"
 * — a deadline exceeded, a response that parsed but made no sense. Use it sparingly: the
 * typed classes above carry more information to the operator than this does.
 */
export class NonRetryableError extends EngineError {
  readonly retryable = false;
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Another worker claimed this step while we were working on it.
 *
 * Raised by the heartbeat when its conditional `UPDATE … AND lease_owner = $me` matches no
 * row, which means the recovery sweep decided we were dead and handed the step on. Not
 * retryable by *this* worker: the step is already running somewhere else, and retrying is how
 * a resurrected step and its zombie predecessor both write segments and the run ends up with
 * duplicates.
 */
export class LeaseLostError extends EngineError {
  readonly retryable = false;
  constructor(readonly stepId: string) {
    super(`lease on step ${stepId} was taken by another worker`);
  }
}

/**
 * Node and undici report connection failures on `err.code`, not in the message.
 *
 * The original predicate only regex-matched `err.message`, which silently missed every
 * `UND_ERR_*` — that is, every connect and headers timeout from `fetch`, which is the most
 * common transient failure this project actually sees.
 */
const NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Is another attempt worth anything?
 *
 * The taxonomy answers first and is the intended path: providers map their statuses into
 * `RateLimitedError` / `ProviderUnavailableError` / `ProviderError` at the edge, so by the
 * time an error reaches here the classification has usually already been made by code that
 * could see the response body.
 *
 * The status and code branches below are for errors that never went through a mapper — a
 * bare `{ status }` thrown by a helper, an undici socket error. The rule that matters is the
 * negative one: **4xx from Google is a configuration or payload error.** Retrying one cannot
 * succeed, burns quota, and delays the operator seeing the real message by the length of the
 * backoff. The exceptions are 408 (the server timed out waiting for us), 425 (too early) and
 * 429 (explicitly "later"), all of which say to try again in as many words. 413 never is:
 * a chunk that is too large is too large, and the answer is to re-cut it.
 *
 * Kept from `lib/queue.ts:52-53`, whose entire body was
 * `status === 429 || (status !== undefined && status >= 500)` — correct as far as it went,
 * and the reason travels with it.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof EngineError) return err.retryable;
  // An AbortError from fetch is a cancellation, not a failure to retry.
  if (err instanceof Error && err.name === 'AbortError') return false;

  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NET_CODES.has(code)) return true;

  // Unknown failures — a socket reset, a DNS blip — are worth one more try.
  return (
    err instanceof Error &&
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(err.message)
  );
}

export function isReplannable(err: unknown): err is ChunkTooLargeError {
  return err instanceof ChunkTooLargeError;
}
