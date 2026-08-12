import { levenshtein } from './levenshtein.js';

/**
 * Character error rate.
 *
 * This is the metric the whole project turns on. Script integrity catches a provider that
 * answered in the wrong alphabet; a decoder's own confidence catches nothing at all — on
 * 2026-08-12 a provider reported genuine per-word confidence of 0.892 on completely
 * fabricated output, Vietnamese YouTube boilerplate returned for Burmese audio, because
 * confidence measures the decoder's certainty about its own next token and not whether the
 * audio contains any of it. CER against a reference is the only thing in this repo that can
 * make the stronger claim, which is why it is here and why it is asserted against jiwer.
 */

/**
 * Code points or grapheme clusters.
 *
 * Both are reported; the tier is assigned on `codepoint`, because that is what jiwer counts
 * and therefore what every published CER is comparable to. Grapheme CER groups a base with
 * its combining marks — Yoruba's `ọ́` is one thing you can see and two code points — so the
 * difference between the two columns is a signal about how much of the error is diacritics.
 *
 * **A grapheme cluster is not an orthographic syllable, and the report must not imply it
 * is.** Measured on Node 22.18 / ICU 77.1: `မြန်မာ` is two Burmese syllables and *four*
 * extended grapheme clusters, and `တော်` splits as `တေ` + `ာ်`, separating a vowel sign from
 * its consonant. UAX #29's default rules break before a consonant regardless of the medial
 * or asat binding it to the previous one. Grapheme CER is well-defined and reproducible for
 * Mymr; it is just not "what a human would count by hand", which is how it is easy to
 * describe it by accident.
 *
 * The registry's `scriptEntry.clusters` names which one a script cares about.
 */
export type Units = 'codepoint' | 'grapheme';

/**
 * Constructed once. `Intl.Segmenter` construction is not cheap and this runs per clip, per
 * language, across a 107-language sweep.
 *
 * Locale `'und'` deliberately: grapheme cluster boundaries are defined by UAX #29 from the
 * character properties themselves, so unlike *word* breaking they do not depend on the
 * locale. Passing a language tag here would imply a locale-sensitivity that does not exist.
 */
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Split a string into the units the edit distance will operate on. */
export function units(s: string, mode: Units): string[] {
  return mode === 'codepoint'
    ? // Array.from iterates code points, not UTF-16 units, so an astral character is one
      // unit and not two lone surrogates scored separately.
      Array.from(s)
    : Array.from(graphemeSegmenter.segment(s), (x) => x.segment);
}

/**
 * The per-clip statistic that everything else aggregates.
 *
 * Corpus CER, the bootstrap interval and the runlog all carry `(edits, refLen)` pairs rather
 * than rates, because the corpus estimator is the ratio of sums and a rate cannot be summed
 * back into one.
 */
export interface EditStats {
  edits: number;
  refLen: number;
}

export function editStats(hyp: string, ref: string, mode: Units = 'codepoint'): EditStats {
  const h = units(hyp, mode);
  const r = units(ref, mode);
  return { edits: levenshtein(h, r), refLen: r.length };
}

/**
 * Sentence CER, or `null` when the reference is empty.
 *
 * **`null`, not 1.** An error rate against nothing is undefined, not total failure — and not
 * jiwer's answer either, which is the raw insertion count and therefore not a rate at all
 * (`empty-ref` in `__fixtures__/parity.json` records that divergence). An empty hypothesis
 * against an empty reference is 0: nothing was asked for and nothing was wrong.
 */
export function cer(hyp: string, ref: string, mode: Units = 'codepoint'): number | null {
  const { edits, refLen } = editStats(hyp, ref, mode);
  if (refLen === 0) return units(hyp, mode).length === 0 ? 0 : null;
  return edits / refLen;
}

/**
 * Corpus CER: the ratio of summed edits to summed reference length, **never** the mean of
 * the sentence rates.
 *
 * FLEURS clip lengths vary by about 4x. Averaging sentence rates weights a six-word clip the
 * same as a twenty-five-word one, which shifts the corpus number materially and in a
 * direction that depends on which clips happened to be short. It is also jiwer's and
 * sacrebleu's convention, so the parity fixture's `corpus` block would fail immediately if
 * this drifted to a mean — which is exactly why that block is in the fixture.
 *
 * `null` when the whole corpus has no reference characters, for the same reason `cer` does.
 */
export function corpusCer(stats: readonly EditStats[]): number | null {
  let e = 0;
  let r = 0;
  for (const s of stats) {
    e += s.edits;
    r += s.refLen;
  }
  return r === 0 ? null : e / r;
}
