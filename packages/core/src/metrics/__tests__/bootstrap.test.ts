import { describe, expect, it } from 'vitest';
import { bootstrapCi, mulberry32 } from '../bootstrap.js';
import { corpusCer, type EditStats } from '../cer.js';

/** A clip corpus with a known point estimate and real per-clip variation. */
function corpus(n: number, seed = 7): EditStats[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const refLen = 120 + Math.floor(rnd() * 180);
    return { edits: Math.round(refLen * (0.1 + rnd() * 0.2)), refLen };
  });
}

describe('mulberry32', () => {
  it('produces the same stream for the same seed, on any machine', () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it('produces a different stream for a different seed', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays in [0, 1)', () => {
    const rnd = mulberry32(20260812);
    for (let i = 0; i < 5000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('bootstrapCi', () => {
  /**
   * The whole point of seeding. `thibi eval report --run <id>` has to reproduce the interval
   * printed in the report from the runlog alone, with no network — otherwise a threshold
   * argument cannot be settled by re-deriving the number.
   */
  it('is reproducible from the same seed', () => {
    const clips = corpus(30);
    expect(bootstrapCi(clips, 500, 42)).toEqual(bootstrapCi(clips, 500, 42));
  });

  it('moves when the seed moves, so the reproducibility above means something', () => {
    const clips = corpus(30);
    expect(bootstrapCi(clips, 500, 42)).not.toEqual(bootstrapCi(clips, 500, 43));
  });

  it('brackets the point estimate', () => {
    const clips = corpus(30);
    const point = corpusCer(clips)!;
    const ci = bootstrapCi(clips, 2000, 1)!;
    expect(ci[0]).toBeLessThanOrEqual(point);
    expect(ci[1]).toBeGreaterThanOrEqual(point);
  });

  /**
   * §5.9 assigns `verified` on the CI upper bound rather than the point estimate, and at
   * n=30 the gap between the two is what makes that a meaningful distinction. This asserts
   * the gap exists at all.
   */
  it('is wide enough at n=30 for the upper bound to be a different decision', () => {
    const clips = corpus(30);
    const point = corpusCer(clips)!;
    const ci = bootstrapCi(clips, 2000, 1)!;
    expect(ci[1] - point).toBeGreaterThan(0.005);
  });

  it('narrows as n grows', () => {
    const width = (n: number): number => {
      const ci = bootstrapCi(corpus(n), 2000, 1)!;
      return ci[1] - ci[0];
    };
    // Not a monotone guarantee for any two arbitrary corpora, but an order of magnitude in
    // n has to show up or the estimator is not doing what its name says.
    expect(width(200)).toBeLessThan(width(20));
  });

  it('gives a degenerate interval at n=1, because there is nothing to resample', () => {
    const ci = bootstrapCi([{ edits: 12, refLen: 100 }], 500, 1)!;
    expect(ci[0]).toBe(0.12);
    expect(ci[1]).toBe(0.12);
  });

  /**
   * `null`, not `[NaN, NaN]`. A NaN prints as `NaN` in a report or — the dangerous one —
   * compares `false` against every threshold, so a language with no clips would sail past a
   * `ciHi <= 0.20` check.
   */
  it('is null for an empty corpus rather than a NaN interval', () => {
    expect(bootstrapCi([], 100, 1)).toBeNull();
  });

  it('handles a corpus whose references are all empty without dividing by zero', () => {
    const ci = bootstrapCi([{ edits: 4, refLen: 0 }], 100, 1)!;
    expect(ci[0]).toBe(0);
    expect(ci[1]).toBe(0);
  });

  it('sorts numerically — a lexicographic sort would put 0.9 below 0.12', () => {
    // Two clips with wildly different rates, so the percentile endpoints are far apart and
    // ordered. Array.prototype.sort's default would return [0.1, 0.9] in string order here
    // and happen to look right; the assertion that catches it is the ordering across a
    // decimal-length boundary.
    const clips: EditStats[] = [
      { edits: 90, refLen: 100 },
      { edits: 12, refLen: 100 },
    ];
    const ci = bootstrapCi(clips, 2000, 3)!;
    expect(ci[0]).toBeLessThanOrEqual(ci[1]);
    expect(ci[0]).toBeGreaterThanOrEqual(0.12);
    expect(ci[1]).toBeLessThanOrEqual(0.9);
  });
});
