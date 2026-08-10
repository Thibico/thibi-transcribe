import { describe, expect, it } from 'vitest';
import { hasIcuSegmentation, interpolateWords, segmentUnits } from '../timing/interpolate.js';
import { minWordTimingQuality } from '../types.js';

const SPACED = { code: 'ha-NG', wordSegmentation: 'spaces' } as const;
const CONTINUA = { code: 'my-MM', wordSegmentation: 'none' } as const;

describe('segmentUnits', () => {
  it('splits a spaced language on whitespace', () => {
    expect(segmentUnits('  Sannu   duniya  ', SPACED)).toEqual(['Sannu', 'duniya']);
  });

  it('splits an unspaced script by grapheme, not code point', () => {
    // မင်္ဂလာပါ is 9 code points but 6 graphemes. Attaching a timing to half a stacked
    // cluster is meaningless, and it is what a naive [...text] split would do.
    const units = segmentUnits('မင်္ဂလာပါ', CONTINUA);
    expect(units.length).toBeLessThan([...'မင်္ဂလာပါ'].length);
    expect(units.join('')).toBe('မင်္ဂလာပါ');
  });

  it('has ICU word segmentation available on this runtime', () => {
    // Documents the assumption rather than silently depending on it. A small-ICU Node
    // build would break Thai, Lao, Khmer and Burmese into character runs.
    expect(hasIcuSegmentation()).toBe(true);
  });
});

describe('interpolateWords', () => {
  const seg = { startMs: 1000, endMs: 5000, text: 'Sannu duniya kuma' };

  it('covers the whole interval with no gap or overrun', () => {
    const words = interpolateWords(seg, SPACED);
    expect(words[0]!.startMs).toBe(1000);
    expect(words.at(-1)!.endMs).toBe(5000);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.startMs).toBe(words[i - 1]!.endMs);
    }
  });

  it('gives longer units more time', () => {
    const [sannu, duniya] = interpolateWords(seg, SPACED);
    expect(duniya!.endMs - duniya!.startMs).toBeGreaterThan(sannu!.endMs - sannu!.startMs);
  });

  it('marks every word estimated with null confidence', () => {
    // An interpolated timing is not a measurement and must never be presented as one, and
    // a null confidence keeps it out of the low-confidence QA query.
    for (const w of interpolateWords(seg, SPACED)) {
      expect(w.isEstimated).toBe(true);
      expect(w.confidence).toBeNull();
    }
  });

  it('does not accumulate rounding drift over many units', () => {
    // 7 units over an interval that does not divide evenly: the last unit absorbs the
    // remainder, so the segment end is exact rather than a few ms short.
    const words = interpolateWords(
      { startMs: 0, endMs: 1000, text: 'a b c d e f g' },
      SPACED,
    );
    expect(words).toHaveLength(7);
    expect(words.at(-1)!.endMs).toBe(1000);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(interpolateWords({ startMs: 0, endMs: 100, text: '' }, SPACED)).toEqual([]);
    expect(interpolateWords({ startMs: 0, endMs: 100, text: '   ' }, SPACED)).toEqual([]);
  });

  it('handles a zero-length segment without producing negative durations', () => {
    for (const w of interpolateWords({ startMs: 500, endMs: 500, text: 'a b' }, SPACED)) {
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
    }
  });
});

describe('minWordTimingQuality', () => {
  it('takes the minimum, so one wordless chunk downgrades the run', () => {
    expect(minWordTimingQuality('full', 'none')).toBe('none');
    expect(minWordTimingQuality('full', 'partial')).toBe('partial');
    expect(minWordTimingQuality('full', 'full')).toBe('full');
    expect(minWordTimingQuality('none', 'partial')).toBe('none');
  });
});
