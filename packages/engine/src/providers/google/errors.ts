import {
  ChunkTooLargeError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnsupportedLanguageError,
} from '../../errors.js';

/**
 * Classify a Google STT error response.
 *
 * Ported from `lib/providers/google.ts:131-152`, keeping the principle that made it good —
 * **surface Google's own message rather than a bare status code** — and deleting the part
 * that made it harmful.
 *
 * `:139-141` appended "check the region: Chirp 2 and Burmese only overlap in
 * asia-southeast1 and europe-west4" to every INVALID_ARGUMENT mentioning a model or
 * language. That is a false statement: the 2026-07-30 probe accepted all 117 locale codes
 * in asia-southeast1, europe-west4 *and* us-central1, and spike S3 got identical correct
 * Burmese from all three on 2026-08-09. It sent operators to re-check a setting that was
 * never the problem. A test asserts no message from this module names a region.
 */

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function toProviderError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  let detail = body.slice(0, 500);
  let status: string | undefined;

  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) {
      detail = parsed.error.message;
      status = parsed.error.status;
    }
  } catch {
    /* keep the raw body */
  }

  const message = `Google STT ${response.status}: ${detail || response.statusText}`;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (response.status === 429 || response.status === 503) {
    return new RateLimitedError(message, retryAfterMs !== undefined ? { retryAfterMs } : {});
  }
  if (response.status >= 500) {
    return new ProviderUnavailableError(message);
  }
  if (response.status === 401 || response.status === 403) {
    return new NotConfiguredError(message, {
      hint: 'Check the service account has roles/speech.client on this project.',
    });
  }
  if (response.status === 413 || /too large|exceeds/i.test(detail)) {
    // Not retryable as-is, but the planner re-cuts this one chunk at half length and
    // tries once more: a bitrate spike mid-file should not fail a three-hour run.
    return new ChunkTooLargeError(message);
  }
  if (response.status === 400 && status === 'INVALID_ARGUMENT' && /language|model/i.test(detail)) {
    return new UnsupportedLanguageError(message, {
      hint:
        'The provider matrix may be stale — re-run `thibi probe languages --provider google` ' +
        'and check the language is still accepted.',
    });
  }
  return new ProviderError(message, response.status);
}
