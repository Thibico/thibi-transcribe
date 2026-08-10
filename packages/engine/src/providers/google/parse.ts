import type { WordTimingQuality } from '@thibi/core';
import type { ProviderSegment, ProviderWord, TranscribeResult } from '../types.js';

/**
 * Parse a Speech-to-Text v2 `recognize` response.
 *
 * This is the change the overview singles out. `lib/providers/google.ts:207-221` read
 * `words[0].startOffset` and `words[last].endOffset` to bound the segment, then threw the
 * word array away — discarding the timings and confidences that half this design depends
 * on. Here **the word array is the output**.
 */

interface RawWord {
  word?: string;
  startOffset?: string | { seconds?: number | string; nanos?: number };
  endOffset?: string | { seconds?: number | string; nanos?: number };
  confidence?: number;
  speakerLabel?: string;
}

interface RawAlternative {
  transcript?: string;
  confidence?: number;
  words?: RawWord[];
}

interface RawResult {
  alternatives?: RawAlternative[];
  resultEndOffset?: string | { seconds?: number | string; nanos?: number };
}

export interface RecognizeResponse {
  results?: RawResult[];
}

/**
 * Parse a duration to integer milliseconds.
 *
 * Ported from `google.ts:36-41`, which handled only the `"1.500s"` string form. The
 * protobuf-JSON object form `{seconds, nanos}` is handled too: spike S3 confirmed sync uses
 * the string form, but batch output has historically differed and adding the branch now
 * costs nothing while discovering it in Phase 2 would be expensive.
 *
 * Rounding to integer milliseconds happens exactly here, once. Any float seconds surviving
 * past this function is a bug.
 */
export function parseOffsetMs(value: RawWord['startOffset']): number | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'string') {
    const seconds = Number.parseFloat(value.endsWith('s') ? value.slice(0, -1) : value);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  }

  if (typeof value === 'object') {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return Math.round(seconds * 1000 + nanos / 1e6);
  }

  return null;
}

export interface ParseOptions {
  /** Absolute position of this chunk in the source file. Added to every timestamp. */
  offsetMs: number;
  /** Extracted length, used to bound a segment with no timing at all. */
  durationMs: number;
}

/**
 * The three-tier timestamp fallback survives from the original, but it is **recorded
 * rather than silent**:
 *
 * | condition                             | segment timing              | hasWords | quality |
 * |---------------------------------------|-----------------------------|----------|---------|
 * | words present with offsets            | first word → last word      | true     | full    |
 * | words absent, resultEndOffset present | previous end → resultEnd    | false    | none    |
 * | neither                               | previous end → chunk end    | false    | none + warning |
 */
export function parseRecognizeResponse(
  body: RecognizeResponse,
  options: ParseOptions,
): TranscribeResult {
  const { offsetMs, durationMs } = options;
  const segments: ProviderSegment[] = [];
  const warnings: Array<{ code: string; message: string }> = [];

  let withWords = 0;
  let withoutWords = 0;
  let cursorMs = offsetMs;

  for (const result of body.results ?? []) {
    const alternative = result.alternatives?.[0];
    const text = (alternative?.transcript ?? '').trim();
    if (text.length === 0) continue;

    // `hasOffsets` distinguishes "the provider said 0 ms" from "the provider said
    // nothing", which decides whether this segment counts toward `full` or `none`. It is
    // local bookkeeping and never reaches the caller.
    const words: Array<ProviderWord & { hasOffsets: boolean }> = (alternative?.words ?? [])
      .map((w) => {
        const start = parseOffsetMs(w.startOffset);
        const end = parseOffsetMs(w.endOffset);
        return {
          startMs: offsetMs + (start ?? 0),
          endMs: offsetMs + (end ?? start ?? 0),
          text: w.word ?? '',
          // null, never 0: an unmeasured confidence must not sort as maximally uncertain.
          confidence: typeof w.confidence === 'number' ? w.confidence : null,
          speakerTag: w.speakerLabel ?? null,
          hasOffsets: start !== null || end !== null,
        };
      })
      .filter((w) => w.text.length > 0);

    const usable = words.filter((w) => w.hasOffsets);
    const segmentConfidence =
      typeof alternative?.confidence === 'number' ? alternative.confidence : null;

    if (usable.length > 0) {
      const startMs = usable[0]!.startMs;
      const endMs = Math.max(...usable.map((w) => w.endMs));
      segments.push({
        startMs,
        endMs,
        text,
        confidence: segmentConfidence,
        words: words.map(({ hasOffsets: _drop, ...w }) => w),
      });
      cursorMs = endMs;
      withWords++;
      continue;
    }

    // No usable word timings. Bound the segment as well as we can and record that we did.
    const resultEnd = parseOffsetMs(result.resultEndOffset);
    const endMs = resultEnd !== null ? offsetMs + resultEnd : offsetMs + durationMs;
    if (resultEnd === null) {
      warnings.push({
        code: 'segment_without_timing',
        message:
          `A segment carried neither word offsets nor a result end offset; its interval is ` +
          `the remainder of the chunk. Subtitle timing for it will be interpolated.`,
      });
    }
    segments.push({
      startMs: cursorMs,
      endMs: Math.max(cursorMs, endMs),
      text,
      confidence: segmentConfidence,
      words: [],
    });
    cursorMs = Math.max(cursorMs, endMs);
    withoutWords++;
  }

  const wordTimingQuality: WordTimingQuality =
    withWords === 0 ? 'none' : withoutWords === 0 ? 'full' : 'partial';

  if (wordTimingQuality !== 'full' && segments.length > 0) {
    warnings.push({
      code: 'no_word_timings',
      message:
        wordTimingQuality === 'none'
          ? 'The provider returned no word offsets for this chunk; word timings will be interpolated.'
          : `${withoutWords} of ${segments.length} segments came back without word offsets.`,
    });
  }

  return {
    segments,
    wordTimingQuality,
    usage: { audioMs: durationMs, requests: 1 },
    raw: body,
    warnings,
  };
}
