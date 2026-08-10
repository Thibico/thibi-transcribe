import { describe, expect, it } from 'vitest';
import {
  ChunkTooLargeError,
  type EngineError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnsupportedLanguageError,
} from '../../../errors.js';
import { toProviderError } from '../errors.js';

function googleError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

const invalidArgument = (message: string) => ({
  error: { code: 400, status: 'INVALID_ARGUMENT', message },
});

describe('toProviderError', () => {
  it.each([
    [429, { error: { message: 'Quota exceeded' } }, RateLimitedError, true],
    [503, { error: { message: 'Service unavailable' } }, RateLimitedError, true],
    [500, { error: { message: 'Internal error' } }, ProviderUnavailableError, true],
    [502, { error: { message: 'Bad gateway' } }, ProviderUnavailableError, true],
    [401, { error: { message: 'Invalid credentials' } }, NotConfiguredError, false],
    [403, { error: { message: 'Permission denied' } }, NotConfiguredError, false],
    [418, { error: { message: "I'm a teapot" } }, ProviderError, false],
  ])('classifies %i', async (status, body, expected, retryable) => {
    const err = await toProviderError(googleError(status, body));
    expect(err).toBeInstanceOf(expected);
    expect((err as EngineError).retryable).toBe(retryable);
  });

  it('classifies an unsupported language and points at the probe, not at a guess', async () => {
    const err = await toProviderError(
      googleError(400, invalidArgument("Invalid value at 'config.language_codes'")),
    );
    expect(err).toBeInstanceOf(UnsupportedLanguageError);
    // The matrix is a dated snapshot and a provider changing its list is a normal event.
    expect((err as UnsupportedLanguageError).hint).toMatch(/probe languages/);
  });

  it('classifies an oversized chunk as re-plannable', async () => {
    const err = await toProviderError(
      googleError(400, { error: { message: 'Request payload size exceeds the limit' } }),
    );
    expect(err).toBeInstanceOf(ChunkTooLargeError);
    // The planner re-cuts that one chunk at half length rather than failing the run.
    expect((err as ChunkTooLargeError).replannable).toBe(true);
  });

  it('honours Retry-After', async () => {
    const err = await toProviderError(
      googleError(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
    );
    expect((err as RateLimitedError).retryAfterMs).toBe(7000);
  });

  it("surfaces Google's own message rather than a bare status code", async () => {
    const err = await toProviderError(
      googleError(400, { error: { message: 'Something specific and useful' } }),
    );
    expect(err.message).toContain('Something specific and useful');
  });

  it('keeps the raw body when it is not JSON', async () => {
    const err = await toProviderError(googleError(500, '<html>gateway timeout</html>'));
    expect(err.message).toContain('gateway timeout');
  });

  /**
   * `google.ts:139-141` appended "check the region: Chirp 2 and Burmese only overlap in
   * asia-southeast1 and europe-west4" to every INVALID_ARGUMENT naming a model or language.
   *
   * That is a false statement — the 2026-07-30 probe accepted all 117 locale codes in
   * asia-southeast1, europe-west4 *and* us-central1, and spike S3 got identical correct
   * Burmese from all three on 2026-08-09. It sent operators to re-check a setting that was
   * never the problem. This test is what stops it coming back.
   */
  it('never names a GCP region in any message it produces', async () => {
    const cases = [
      googleError(400, invalidArgument('Invalid model for language my-MM')),
      googleError(400, invalidArgument('Unsupported language code')),
      googleError(429, { error: { message: 'quota' } }),
      googleError(403, { error: { message: 'denied' } }),
      googleError(500, 'boom'),
    ];
    for (const response of cases) {
      const err = await toProviderError(response);
      const text = `${err.message} ${(err as EngineError).hint ?? ''}`;
      expect(text).not.toMatch(/asia-southeast1|europe-west4|us-central1/);
    }
  });
});
