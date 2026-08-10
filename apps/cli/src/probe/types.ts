import type { ProviderId } from '@thibi/languages';

/** What one request to one provider, for one language code, actually returned. */
export interface ProbeOutcome {
  httpStatus: number;
  /** Non-empty transcript text, if any. Empty is normal — the clip is Burmese. */
  transcript: string;
  /**
   * Whether the response carried a non-empty word array.
   *
   * `null` when the transcript was empty, because silence tells us nothing about whether
   * this code *would* return word offsets. Recording that as `false` would manufacture a
   * finding out of an absence, and word timings are the spine of half the design.
   */
  hasWords: boolean | null;
  errorMessage?: string;
  /** From a `Retry-After` header, when the provider told us how long to wait. */
  retryAfterMs?: number;
}

/** `Retry-After` is either delay-seconds or an HTTP date. Both are worth honouring. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export interface ProbeProvider {
  id: ProviderId;
  /** Probed in order. A code counts as accepted if any model accepts it. */
  models: string[];
  /** Groq and OpenAI rate-limit aggressively; Google's default quota is 300 rpm. */
  defaultConcurrency: number;
  /**
   * Minimum spacing between request starts, across all workers.
   *
   * Groq's on-demand tier allows 20 requests per minute for `whisper-large-v3`, and a
   * probe that ignores that turns 55 of 116 languages into `unknown` — which the
   * classifier correctly refuses to record as rejections, leaving the matrix with holes
   * instead of data. Self-throttling below the published limit is what actually gets the
   * measurement.
   */
  minIntervalMs?: number;
  /** Registry code -> the code to actually send. 'my-MM' for Google, 'my' for Whisper. */
  providerCode(code: string): string;
  /** A configuration problem must be found before the first request, not during. */
  configure(): Promise<void>;
  probe(input: { code: string; model: string; clip: Buffer }): Promise<ProbeOutcome>;
}

/** Thrown for 401/403 and for missing configuration: abort the run, write nothing. */
export class ProbeAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeAbort';
  }
}
