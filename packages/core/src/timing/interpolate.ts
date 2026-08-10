import type { Word } from '../types.js';

/**
 * The no-words fallback: derive plausible word timings from a segment's interval and text.
 *
 * Overview Risk 2 — word timings are the spine of half the design and the least reliable
 * field in the response. Subtitle re-flow, bilingual alignment and quote-to-audio all
 * assume words exist. This is what they use when they do not, and it lives in `core` so
 * the exporter, the editor and the eval harness cannot disagree about what an interpolated
 * timing is.
 *
 * **Interpolated words are computed at read time and never stored.** Writing them into the
 * `words` table with `is_estimated = true` would poison the `confidence < 0.5` QA query,
 * the Phase 3 reconciler's per-word speaker assignment, and any future word-level
 * statistic — each of which would then need an `is_estimated = false` filter that someone
 * will eventually forget.
 */

/**
 * The minimal language shape this needs.
 *
 * Deliberately structural rather than `ResolvedLanguage`: `packages/core` may depend on
 * nothing, and it is importable from a React client component. The caller — engine,
 * exporter or editor — passes the two fields that matter.
 */
export interface SegmentationRules {
  /** BCP-47 tag, for `Intl.Segmenter`'s locale-sensitive breaking. */
  code: string;
  /** `'none'` ⇒ scriptio continua: split by grapheme, because there are no spaces. */
  wordSegmentation: 'spaces' | 'none' | 'icu';
}

/**
 * True when `Intl.Segmenter` exists and actually knows word boundaries for complex
 * scripts. A small-ICU Node build has the constructor but breaks Thai, Lao, Khmer and
 * Burmese into runs of characters, which would silently produce nonsense rather than
 * failing. Verified present on Node 22.18 with full ICU 77.
 */
let segmenterSupport: boolean | null = null;
export function hasIcuSegmentation(): boolean {
  if (segmenterSupport !== null) return segmenterSupport;
  try {
    if (typeof Intl.Segmenter !== 'function') return (segmenterSupport = false);
    // 'ไปโรงเรียน' is four Thai words. A small-ICU build returns one segment.
    const probe = [...new Intl.Segmenter('th', { granularity: 'word' }).segment('ไปโรงเรียน')];
    return (segmenterSupport = probe.length > 1);
  } catch {
    return (segmenterSupport = false);
  }
}

/** Split segment text into the units that will each receive a slice of the interval. */
export function segmentUnits(text: string, rules: SegmentationRules): string[] {
  if (rules.wordSegmentation === 'spaces') {
    return text.split(/\s+/u).filter(Boolean);
  }

  if (typeof Intl.Segmenter === 'function') {
    // Graphemes, not code points. မင်္ဂလာပါခင်ဗျာ is 15 code points but 11 graphemes, and a
    // timing attached to half a stacked cluster is meaningless.
    const granularity = rules.wordSegmentation === 'icu' ? 'word' : 'grapheme';
    try {
      const parts = [...new Intl.Segmenter(rules.code, { granularity }).segment(text)]
        .map((s) => s.segment)
        .filter((s) => s.trim().length > 0);
      if (parts.length > 0) return parts;
    } catch {
      // Fall through to the code-point split below.
    }
  }

  return [...text].filter((c) => c.trim().length > 0);
}

/**
 * Distribute a segment's interval across its text, proportionally to unit length.
 *
 * Longer units get more time, which is a better guess than uniform spacing and is the same
 * heuristic the subtitle re-flow uses. Every returned word is marked `isEstimated` and
 * carries `confidence: null` — an interpolated timing is not a measurement and must never
 * be presented as one.
 */
export function interpolateWords(
  segment: { startMs: number; endMs: number; text: string },
  rules: SegmentationRules,
): Word[] {
  const units = segmentUnits(segment.text, rules);
  if (units.length === 0) return [];

  const weights = units.map((u) => [...u].length || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, segment.endMs - segment.startMs);

  const words: Word[] = [];
  let cursor = segment.startMs;
  for (let i = 0; i < units.length; i++) {
    // The last unit takes whatever remains, so rounding cannot leave a gap or overrun the
    // segment's end. Accumulated drift across a 40-word segment is otherwise visible.
    const isLast = i === units.length - 1;
    const dur = isLast ? segment.endMs - cursor : Math.round(span * (weights[i]! / total));
    words.push({
      idx: i,
      startMs: cursor,
      endMs: cursor + Math.max(0, dur),
      text: units[i]!,
      confidence: null,
      isEstimated: true,
    });
    cursor += Math.max(0, dur);
  }
  return words;
}
