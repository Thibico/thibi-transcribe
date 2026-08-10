import type { Segment, Word } from '@thibi/core';
import { normalizeText as applyRegistryNormalizers } from '@thibi/languages';
import type { ResolvedLanguage } from '@thibi/languages';
import isZawgyiDetect from 'is-zawgyi';
import Rabbit from 'rabbit-node';

/**
 * Registry-driven text normalization.
 *
 * Two rules the old code gets wrong, both of which destroy information silently:
 *
 * 1. **`textRaw` keeps the exact provider bytes.** `lib/queue.ts:126` normalized in place,
 *    so the original was gone forever and no later question about what the provider
 *    actually said could be answered.
 * 2. **Zawgyi is applied per word, with segment text re-derived.** Converting
 *    `segment.text` in place leaves the word array in Zawgyi and the two disagreeing —
 *    which breaks subtitle re-flow, speaker reconciliation and quote-to-audio at once, and
 *    does so without any error. The alignment cannot be recovered by re-splitting the
 *    converted text either, because the transform reorders characters within a syllable
 *    and is not character-position-preserving.
 *
 *    Converting each word separately is safe because that reordering never crosses a word
 *    boundary: per-word conversion is byte-identical to whole-string conversion, which the
 *    tests assert rather than assume.
 */

/**
 * Zawgyi is a legacy Burmese font encoding that occupies the same code points as Unicode
 * Myanmar with different meanings, so a Zawgyi-emitting provider scores near-100% CER for
 * what is really a rendering problem.
 *
 * Detection uses `is-zawgyi`; conversion uses Rabbit (`rabbit-node`). Google's own
 * `myanmar-tools` npm package ships unbuilt source and cannot be required, which is why it
 * is not used here — a real operational finding that travels with this code.
 */
export function detectZawgyi(text: string): boolean {
  if (!text.trim()) return false;
  try {
    return isZawgyiDetect(text);
  } catch {
    return false;
  }
}

export function zawgyiToUnicode(text: string): string {
  return Rabbit.zg2uni(text);
}

export function joinWords(words: readonly Word[], wordJoin: ' ' | ''): string {
  return words.map((w) => w.text).join(wordJoin);
}

export interface NormalizeSegmentResult {
  segment: Segment;
  converted: boolean;
}

/**
 * Normalize one segment's text and words.
 *
 * `textRaw` is set once, from the provider's bytes, and never touched again.
 */
export function normalizeSegment(
  segment: Segment,
  language: ResolvedLanguage,
): NormalizeSegmentResult {
  const textRaw = segment.textRaw;

  // Detection runs on the *segment*, conversion on each *word*. Per-word detection on a
  // two-syllable token is unreliable — there is not enough signal in one word to tell the
  // two encodings apart.
  const needsZawgyi = language.text.zawgyiApplies && detectZawgyi(textRaw);

  let words = segment.words;
  if (needsZawgyi) {
    words = words.map((word) => ({ ...word, text: zawgyiToUnicode(word.text) }));
  }

  // Re-derive the segment text from the converted words so the two cannot disagree; fall
  // back to converting the segment text directly when there are no words to derive from.
  let text = needsZawgyi
    ? words.length > 0
      ? joinWords(words, language.text.wordJoin)
      : zawgyiToUnicode(textRaw)
    : segment.text;

  text = applyRegistryNormalizers(text, language);
  words = words.map((word) => ({
    ...word,
    text: applyRegistryNormalizers(word.text, language),
  }));

  return {
    segment: { ...segment, text, textRaw, words },
    converted: needsZawgyi,
  };
}

export function normalizeSegments(
  segments: readonly Segment[],
  language: ResolvedLanguage,
): { segments: Segment[]; convertedCount: number } {
  let convertedCount = 0;
  const out = segments.map((segment) => {
    const result = normalizeSegment(segment, language);
    if (result.converted) convertedCount++;
    return result.segment;
  });
  return { segments: out, convertedCount };
}
