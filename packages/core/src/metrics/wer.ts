import { levenshtein } from './levenshtein.js';
import { hasIcuSegmentation, type SegmentationRules } from '../timing/interpolate.js';

/**
 * Word error rate — and, for six of the languages this product exists to serve, the refusal
 * to compute one.
 *
 * Normalization rule 8. A whitespace tokenizer on scriptio-continua text is not an
 * approximate WER, it is a different quantity: Burmese, Thai, Khmer, Lao, Japanese and
 * Chinese references come back as one "word" or as arbitrary provider-chosen syllable runs,
 * so the per-sentence value is 0 or 1 and the corpus value means nothing. Once a number like
 * that is printed in a table nobody remembers where it came from. `null` is the honest
 * answer and the registry's `text.wordSegmentation` is what decides.
 *
 * This is the concrete reason the metrics are not a call into `jiwer`: jiwer's tokenizer is
 * `RemoveMultipleSpaces` followed by `split(" ")` and it has no way to say `null`.
 */

/**
 * How the number was produced, travelling *with* the number.
 *
 * A space-tokenized WER and an ICU-segmented one are not comparable to each other, and
 * neither is comparable to a published WER unless it used the same tokenizer. Returning the
 * kind alongside the value means a consumer cannot silently put them in the same column;
 * `null` here means no WER was computed at all.
 */
export type WerKind = 'spaces' | 'icu' | null;

export interface WerResult {
  value: number | null;
  kind: WerKind;
}

const NOT_COMPUTED: WerResult = { value: null, kind: null };

/**
 * Word error rate for `hyp` against `ref`, or `{ value: null, kind: null }` when words are
 * not a meaningful unit for this language.
 *
 * `rules` is the same structural shape `interpolateWords` takes — `@thibi/core` depends on
 * nothing, so the caller passes the two registry fields that matter rather than a
 * `ResolvedLanguage`. Reusing the shape is deliberate: word segmentation for timing and word
 * segmentation for scoring must not be allowed to become two different opinions.
 */
export function wer(hyp: string, ref: string, rules: SegmentationRules): WerResult {
  if (rules.wordSegmentation === 'none') return NOT_COMPUTED;

  // A small-ICU Node build has `Intl.Segmenter` but breaks Thai, Lao, Khmer and Burmese into
  // runs of characters. Computing a WER from that produces a plausible-looking number rather
  // than an error, so the same refusal applies as for 'none'.
  if (rules.wordSegmentation === 'icu' && !hasIcuSegmentation()) return NOT_COMPUTED;

  const kind: WerKind = rules.wordSegmentation === 'spaces' ? 'spaces' : 'icu';
  const split = rules.wordSegmentation === 'spaces' ? spaceWords : (s: string) => icuWords(s, rules.code);

  const h = split(hyp);
  const r = split(ref);

  // Same rule as `cer`: an error rate against no words is undefined, not 100%, and it is not
  // jiwer's insertion count either. The `kind` still travels, because a tokenizer *was*
  // chosen and the caller is entitled to know which.
  if (r.length === 0) return { value: h.length === 0 ? 0 : null, kind };

  return { value: levenshtein(h, r) / r.length, kind };
}

/**
 * Any whitespace run is a word boundary — which is where we differ from jiwer, whose
 * tokenizer collapses runs of two or more whitespace characters to a single space and then
 * splits on that space alone, leaving `the\tcat` as one token. See `tab-separated` in
 * `__fixtures__/parity.json`.
 */
function spaceWords(s: string): string[] {
  return s.split(/\s+/u).filter(Boolean);
}

/**
 * ICU word segmentation, in the language's own locale.
 *
 * The locale matters here in a way it does not for grapheme clusters: word breaking for
 * Thai, Khmer and Lao is dictionary-driven and locale-sensitive. `isWordLike` drops the
 * whitespace and punctuation segments the segmenter emits between words.
 *
 * A `Segmenter` per call rather than a cached one, because the locale varies per language
 * and caching would need a map keyed by tag; ICU WER is the minority path and this is not
 * the inner loop.
 */
function icuWords(s: string, code: string): string[] {
  try {
    return Array.from(new Intl.Segmenter(code, { granularity: 'word' }).segment(s))
      .filter((x) => x.isWordLike)
      .map((x) => x.segment);
  } catch {
    // An unrecognised BCP-47 tag. Falling back to whitespace would produce a number labelled
    // 'icu' that is not one, so produce nothing and let the caller see `null`.
    return [];
  }
}

/**
 * Corpus WER: summed edits over summed reference words, matching `corpusCer`'s
 * ratio-of-sums and jiwer's own aggregation. Clips whose WER was `null` contribute nothing
 * and must not be counted in the denominator, which is why this takes statistics rather than
 * rates.
 */
export function corpusWer(stats: readonly { edits: number; refWords: number }[]): number | null {
  let e = 0;
  let r = 0;
  for (const s of stats) {
    e += s.edits;
    r += s.refWords;
  }
  return r === 0 ? null : e / r;
}

/** The per-clip statistic `corpusWer` aggregates, or `null` when no WER is meaningful. */
export function werStats(
  hyp: string,
  ref: string,
  rules: SegmentationRules,
): { edits: number; refWords: number; kind: WerKind } | null {
  if (rules.wordSegmentation === 'none') return null;
  if (rules.wordSegmentation === 'icu' && !hasIcuSegmentation()) return null;

  const kind: WerKind = rules.wordSegmentation === 'spaces' ? 'spaces' : 'icu';
  const split = rules.wordSegmentation === 'spaces' ? spaceWords : (s: string) => icuWords(s, rules.code);
  const h = split(hyp);
  const r = split(ref);
  return { edits: levenshtein(h, r), refWords: r.length, kind };
}
