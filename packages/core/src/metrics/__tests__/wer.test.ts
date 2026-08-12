import { describe, expect, it } from 'vitest';
import { corpusWer, wer, werStats } from '../wer.js';
import { hasIcuSegmentation, type SegmentationRules } from '../../timing/interpolate.js';

const SPACED: SegmentationRules = { code: 'en-US', wordSegmentation: 'spaces' };
const BURMESE: SegmentationRules = { code: 'my-MM', wordSegmentation: 'none' };
const THAI: SegmentationRules = { code: 'th-TH', wordSegmentation: 'icu' };

describe('wer', () => {
  it('is word edits over reference words', () => {
    expect(wer('the cat sat', 'the cat sit', SPACED)).toEqual({ value: 1 / 3, kind: 'spaces' });
  });

  it('is 0 for identical strings', () => {
    expect(wer('the cat sat', 'the cat sat', SPACED).value).toBe(0);
  });

  /**
   * Rule 8, and the reason this function exists rather than a call into jiwer. Burmese is
   * `wordSegmentation: 'none'` in the registry: there are no word boundaries to tokenize, so
   * a whitespace WER would be 0 or 1 per sentence and meaningless in aggregate.
   */
  it('returns null with a null kind for a non-word-delimited script', () => {
    const burmese = 'အာဆီယံရဲ့ဆုံးဖြတ်ချက်ကိုနေပြည်တော်ကတုံ့ပြန်ခဲ့ပါတယ်';
    expect(wer(burmese, burmese, BURMESE)).toEqual({ value: null, kind: null });
    expect(wer('anything', burmese, BURMESE)).toEqual({ value: null, kind: null });
  });

  /**
   * The nullability is load-bearing, so assert the shape a consumer sees rather than only
   * the value: `kind: null` is what stops a `null` WER being rendered as "0.00".
   */
  it('never labels a refusal with a tokenizer name', () => {
    expect(wer('x', 'y', BURMESE).kind).toBeNull();
  });

  it('labels an ICU-segmented WER as icu and never as spaces', () => {
    if (!hasIcuSegmentation()) return; // small-ICU build; the guard below covers it
    const result = wer('ไปโรงเรียนทุกวัน', 'ไปโรงเรียนทุกเช้า', THAI);
    expect(result.kind).toBe('icu');
    expect(result.value).not.toBeNull();
    expect(result.value!).toBeGreaterThan(0);
  });

  it('segments Thai into words rather than characters', () => {
    if (!hasIcuSegmentation()) return;
    // 'ไปโรงเรียน' is four Thai words and ten characters. A character split would make a
    // one-word substitution look like a small edit rate; word segmentation does not.
    const stats = werStats('ไปโรงเรียน', 'ไปโรงเรียน', THAI);
    expect(stats).not.toBeNull();
    expect(stats!.refWords).toBeGreaterThan(1);
    expect(stats!.refWords).toBeLessThan(10);
  });

  it('refuses rather than guessing when ICU segmentation is unavailable', () => {
    // On a full-ICU build this is a no-op assertion; on a small-ICU build it is the whole
    // point. Either way the contract is that a WER labelled 'icu' came from real ICU.
    const result = wer('ไปโรงเรียน', 'ไปโรงเรียน', THAI);
    if (hasIcuSegmentation()) expect(result.kind).toBe('icu');
    else expect(result).toEqual({ value: null, kind: null });
  });

  it('splits on any whitespace run, unlike jiwer', () => {
    // `the\tcat sat` is three words here and two to jiwer, whose tokenizer splits on ' '
    // alone. Recorded as the `tab-separated` divergence in __fixtures__/parity.json.
    expect(werStats('the\tcat sat', 'the cat sit', SPACED)!.edits).toBe(1);
  });

  it('is null for an empty reference, and 0 when both sides are empty', () => {
    expect(wer('the cat sat', '', SPACED)).toEqual({ value: null, kind: 'spaces' });
    expect(wer('', '', SPACED)).toEqual({ value: 0, kind: 'spaces' });
  });

  it('counts insertions, so a hypothesis longer than the reference exceeds 1', () => {
    expect(wer('the big black cat sat down', 'the cat sat', SPACED).value).toBe(3 / 3);
  });
});

describe('werStats and corpusWer', () => {
  it('returns null statistics exactly where wer returns a null value', () => {
    expect(werStats('a', 'b', BURMESE)).toBeNull();
    expect(werStats('a', 'b', SPACED)).toEqual({ edits: 1, refWords: 1, kind: 'spaces' });
  });

  it('is the ratio of sums, so a null-WER clip cannot enter the denominator', () => {
    expect(corpusWer([{ edits: 1, refWords: 3 }, { edits: 2, refWords: 7 }])).toBe(3 / 10);
    expect(corpusWer([])).toBeNull();
  });
});
