/**
 * Wire-neutral transcript types, shared by the engine, the exporters and the editor.
 *
 * **Integer milliseconds everywhere.** Float seconds is where frame-off errors live: they
 * accumulate across 65 chunk offsets and they compare badly. Conversion happens exactly
 * once, in a provider's parse step, with `Math.round`. Any float seconds surviving past
 * that is a bug.
 */

export type RunMode = 'sync' | 'sync_chunked' | 'batch';

/**
 * How much of the word-timing spine a run actually has.
 *
 * `full` every non-empty segment carries words · `partial` some do · `none` none do.
 * A run's quality is the *minimum* across its chunks — one wordless chunk means callers
 * cannot assume word timings anywhere without checking per segment.
 */
export type WordTimingQuality = 'full' | 'partial' | 'none';

export const WORD_TIMING_RANK: Record<WordTimingQuality, number> = {
  none: 0,
  partial: 1,
  full: 2,
};

/** The minimum of two qualities — how a run rolls up its chunks. */
export function minWordTimingQuality(
  a: WordTimingQuality,
  b: WordTimingQuality,
): WordTimingQuality {
  return WORD_TIMING_RANK[a] <= WORD_TIMING_RANK[b] ? a : b;
}

export interface Word {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  /**
   * `null` means the provider does not measure word confidence. It must never be written
   * as `0`, or every word from such a provider sorts as maximally uncertain and the
   * low-confidence QA query returns the entire transcript.
   */
  confidence: number | null;
  speakerId?: string | null;
  /**
   * True only for timings we derived rather than received. Phase 1 never persists an
   * estimated word — interpolation happens at read time (see `timing/interpolate.ts`).
   */
  isEstimated?: boolean;
}

export interface Segment {
  idx: number;
  startMs: number;
  endMs: number;
  /** Normalized verbatim ASR output. Immutable — human edits land in `segment_texts`. */
  text: string;
  /** Exactly what the provider returned, pre-normalizer. Never re-derived. */
  textRaw: string;
  confidence: number | null;
  /** False ⇒ every consumer must use the interpolation fallback, and say that it did. */
  hasWords: boolean;
  words: Word[];
  chunkIdx?: number | null;
  speakerId?: string | null;
}

/** Editorial layers, addressed by `(segment, layer, targetLang)`. */
export type Layer = 'verbatim' | 'cleaned' | 'translated' | 'entity_corrected';
export type TextOrigin = 'asr' | 'llm' | 'human' | 'rule';

export interface SegmentText {
  segmentId: string;
  layer: Layer;
  /** `''` for everything except translations — never null. See the schema for why. */
  targetLang: string;
  origin: TextOrigin;
  text: string;
}

/** A non-fatal problem worth showing the operator. Carried in the CLI JSON and the UI. */
export interface Warning {
  code:
    | 'seam_low_confidence'
    | 'seam_hard_cut'
    | 'no_word_timings'
    | 'segment_without_timing'
    | 'chunk_failed'
    | 'duration_unknown';
  message: string;
  chunk?: number;
  segment?: number;
}
