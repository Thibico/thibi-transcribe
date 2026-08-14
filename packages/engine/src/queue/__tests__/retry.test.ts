import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  LeaseLostError,
  NonRetryableError,
  RateLimitedError,
  isRetryable,
} from '../../errors.js';
import { RETRY_POLICIES } from '../../retry.js';
import { MAX_RETRY_AFTER_MS, POLICY, backoffMs, parseRetryAfter, type RetrySpec } from '../retry.js';
import { STEP_KINDS } from '../queues.js';

const JITTERED: RetrySpec = { maxAttempts: 5, baseMs: 2_000, capMs: 120_000, jitter: true };
const FLAT: RetrySpec = { maxAttempts: 3, baseMs: 30_000, capMs: 60_000, jitter: false };

describe('backoffMs', () => {
  it('grows exponentially and stops at the cap', () => {
    expect(backoffMs(FLAT, 0)).toBe(30_000);
    expect(backoffMs(FLAT, 1)).toBe(60_000);
    // 30s · 2^5 = 960s, and the cap is what the caller actually waits.
    expect(backoffMs(FLAT, 5)).toBe(60_000);
  });

  it('spreads full jitter across the whole window, not a band around it', () => {
    // The property that matters is decorrelation. Eight chunks that hit one 429 together
    // must not wake together, and capped-exponential-with-±10%-noise leaves them in a tight
    // cluster that re-triggers the limit — which is the failure the old fixed
    // [2000, 4000, 8000] schedule had.
    const attempt = 3;
    const ceiling = Math.min(JITTERED.capMs, JITTERED.baseMs * 2 ** attempt); // 16 000
    const samples = Array.from({ length: 10_000 }, () => backoffMs(JITTERED, attempt));

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean, 'full jitter has mean ceiling/2').toBeGreaterThan(ceiling * 0.45);
    expect(mean).toBeLessThan(ceiling * 0.55);

    // Occupancy across the range, which a ±10% band would fail outright.
    expect(Math.min(...samples)).toBeLessThan(ceiling * 0.05);
    expect(Math.max(...samples)).toBeGreaterThan(ceiling * 0.95);
    expect(new Set(samples).size, 'variance > 0').toBeGreaterThan(1000);
  });

  it('never jitters when the spec says not to', () => {
    const samples = new Set(Array.from({ length: 100 }, () => backoffMs(FLAT, 1)));
    expect(samples).toEqual(new Set([60_000]));
  });

  it('treats Retry-After as a floor and never as a ceiling', () => {
    // The provider knows when its window resets and our curve is a guess, so a longer hint
    // wins. A *shorter* one must not shorten a backoff we chose for our own reasons —
    // obeying it would turn a well-spread retry into a stampede.
    expect(backoffMs(JITTERED, 0, 120_000, () => 0.5)).toBe(120_000);
    expect(backoffMs(FLAT, 1, 1_000)).toBe(60_000);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-08-14T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter('  30  ', NOW)).toBe(30_000);
  });

  it('reads an HTTP-date', () => {
    expect(parseRetryAfter('Fri, 14 Aug 2026 12:02:00 GMT', NOW)).toBe(120_000);
  });

  it('clamps a wait long enough to be indistinguishable from a hang', () => {
    // A 40-minute wait, obeyed three times, produces no output, no error, and a job killed
    // at the CI timeout having measured nothing. Past the ceiling the hint is dropped, the
    // budget is spent quickly, and the step fails carrying the provider's own message —
    // which is information, where silence is not.
    expect(parseRetryAfter('99999', NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('says nothing rather than zero when the header is useless', () => {
    // undefined means "no useful hint" and leaves the computed backoff alone. Returning 0
    // would read as "the provider said go now" and erase the wait entirely.
    for (const header of [null, undefined, '', '   ', 'soon', '-5', '0']) {
      expect(parseRetryAfter(header, NOW), `header: ${JSON.stringify(header)}`).toBeUndefined();
    }
    expect(parseRetryAfter('Fri, 14 Aug 2026 11:59:00 GMT', NOW), 'already past').toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('follows the taxonomy first', () => {
    expect(isRetryable(new RateLimitedError('429'))).toBe(true);
    expect(isRetryable(new NonRetryableError('deadline exceeded'))).toBe(false);
  });

  it('does not retry a cancellation', () => {
    // Without this rule, cancelling a run schedules five more attempts of the thing that was
    // just cancelled.
    expect(isRetryable(new AbortedError())).toBe(false);
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isRetryable(abort)).toBe(false);
  });

  it('does not retry a stolen lease', () => {
    // The step is already running on another worker. Retrying is how a resurrected step and
    // its zombie predecessor both write segments and the run ends up with duplicates.
    expect(isRetryable(new LeaseLostError('step-1'))).toBe(false);
  });

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [413, false],
  ])('classifies a bare status %i as retryable=%s', (status, expected) => {
    expect(isRetryable({ status })).toBe(expected);
  });

  it('reads undici failures off err.code, which the message never mentions', () => {
    // The gap that motivated widening this predicate: every connect and headers timeout from
    // fetch carries its code on `.code` and a generic message, so a message-only regex
    // classified the most common transient failure in the project as permanent.
    expect(isRetryable(Object.assign(new Error('fetch failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false);
  });

  it('still matches the legacy message shapes', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(new Error('getaddrinfo EAI_AGAIN api.example'))).toBe(true);
    expect(isRetryable(new Error('something went wrong'))).toBe(false);
  });
});

describe('POLICY', () => {
  it('covers every step kind', () => {
    // A kind with no policy would fall through to `undefined` and take its `maxAttempts` from
    // nowhere — a step that either never retries or crashes the planner.
    expect(Object.keys(POLICY).sort()).toEqual([...STEP_KINDS].sort());
  });

  it('is the only table — the in-process one derives from it', () => {
    // These were two hand-maintained tables that had already drifted apart (asr.chunk capped
    // at 30s in one and 120s in the other, neither number measured). Derivation is what makes
    // "which one is right?" an unaskable question.
    for (const [kind, policy] of Object.entries(RETRY_POLICIES)) {
      const spec = POLICY[kind as keyof typeof POLICY];
      expect(policy, kind).toEqual({
        attempts: spec.maxAttempts,
        baseMs: spec.baseMs,
        capMs: spec.capMs,
      });
    }
  });
});
