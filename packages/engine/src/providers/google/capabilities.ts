import type { ProviderCapabilities } from '../types.js';

/**
 * Google Speech-to-Text v2 capabilities.
 *
 * **Every value here is a fact with a provenance.** Two of them are literals traceable to a
 * row in `spikes/RESULTS.md`, with the date, because guessing either one would put a false
 * claim into the product.
 */

/**
 * Spike S1, 2026-08-09 — **FAIL**. `chirp_2` does not honour speech adaptation.
 *
 * Boost 0, 10 and 20 produced byte-identical output; relevant keyterms produced zero
 * lexical change and did not fix the targeted error; and an *irrelevant* phrase set
 * corrupted အာဆီယံ into အာစီယံ in all five occurrences of a word the baseline got right.
 * Supplying a phrase set is therefore not free — a stale glossary makes output worse.
 *
 * The engine must never send `config.adaptation` to Chirp, no UI may render a boost
 * control for it, and nothing in the product may promise keyterm biasing on Google. The
 * glossary entity pass in Phase 6 is the *only* entity mechanism for the exclusive-language
 * set. Re-measure if the model changes; `spikes/s1-adaptation.mjs` is the instrument.
 */
export const S1_ADAPTATION = 'none' as const;

/**
 * Spike S2, 2026-08-09 — **PASS**. Word confidence is genuine, not a placeholder.
 *
 * 101/101 words carried a confidence over 0.728–0.99 with **101 distinct values**, and
 * 101/101 carried both start and end offsets. Confirmed across a ten-language long-tail
 * sample on 2026-08-09, and the 116-code probe the same day found word offsets present for
 * every Google language.
 *
 * The signal is also calibrated: the same Burmese clip read as Zulu scores 0.128–0.333 and
 * read as Burmese 0.738–0.973. That is what makes the Phase 12 uncertain-word toolbar worth
 * building, and gives its 0.6 threshold an empirical basis.
 */
export const S2_WORD_CONFIDENCE = true as const;

export const DEFAULT_MODEL = 'chirp_2';

/**
 * Spike S5, 2026-08-10 — the Dynamic Batch rate advantage is real, and it is the only reason
 * `batch` exists in `modes` below.
 *
 * Read from the Cloud Billing Catalog rather than from documentation: `Cloud Speech-to-Text
 * Recognition` $0.016/min against `Cloud Speech-to-Text Dynamic Batch Recognition`
 * $0.003/min. **5.33×.** Spike S3 had already measured batch at a flat 5.9× realtime against
 * chunked sync's 3.6–7× advantage, which removed latency as a reason to use it; had the rate
 * not held, batch would have had no justification at all and this phase would not exist.
 *
 * These are provenance, not the operative numbers. Costing reads the `rates` table, because
 * Google changes prices and an admin must be able to correct one without a deploy.
 */
export const S5_SYNC_USD_PER_MINUTE = 0.016;
export const S5_BATCH_USD_PER_MINUTE = 0.003;

export function googleCapabilities(_model: string = DEFAULT_MODEL): ProviderCapabilities {
  return {
    // `batch` is reachable only through an explicit `force` — nothing about a file's
    // duration routes to it. S3 measured chunked sync faster at every size, so this is a
    // cost choice a human makes, and `planMode` refuses to make it for them.
    modes: ['sync', 'sync_chunked', 'batch'],
    wordTimestamps: true,
    wordConfidence: S2_WORD_CONFIDENCE,
    segmentConfidence: true,
    diarization: 'none',
    adaptation: S1_ADAPTATION,
    languageDetection: false,
    limits: {
      // google.ts:18
      syncMaxBytes: 10 * 1024 * 1024,
      // google.ts:19 — margin under the 60s ceiling
      syncMaxSeconds: 55,
      // Spike S3: 136 sync requests at concurrency 8 produced zero 429s and zero retries.
      // The outbound token bucket that makes this safe across containers is Phase 9; until
      // then two CLIs running at once can self-429.
      maxConcurrentRequests: 8,
      rpm: 300,
    },
    // The batch path needs a GCS bucket co-located with the recognizer. Declaring it here
    // is what lets `planMode` say "this provider could batch if you gave it a bucket"
    // without knowing anything about Google.
    staging: 'gcs',
  };
}
