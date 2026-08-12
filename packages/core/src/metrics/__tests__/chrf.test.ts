import { describe, expect, it } from 'vitest';
import { chrf2, chrfScore, chrfStats, corpusChrf2 } from '../chrf.js';

/**
 * `parity.test.ts` is what proves these numbers are sacrebleu's. This file asserts the
 * structural properties a reader of the report relies on, which parity alone would not
 * make obvious.
 */
describe('chrfStats', () => {
  it('returns one entry per character order, and none for words by default', () => {
    expect(chrfStats('the cat sat', 'the cat sit')).toHaveLength(6);
    expect(chrfStats('the cat sat', 'the cat sit', { wordOrder: 2 })).toHaveLength(8);
  });

  it('removes whitespace before extracting character n-grams', () => {
    // sacrebleu's whitespace=False: `''.join(line.split())`. 'the cat' is 6 characters to
    // chrF, not 7, so the unigram count reflects the removal.
    expect(chrfStats('the cat', 'the cat')[0]!.hyp).toBe(6);
  });

  /**
   * The detail the obvious port gets wrong, and the reason `chrf-asymmetric-short` is in the
   * parity fixture. sacrebleu reports the hypothesis n-gram count as 0 whenever the
   * reference has no n-grams at that order — `hyp_count if ref_ngrams else 0`.
   */
  it('reports a zero hypothesis count at any order where the reference has no n-grams', () => {
    const stats = chrfStats('abcdefgh', 'ab');
    expect(stats[1]!.ref).toBe(1); // 'ab' has one bigram
    expect(stats[2]!.ref).toBe(0); // and no trigram
    expect(stats[2]!.hyp).toBe(0); // so the hypothesis contributes nothing at order 3
    expect(stats[1]!.hyp).toBeGreaterThan(0);
  });
});

describe('chrfScore', () => {
  it('scores identical strings at exactly 100', () => {
    expect(chrf2('the quick brown fox', 'the quick brown fox')).toBe(100);
    expect(chrf2('မြန်မာစာ', 'မြန်မာစာ')).toBe(100);
  });

  it('scores a hypothesis with no overlap at 0', () => {
    expect(chrf2('xxxx', 'yyyy')).toBe(0);
  });

  it('scores an empty hypothesis at 0 rather than throwing', () => {
    expect(chrf2('', 'the cat sat')).toBe(0);
  });

  it('returns 0 when no order has both a hypothesis and a reference n-gram', () => {
    expect(chrfScore([])).toBe(0);
    expect(chrfScore([{ hyp: 0, ref: 0, match: 0 }])).toBe(0);
  });

  /**
   * The effective-order branch, worked all the way through because the arithmetic is the
   * assertion.
   *
   * `cat` against `cot` is three characters, so orders 4-6 have no n-grams on either side
   * and only three orders are effective. Order 1 matches `c` and `t` (precision and recall
   * 2/3); orders 2 and 3 match nothing. Averaged over the three effective orders that is
   * 2/9 for both precision and recall, and F-beta with equal precision and recall is that
   * same value, so the score is 100 x 2/9 = 22.22.
   *
   * Averaging over all six orders instead — i.e. treating "no n-grams at this order" as
   * "scored zero at this order" — would give exactly half that. Short segments would be
   * punished for being short, and the `chrf-short` case in the parity fixture would fail.
   */
  it('averages over effective orders only, which is worth exactly 2x here', () => {
    const stats = chrfStats('cat', 'cot');
    expect(stats.filter((s) => s.hyp > 0 && s.ref > 0)).toHaveLength(3);

    const short = chrf2('cat', 'cot');
    expect(short).toBeCloseTo((100 * 2) / 9, 12);
    expect(short).toBeCloseTo(2 * ((100 * 2) / 3 / 6), 12);
  });

  it('weights recall over precision at beta = 2', () => {
    // A hypothesis that is a prefix of the reference has perfect precision and poor recall;
    // the reverse has perfect recall and poor precision. beta=2 favours the latter.
    const highPrecision = chrf2('the united', 'the united nations report');
    const highRecall = chrf2('the united nations report', 'the united');
    expect(highRecall).toBeGreaterThan(highPrecision);
  });
});

describe('corpusChrf2', () => {
  /**
   * Same estimator rule as `corpusCer`: aggregate the per-order statistics, then score once.
   * The mean of the sentence scores is a different number and is not what sacrebleu, or the
   * research doc's translation table, reports.
   */
  it('is not the mean of the sentence scores on a skewed corpus', () => {
    const pairs = [
      { hyp: 'x', ref: 'y' },
      {
        hyp: 'the united nations report says warming is increasing rapidly worldwide',
        ref: 'the united nations report says warming is increasing rapidly worldwide',
      },
    ];
    const mean = (chrf2(pairs[0]!.hyp, pairs[0]!.ref) + chrf2(pairs[1]!.hyp, pairs[1]!.ref)) / 2;
    expect(mean).toBeCloseTo(50, 0);
    // The long, perfect segment dominates the aggregated statistics, as it should.
    expect(corpusChrf2(pairs)).toBeGreaterThan(90);
  });

  it('is 100 for a corpus of identical pairs and 0 for an empty corpus', () => {
    expect(corpusChrf2([{ hyp: 'abc def', ref: 'abc def' }])).toBe(100);
    expect(corpusChrf2([])).toBe(0);
  });
});
