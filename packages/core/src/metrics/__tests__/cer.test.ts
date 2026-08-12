import { describe, expect, it } from 'vitest';
import { cer, corpusCer, editStats, units, type EditStats } from '../cer.js';

describe('units', () => {
  it('splits code points, not UTF-16 units', () => {
    // 🎉 is one code point in the astral plane and two UTF-16 units.
    expect(units('a🎉b', 'codepoint')).toEqual(['a', '🎉', 'b']);
    expect('a🎉b'.length).toBe(4);
  });

  it('splits grapheme clusters, which differ from code points on stacked marks', () => {
    // Yoruba ọ́ = U+1ECD U+0301: one cluster, two code points.
    expect(units('ọ́', 'codepoint')).toHaveLength(2);
    expect(units('ọ́', 'grapheme')).toEqual(['ọ́']);
  });

  /**
   * **A grapheme is not a Burmese syllable, and this test exists to stop the report saying
   * it is.** Measured on Node 22.18 / ICU 77.1, 2026-08-12:
   *
   *     ကြန်        4 code points, 2 clusters   ['ကြ', 'န်']
   *     မြန်မာ       6 code points, 4 clusters   ['မြ', 'န်', 'မ', 'ာ']
   *     နေပြည်တော်   10 code points, 5 clusters   ['နေ', 'ပြ', 'ည်', 'တေ', 'ာ်']
   *
   * `မြန်မာ` is two syllables and four extended grapheme clusters, and `တော်` splits with its
   * vowel sign in a different cluster from its consonant. UAX #29's default rules break
   * before a consonant even when a medial or an asat binds it to the previous one, so
   * "grapheme CER" for Mymr is a real, reproducible unit with no orthographic meaning — it
   * is emphatically not "what a human would count by hand". Yoruba is where the grapheme
   * column earns its place; Burmese is where it must not be described as syllables.
   */
  it('does NOT produce one grapheme per Burmese syllable', () => {
    expect(units('ကြန်', 'codepoint')).toHaveLength(4);
    expect(units('ကြန်', 'grapheme')).toEqual(['ကြ', 'န်']);
    expect(units('မြန်မာ', 'grapheme')).toEqual(['မြ', 'န်', 'မ', 'ာ']);
  });
});

describe('cer', () => {
  it('is edits over reference length', () => {
    expect(cer('the cat sat', 'the cat sit')).toBeCloseTo(1 / 11, 15);
  });

  it('is 0 for identical strings', () => {
    expect(cer('မြန်မာ', 'မြန်မာ')).toBe(0);
  });

  it('is 1 for an empty hypothesis', () => {
    expect(cer('', 'the cat sat')).toBe(1);
  });

  /**
   * `null`, not 1 and not jiwer's insertion count. An error rate against nothing is
   * undefined; reporting 1 would say "totally wrong" about a clip whose reference is
   * missing, which is a data problem and not a provider failure.
   */
  it('is null for an empty reference, and 0 when both sides are empty', () => {
    expect(cer('the cat sat', '')).toBeNull();
    expect(cer('', '')).toBe(0);
  });

  /**
   * Codepoint and grapheme CER must differ here or the grapheme path is not doing anything.
   * The reference drops one combining acute; that is one code-point edit but a whole cluster
   * substitution.
   */
  it('reports different numbers for codepoint and grapheme units on combining marks', () => {
    const hyp = 'ọ̀rọ̀ ẹlẹ́rìí náà';
    const ref = 'ọ̀rọ̀ ẹlẹ́rí náà';
    const byCodepoint = cer(hyp, ref, 'codepoint');
    const byGrapheme = cer(hyp, ref, 'grapheme');
    expect(byCodepoint).not.toBeNull();
    expect(byGrapheme).not.toBeNull();
    expect(byCodepoint).not.toBeCloseTo(byGrapheme!, 6);
  });

  it('defaults to code points, because that is what every published CER counts', () => {
    expect(cer('ọ́', 'o')).toBe(cer('ọ́', 'o', 'codepoint'));
  });
});

describe('editStats', () => {
  it('carries edits and reference length rather than a rate', () => {
    expect(editStats('the cat sat', 'the cat sit')).toEqual({ edits: 1, refLen: 11 });
  });

  it('reports refLen 0 for an empty reference so the caller decides what that means', () => {
    expect(editStats('abc', '')).toEqual({ edits: 3, refLen: 0 });
  });
});

describe('corpusCer', () => {
  /**
   * The whole reason `EditStats` exists. FLEURS clip lengths vary by about 4x; on a
   * deliberately skewed distribution the ratio of sums and the mean of the rates are
   * materially different numbers, and only one of them is what jiwer, sacrebleu and every
   * published corpus CER mean.
   */
  it('is the ratio of sums, not the mean of sentence rates', () => {
    const skewed: EditStats[] = [
      { edits: 5, refLen: 5 }, // a tiny clip, entirely wrong: sentence CER 1.0
      { edits: 5, refLen: 195 }, // a long clip, nearly perfect: sentence CER 0.026
    ];

    const meanOfRates = (5 / 5 + 5 / 195) / 2;
    expect(corpusCer(skewed)).toBeCloseTo(10 / 200, 15);
    expect(meanOfRates).toBeCloseTo(0.513, 3);
    // Two and a half times apart. A report that quietly switched estimators would move
    // every language across a tier boundary.
    expect(corpusCer(skewed)!).toBeLessThan(meanOfRates / 10);
  });

  it('is null when the corpus has no reference characters at all', () => {
    expect(corpusCer([])).toBeNull();
    expect(corpusCer([{ edits: 3, refLen: 0 }])).toBeNull();
  });

  it('lets a clip with an empty reference contribute its edits without inflating the rate', () => {
    // refLen 0 adds nothing to the denominator, so a missing reference cannot silently
    // divide by a smaller number than the corpus really has.
    expect(corpusCer([{ edits: 1, refLen: 10 }, { edits: 4, refLen: 0 }])).toBe(0.5);
  });
});
