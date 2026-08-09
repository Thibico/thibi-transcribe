import { describe, expect, it } from 'vitest';
import type { Segment, Word } from '@thibi/core';
import { applySeam, mergeSeam, mergeSeamNoWords } from '../seam.js';
import { lcsPairs } from '../lcs.js';

const HAUSA = { code: 'ha-NG', wordSegmentation: 'spaces' as const };
const BURMESE = { code: 'my-MM', wordSegmentation: 'none' as const };

/** Build a word sequence at 400 ms per word starting at `startMs`. */
function words(texts: string[], startMs: number, step = 400): Word[] {
  return texts.map((text, i) => ({
    idx: i,
    startMs: startMs + i * step,
    endMs: startMs + i * step + step - 50,
    text,
    confidence: 0.9,
  }));
}

function segment(over: Partial<Segment> & { words: Word[] }): Segment {
  const w = over.words;
  return {
    idx: 0,
    startMs: w[0]?.startMs ?? 0,
    endMs: w.at(-1)?.endMs ?? 0,
    text: w.map((x) => x.text).join(' '),
    textRaw: w.map((x) => x.text).join(' '),
    confidence: 0.9,
    hasWords: true,
    ...over,
  };
}

describe('mergeSeam', () => {
  /**
   * The ordinary case: chunk k+1 starts 1200 ms early and re-transcribes the last words of
   * chunk k identically.
   */
  it('aligns a clean duplicate and drops exactly the repeated words', () => {
    const seamMs = 10_000;
    const prev = words(['gwamnati', 'ta', 'ce', 'za', 'a', 'gudanar'], 8_000);
    const next = words(['za', 'a', 'gudanar', 'da', 'zabe', 'a'], 9_200);

    const result = mergeSeam({ prevWords: prev, nextWords: next, seamMs, leadMs: 1200, lang: HAUSA });

    expect(result.method).toBe('lcs');
    expect(result.score).toBeGreaterThan(0.5);
    // 'za a gudanar' is the duplicated run; next resumes at 'da'.
    expect(result.dropNextThrough).toBe(2);
    expect(result.flagged).toBe(false);
  });

  it('normalises case and punctuation before aligning', () => {
    const prev = words(['Gwamnati,', 'ta', 'ce'], 8_800);
    const next = words(['gwamnati', 'ta', 'ce', 'sabon'], 8_800);
    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    expect(result.method).toBe('lcs');
    expect(result.dropNextThrough).toBe(2);
  });

  /**
   * Unspaced scripts align on graphemes: provider "words" in Burmese are syllable
   * fragments and the same audio tokenised twice does not split the same way, so a
   * word-level LCS would fail on a correct transcription.
   */
  it('uses the grapheme path for an unspaced script', () => {
    const prev = words(['ဆုံးဖြတ်', 'ချက်', 'ကို'], 8_800);
    const next = words(['ဆုံးဖြတ်ချက်', 'ကို', 'ချမှတ်'], 8_800);

    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: BURMESE,
    });
    // The two tokenisations disagree about word splits but agree about the characters.
    expect(result.method).toBe('lcs');
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('hard-cuts and flags when the two chunks disagree about the overlap', () => {
    const prev = words(['aikin', 'noma', 'ya', 'karu'], 8_800);
    const next = words(['zuba', 'jari', 'cikin', 'masana'], 8_800);

    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    expect(result.method).toBe('hard-cut');
    expect(result.score).toBeLessThan(0.5);
    expect(result.flagged).toBe(true);
  });

  it('accepts but flags a grey-zone alignment', () => {
    // Half the overlap matches: good enough to trust the alignment, not good enough to
    // stay silent about it. The 0.5 floor is from the overview; 0.7 is invented and is
    // what Phase 12's flagged-seam UI will produce evidence to tune.
    const prev = words(['alpha', 'bravo', 'charlie', 'delta'], 8_800);
    const next = words(['charlie', 'delta', 'zulu', 'yankee', 'xray', 'whiskey'], 8_800);
    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    expect(result.method).toBe('lcs');
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    expect(result.score).toBeLessThan(0.7);
    expect(result.flagged).toBe(true);
  });

  /**
   * Silence across the seam. Score 1 by convention rather than NaN — and deliberately not a
   * low score, which would flag every pause in a recording as a suspect seam.
   */
  it('reports an empty overlap as score 1 and drops nothing', () => {
    const prev = words(['kafin', 'wannan'], 2_000);
    const next = words(['bayan', 'haka'], 12_000);
    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    expect(result.method).toBe('empty');
    expect(result.score).toBe(1);
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.dropNextThrough).toBe(-1);
    expect(result.flagged).toBe(false);
  });

  /**
   * The adversarial case for LCS de-duplication: a phrase genuinely repeated. The time
   * window is the defence — only words near the seam are candidates, so an identical
   * phrase earlier in the chunk cannot be matched against.
   */
  it('does not over-drop when a phrase is genuinely repeated', () => {
    const prev = [
      ...words(['na', 'gode', 'sosai'], 1_000),
      ...words(['na', 'gode', 'sosai'], 8_800),
    ].map((w, idx) => ({ ...w, idx }));
    const next = words(['na', 'gode', 'sosai', 'kwarai', 'da', 'gaske'], 8_800);

    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    // Only the copy at the seam is de-duplicated: three words, not six.
    expect(result.dropNextThrough).toBe(2);
  });

  it('survives a lead longer than the speech in it', () => {
    const prev = words(['kalma'], 9_900);
    const next = words(['kalma', 'biyu'], 9_900);
    const result = mergeSeam({
      prevWords: prev,
      nextWords: next,
      seamMs: 10_000,
      leadMs: 5_000,
      lang: HAUSA,
    });
    expect(() => result).not.toThrow();
    expect(result.dropNextThrough).toBeGreaterThanOrEqual(-1);
  });

  it('handles empty input on either side', () => {
    const result = mergeSeam({
      prevWords: [],
      nextWords: words(['a'], 9_000),
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });
    expect(result.method).toBe('empty');
  });
});

describe('applySeam', () => {
  it('drops a partially overlapping segment and re-joins its text', () => {
    const w = words(['za', 'a', 'gudanar', 'da', 'zabe'], 9_200);
    const next = { segments: [segment({ words: w, textRaw: 'za a gudanar da zabe' })] };

    const { segments, droppedWords } = applySeam(next, { dropNextThrough: 2 }, { wordJoin: ' ' });

    expect(droppedWords).toBe(3);
    expect(segments[0]!.text).toBe('da zabe');
    // The provider's bytes are the audit trail: what was said to us, not what we concluded.
    expect(segments[0]!.textRaw).toBe('za a gudanar da zabe');
    expect(segments[0]!.startMs).toBe(w[3]!.startMs);
    expect(segments[0]!.words.map((x) => x.idx)).toEqual([0, 1]);
  });

  it('removes a segment whose every word was dropped and renumbers the rest', () => {
    const first = segment({ idx: 0, words: words(['za', 'a'], 9_200) });
    const second = segment({ idx: 1, words: words(['gudanar', 'da'], 10_000) });
    const { segments, droppedWords } = applySeam(
      { segments: [first, second] },
      { dropNextThrough: 1 },
      { wordJoin: ' ' },
    );
    expect(droppedWords).toBe(2);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.idx).toBe(0);
    expect(segments[0]!.text).toBe('gudanar da');
  });

  it('is a no-op when nothing is dropped', () => {
    const seg = segment({ words: words(['a', 'b'], 0) });
    const { segments, droppedWords } = applySeam(
      { segments: [seg] },
      { dropNextThrough: -1 },
      { wordJoin: ' ' },
    );
    expect(droppedWords).toBe(0);
    expect(segments[0]).toBe(seg);
  });

  it('joins without spaces for a script that has none', () => {
    const w = words(['ဆုံးဖြတ်ချက်', 'ကို', 'ချမှတ်'], 9_200);
    const { segments } = applySeam(
      { segments: [segment({ words: w })] },
      { dropNextThrough: 0 },
      { wordJoin: '' },
    );
    expect(segments[0]!.text).toBe('ကိုချမှတ်');
  });
});

describe('mergeSeamNoWords', () => {
  it('works at segment granularity and always flags', () => {
    // The provider returned no word offsets, so there is nothing to align. Dropping whole
    // segments inside the overlap is a guess, and the operator must be able to see it.
    const prev = [segment({ words: [], hasWords: false, startMs: 8_000, endMs: 10_000, text: 'daya biyu' })];
    const next = [
      segment({ idx: 0, words: [], hasWords: false, startMs: 8_800, endMs: 9_600, text: 'daya biyu' }),
      segment({ idx: 1, words: [], hasWords: false, startMs: 9_700, endMs: 12_000, text: 'uku hudu' }),
    ];

    const result = mergeSeamNoWords({
      prevSegments: prev,
      nextSegments: next,
      seamMs: 10_000,
      leadMs: 1200,
      lang: HAUSA,
    });

    expect(result.method).toBe('no-words');
    expect(result.flagged).toBe(true);
    // The first `next` segment's midpoint (9200) precedes the overlap midpoint (9400).
    expect(result.dropNextThrough).toBe(0);
  });
});

describe('lcsPairs', () => {
  it('returns aligned index pairs in order', () => {
    expect(lcsPairs(['a', 'b', 'c'], ['x', 'b', 'c'])).toEqual([
      { i: 1, j: 1 },
      { i: 2, j: 2 },
    ]);
  });

  it('returns nothing for disjoint or empty input', () => {
    expect(lcsPairs(['a'], ['b'])).toEqual([]);
    expect(lcsPairs([], ['b'])).toEqual([]);
    expect(lcsPairs(['a'], [])).toEqual([]);
  });
});
