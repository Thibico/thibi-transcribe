import type { ProviderLanguageCapability } from '@thibi/languages';
import { classifyLanguage } from './classify.js';
import { ProbeAbort, type ProbeOutcome, type ProbeProvider } from './types.js';

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full jitter: sleep a random amount in [0, base * 2^attempt), capped at a minute. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(60_000, 1000 * 2 ** attempt);
}

/**
 * Spaces request starts across every worker. Google's quota is per project and Groq's is
 * per organization, so throttling per worker would not throttle anything.
 */
function createThrottle(minIntervalMs: number | undefined) {
  if (!minIntervalMs) return async (): Promise<void> => {};
  let nextSlot = 0;
  return async (): Promise<void> => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minIntervalMs;
    if (slot > now) await sleep(slot - now);
  };
}

async function probeWithRetry(
  provider: ProbeProvider,
  input: { code: string; model: string; clip: Buffer },
  waitForSlot: () => Promise<void>,
): Promise<ProbeOutcome> {
  let last: ProbeOutcome = { httpStatus: 0, transcript: '', hasWords: null };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForSlot();
    try {
      last = await provider.probe(input);
    } catch (err) {
      // A transport failure is indistinguishable from a 5xx for our purposes: unknown.
      last = { httpStatus: 0, transcript: '', hasWords: null, errorMessage: String(err) };
    }

    // A misconfigured key must never be allowed to write a file full of rejections.
    if (last.httpStatus === 401 || last.httpStatus === 403) {
      throw new ProbeAbort(
        `${provider.id} returned ${last.httpStatus} for ${input.code}. ` +
          `Check the credentials before re-running — aborting without writing anything.`,
      );
    }
    if (!RETRYABLE.has(last.httpStatus) && last.httpStatus !== 0) return last;
    if (attempt < MAX_ATTEMPTS - 1) {
      // A provider that tells us how long to wait knows better than our backoff curve.
      await sleep(last.retryAfterMs ?? backoffMs(attempt));
    }
  }
  return last;
}

export interface RunProviderOptions {
  provider: ProbeProvider;
  codes: readonly string[];
  clip: Buffer;
  concurrency: number;
  probedAt: string;
  adaptation: ProviderLanguageCapability['adaptation'];
  previous: Record<string, ProviderLanguageCapability | undefined>;
  onProgress?: (done: number, total: number, code: string, status: string) => void;
}

export interface RunProviderResult {
  rows: Record<string, ProviderLanguageCapability>;
  counts: { accepted: number; rejected: number; unknown: number; errored: number };
  needsReview: string[];
}

export async function runProvider(options: RunProviderOptions): Promise<RunProviderResult> {
  const { provider, codes, clip, probedAt, adaptation, previous } = options;

  const rows: Record<string, ProviderLanguageCapability> = {};
  const counts = { accepted: 0, rejected: 0, unknown: 0, errored: 0 };
  const needsReview: string[] = [];

  const waitForSlot = createThrottle(provider.minIntervalMs);
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= codes.length) return;
      const code = codes[index]!;

      const attempts: Array<{ model: string; outcome: ProbeOutcome }> = [];
      for (const model of provider.models) {
        const outcome = await probeWithRetry(provider, { code, model, clip }, waitForSlot);
        attempts.push({ model, outcome });
        // One acceptance is enough: the remaining models cannot change the verdict, and
        // skipping them halves the OpenAI bill.
        if (outcome.httpStatus >= 200 && outcome.httpStatus < 300) break;
      }

      const row = classifyLanguage({
        providerCode: provider.providerCode(code),
        probedAt,
        adaptation,
        attempts,
        previous: previous[code],
      });
      rows[code] = row;

      if (row.status === 'accepted') counts.accepted++;
      else if (row.status === 'rejected') counts.rejected++;
      else if (row.status === 'error') {
        counts.errored++;
        needsReview.push(`${code}: HTTP ${row.httpStatus} ${row.errorMessage ?? ''}`.trim());
      } else {
        counts.unknown++;
        needsReview.push(`${code}: no verdict after ${MAX_ATTEMPTS} attempts`);
      }

      options.onProgress?.(++done, codes.length, code, row.status);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return { rows, counts, needsReview };
}
