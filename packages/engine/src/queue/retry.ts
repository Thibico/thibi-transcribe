import type { StepKind } from './queues.js';

/**
 * The retry policy, per step kind.
 *
 * **This is the only table.** `packages/engine/src/retry.ts` used to carry a second one for
 * the in-process `withRetry` the CLI drives, covering five of these fifteen kinds with caps
 * that had drifted apart from these (`asr.chunk` capped at 30 s there and 120 s here) purely
 * because each file invented a number the overview never specified. Two tables of retry
 * constants for the same step kinds is a trap with no upside, so that one now derives from
 * this one and the numbers cannot disagree again.
 *
 * The values themselves come from the overview: `media.normalize` 2 × 5 s, `asr.chunk`
 * 5 × 2 s jittered, `asr.batch.submit` 3 × 30 s, `diarize` 2 × 60 s, `editorial.pass`
 * 4 × 5 s jittered — with the kinds it did not enumerate filled in by analogy.
 */
export interface RetrySpec {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  jitter: boolean;
}

export const POLICY: Record<StepKind, RetrySpec> = {
  'media.probe': { maxAttempts: 2, baseMs: 5_000, capMs: 30_000, jitter: false },
  'media.normalize': { maxAttempts: 2, baseMs: 5_000, capMs: 60_000, jitter: false },
  'media.peaks': { maxAttempts: 2, baseMs: 5_000, capMs: 60_000, jitter: false },
  'plan.chunks': { maxAttempts: 2, baseMs: 5_000, capMs: 30_000, jitter: false },
  'asr.chunk': { maxAttempts: 5, baseMs: 2_000, capMs: 120_000, jitter: true },
  'asr.batch.submit': { maxAttempts: 3, baseMs: 30_000, capMs: 300_000, jitter: false },
  'asr.poll': { maxAttempts: 8, baseMs: 30_000, capMs: 300_000, jitter: true },
  'asr.fetch': { maxAttempts: 3, baseMs: 10_000, capMs: 120_000, jitter: true },
  diarize: { maxAttempts: 2, baseMs: 60_000, capMs: 300_000, jitter: false },
  'diarize.poll': { maxAttempts: 8, baseMs: 30_000, capMs: 300_000, jitter: true },
  'reconcile.speakers': { maxAttempts: 2, baseMs: 5_000, capMs: 30_000, jitter: false },
  'normalize.text': { maxAttempts: 2, baseMs: 5_000, capMs: 30_000, jitter: false },
  'editorial.pass': { maxAttempts: 4, baseMs: 5_000, capMs: 120_000, jitter: true },
  export: { maxAttempts: 3, baseMs: 5_000, capMs: 60_000, jitter: true },
  'staging.cleanup': { maxAttempts: 3, baseMs: 30_000, capMs: 300_000, jitter: false },
};

/**
 * The upper bound on a `Retry-After` we are willing to believe, and it is not a formality.
 *
 * A `Retry-After` measured in seconds is a provider telling the truth about its window.
 * One measured in hours, obeyed literally, is **indistinguishable from a hang** from outside
 * the process: no output, no error, and a job killed at the CI timeout having measured
 * nothing. That happened to the LLM eval on Groq's free tier. Past this ceiling the hint is
 * dropped and the computed backoff is used instead, so the retry budget is spent quickly and
 * the step fails with the provider's own message attached — which is information, where
 * silence is not.
 *
 * 15 minutes rather than the LLM path's 60 seconds because a *step* that waits fifteen
 * minutes is still visibly `pending` with a `poll_after` an operator can read, holding no
 * worker slot. An in-process sleep of the same length is a wedged process.
 */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;

/**
 * Full jitter — `random() * exp` — and not equal jitter, and not exponential with a dash of
 * noise on top.
 *
 * Eight `asr.chunk` steps that hit the same 429 at the same instant must not wake at the same
 * instant, and full jitter is the variant that actually decorrelates them. Capped exponential
 * with ±10% noise leaves them in a tight cluster that re-triggers the limit, which is exactly
 * the failure the old fixed `[2000, 4000, 8000]` schedule had.
 *
 * `retryAfterMs` is a **floor, never a ceiling**: a provider that says "wait 60 s" means it,
 * and jittering below that just earns a second rejection.
 */
export function backoffMs(
  spec: RetrySpec,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(spec.capMs, spec.baseMs * 2 ** attempt);
  const jittered = spec.jitter ? random() * exp : exp;
  return Math.max(Math.ceil(jittered), retryAfterMs ?? 0);
}

/**
 * RFC 9110 `Retry-After`: delta-seconds or an HTTP-date. Returns milliseconds.
 *
 * `now` is passed rather than read so the HTTP-date branch is testable without freezing the
 * clock globally. A value that is absent, unparseable or already in the past returns
 * `undefined` — "the provider told us nothing useful" — rather than 0, which would read as
 * "the provider said go now" and override a perfectly good backoff with no wait at all.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
