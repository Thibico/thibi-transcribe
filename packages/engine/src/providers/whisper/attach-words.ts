import type { ProviderSegment, ProviderWord } from '../types.js';

/**
 * Re-attach Whisper's flat `words[]` array to its segments.
 *
 * **This is the biggest structural difference between the Whisper HTTP shape and Google's.**
 * Google nests each word inside the alternative it belongs to; `verbose_json` returns
 * `segments[]` and `words[]` as two independent top-level arrays with no key joining them —
 * only their timestamps. Rebuilding that relationship is the likeliest place in the whole
 * adapter for an off-by-one, which is why it is a module with its own tests rather than a
 * loop inside the parser.
 *
 * Inputs are already in integer milliseconds. The float-seconds → ms rounding happens once,
 * in `parse.ts`, so nothing here has to think about `0.29999999999999993`.
 */

/** A segment with no words yet. */
export interface TimedSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface TimedWord {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface AttachResult {
  segments: ProviderSegment[];
  /**
   * Words that landed in no segment. **Returned, not dropped.** Silently discarding them
   * would make a parser bug look like a provider that returned fewer words, and the count
   * reaches `usage.wordsUnattached` and the run log precisely so it cannot.
   */
  unattached: TimedWord[];
}

/**
 * 20 ms of slack on both edges.
 *
 * Whisper's segment bounds and its word bounds come out of two different alignment passes,
 * so a word can start a hair before the segment that contains it or a hair after the one
 * before it ends. Without tolerance those words orphan; with far more than this, a word in a
 * gap gets pulled into a segment it does not belong to.
 */
export const DEFAULT_EPS_MS = 20;

export function attachWords(
  segments: readonly TimedSegment[],
  words: readonly TimedWord[],
  options: { epsMs?: number } = {},
): AttachResult {
  const eps = options.epsMs ?? DEFAULT_EPS_MS;
  const buckets: ProviderWord[][] = segments.map(() => []);
  const unattached: TimedWord[] = [];

  for (const word of words) {
    // **Two passes, and the order is the whole algorithm.**
    //
    // Pass 1 asks which segment *actually contains* the word start, with no tolerance at all.
    // Pass 2 only runs for words no segment contains, and widens by `eps` to rescue them.
    //
    // A single pass with the tolerance applied throughout is the obvious implementation and
    // it is wrong, which a recorded OpenAI response proved: `verbose_json` segments are
    // contiguous — segment 1 ends at 7.239999771118164 s and segment 2 begins at exactly
    // 7.239999771118164 s — and the word "statement" starts on that boundary. With a
    // symmetric tolerance, adjacent segments overlap by 2·eps, "first match wins" hands the
    // word to segment 1, and segment 2 ends up with no words at all. One four-segment
    // response was enough to turn `wordTimingQuality` from `full` into `partial`; on an hour
    // of audio it would quietly strip the timings off a segment at every boundary.
    //
    // Strict-first fixes it without giving up the rescue: a word genuinely a few ms outside
    // every segment still finds a home, and a word inside one is never stolen by its
    // neighbour.
    //
    // A plain scan rather than a cursor: 1200 words against 60 segments is 72k comparisons,
    // and the scan stays correct if a provider ever returns words out of order, which a
    // cursor would not.
    let index = segments.findIndex(
      (segment) => word.startMs >= segment.startMs && word.startMs < segment.endMs,
    );
    if (index === -1) {
      index = segments.findIndex(
        (segment) => word.startMs >= segment.startMs - eps && word.startMs < segment.endMs + eps,
      );
    }

    if (index === -1) {
      unattached.push(word);
      continue;
    }
    buckets[index]!.push({
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text,
      confidence: word.confidence,
    });
  }

  return {
    segments: segments.map((segment, i) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      confidence: segment.confidence,
      words: buckets[i]!,
    })),
    unattached,
  };
}
