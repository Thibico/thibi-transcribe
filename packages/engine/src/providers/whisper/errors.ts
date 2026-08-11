import {
  ChunkTooLargeError,
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
  UnsupportedLanguageError,
} from '../../errors.js';

/**
 * Classify an OpenAI / Groq error response.
 *
 * A second envelope shape on the same taxonomy as `google/errors.ts`, and the same
 * principle: **the provider's own message travels verbatim**. OpenAI says
 * `Language 'my' is not supported.` — a better sentence than anything we could substitute,
 * and the probe's 44-code exclusive set is built out of exactly that string.
 *
 * ```json
 * { "error": { "message": "…", "type": "invalid_request_error", "code": "…" } }
 * ```
 */

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  // Groq sends durations like `7.66s` and `2m59.56s` rather than bare seconds.
  const duration = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(header.trim());
  if (duration && (duration[1] || duration[2])) {
    return Math.max(0, (Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0)) * 1000);
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Groq's rate-limit headers, captured so Phase 9's shared token bucket has real numbers to
 * be designed against rather than a guess at the tier limits.
 *
 * Phase 4 only reads and logs them. Building the bucket here would be building it blind.
 */
export interface RateLimitSnapshot {
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitAudioSeconds?: string;
  remainingAudioSeconds?: string;
  resetAudioSeconds?: string;
}

export function readRateLimitHeaders(headers: Headers): RateLimitSnapshot | null {
  const snapshot: RateLimitSnapshot = {};
  const pairs: Array<[keyof RateLimitSnapshot, string]> = [
    ['limitRequests', 'x-ratelimit-limit-requests'],
    ['remainingRequests', 'x-ratelimit-remaining-requests'],
    ['resetRequests', 'x-ratelimit-reset-requests'],
    ['limitAudioSeconds', 'x-ratelimit-limit-audio-seconds'],
    ['remainingAudioSeconds', 'x-ratelimit-remaining-audio-seconds'],
    ['resetAudioSeconds', 'x-ratelimit-reset-audio-seconds'],
  ];
  for (const [key, header] of pairs) {
    const value = headers.get(header);
    if (value !== null) snapshot[key] = value;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

export interface WhisperErrorContext {
  /** 'OpenAI' / 'Groq'. Prefixes the message so a log line names the provider. */
  label: string;
  /** The env var an operator has to set, named in the 401 hint. */
  envVar: string;
}

export async function toWhisperError(
  response: Response,
  context: WhisperErrorContext,
): Promise<Error> {
  const body = await response.text().catch(() => '');
  let detail = body.slice(0, 500);
  let code: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string; code?: string };
    };
    if (parsed.error?.message) {
      detail = parsed.error.message;
      code = parsed.error.code ?? parsed.error.type;
    }
  } catch {
    /* keep the raw body */
  }

  const message = `${context.label} ${response.status}: ${detail || response.statusText}`;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (response.status === 429) {
    return new RateLimitedError(message, retryAfterMs !== undefined ? { retryAfterMs } : {});
  }
  if (response.status >= 500) {
    return new ProviderUnavailableError(
      message,
      retryAfterMs !== undefined ? { retryAfterMs } : {},
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new NotConfiguredError(message, {
      hint: `Set ${context.envVar} to a key with access to the transcription endpoint.`,
    });
  }
  // 413, and the 400 that OpenAI actually returns for an oversized upload. Not retryable as
  // sent, but re-plannable: the planner re-cuts this one chunk at half length. The byte
  // budget is derived from the measured bitrate, so this fires on a density spike, not on a
  // systematically wrong constant.
  if (response.status === 413 || /maximum content size|too large|file is too big/i.test(detail)) {
    return new ChunkTooLargeError(message);
  }
  if (response.status === 400 && /language/i.test(detail)) {
    return new UnsupportedLanguageError(message, {
      hint:
        `The provider matrix is a dated snapshot and providers do widen their language ` +
        `lists. Re-run \`thibi probe languages --provider ${context.label.toLowerCase()}\` ` +
        `to check.`,
    });
  }
  return new ProviderError(message, response.status, code ? { hint: `code: ${code}` } : {});
}
