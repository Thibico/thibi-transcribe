import type { Clock } from './context.js';
import { AbortedError, EngineError, isRetryable } from './errors.js';
import { POLICY } from './queue/retry.js';
import type { StepKind } from './queue/queues.js';

/**
 * Retry with **full jitter**.
 *
 * Generalises `withRetry`/`RETRYABLE` from `lib/queue.ts:52-69`. The old policy was a fixed
 * `[2000, 4000, 8000]`, which means eight chunks that all hit the same 429 retry in
 * lockstep and re-trigger it — the failure mode the backoff was supposed to prevent. Full
 * jitter (`delay = random(0, min(cap, base · 2^attempt))`) spreads them out.
 *
 * `Retry-After` overrides the computed delay whenever the provider supplied one: it knows
 * when its window resets and we do not.
 *
 * Phase 9 moves the policy table onto `run_steps` so retries are visible in the UI; this
 * function stays.
 */

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  capMs: number;
}

/**
 * The five kinds the CLI drives in one process, **derived from `queue/retry.ts`'s `POLICY`**
 * rather than restated here.
 *
 * These were two hand-maintained tables until Phase 9, and they had already drifted: this one
 * capped `asr.chunk` at 30 s and `diarize` at 60 s where the phase-9 table says 120 s and
 * 300 s. Neither number came from a measurement — the overview specifies attempts and base
 * delay per kind and never specified a cap, so each file invented one. Derivation makes the
 * question "which table is right?" unaskable, which is the only durable answer to it.
 *
 * The remaining ten kinds are not listed because nothing in-process retries them; the queue
 * does, from the same source.
 */
export const RETRY_POLICIES = {
  'media.normalize': fromPolicy('media.normalize'),
  'asr.chunk': fromPolicy('asr.chunk'),
  'asr.batch.submit': fromPolicy('asr.batch.submit'),
  diarize: fromPolicy('diarize'),
  'editorial.pass': fromPolicy('editorial.pass'),
} satisfies Record<string, RetryPolicy>;

export type RetryKind = keyof typeof RETRY_POLICIES;

function fromPolicy(kind: StepKind): RetryPolicy {
  const spec = POLICY[kind];
  return { attempts: spec.maxAttempts, baseMs: spec.baseMs, capMs: spec.capMs };
}

export interface RetryOptions {
  policy: RetryPolicy;
  clock: Clock;
  signal?: AbortSignal;
  /** Called before each sleep, for logging and progress. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests. Defaults to Math.random. */
  random?: () => number;
}

export function fullJitterDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { policy, clock, signal } = options;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    if (signal?.aborted) throw new AbortedError();
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
      if (attempt === policy.attempts - 1) break;

      // The provider knows when its window resets; our curve is only a guess.
      const retryAfter = err instanceof EngineError ? err.retryAfterMs : undefined;
      const delayMs = retryAfter ?? fullJitterDelay(attempt, policy, random);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await clock.sleep(delayMs, signal);
    }
  }
  throw lastError;
}

/** The real clock. Tests use a FakeClock whose sleep resolves immediately. */
export function systemClock(): Clock {
  return {
    now: () => new Date(),
    async sleep(ms, signal) {
      if (ms <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new AbortedError());
        };
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(new AbortedError());
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
