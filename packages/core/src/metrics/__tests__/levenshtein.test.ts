import { describe, expect, it } from 'vitest';
import { levenshtein } from '../levenshtein.js';

const chars = (s: string): string[] => Array.from(s);

describe('levenshtein', () => {
  it('handles both empty arrays', () => {
    expect(levenshtein([], [])).toBe(0);
  });

  it('is the other length when one side is empty, in both directions', () => {
    expect(levenshtein([], chars('abcd'))).toBe(4);
    expect(levenshtein(chars('abcd'), [])).toBe(4);
  });

  it('is 0 for identical sequences', () => {
    expect(levenshtein(chars('the cat sat'), chars('the cat sat'))).toBe(0);
  });

  it('counts a single substitution as 1', () => {
    expect(levenshtein(chars('cat'), chars('cot'))).toBe(1);
  });

  it('counts pure insertion and pure deletion by length difference', () => {
    expect(levenshtein(chars('cats'), chars('cat'))).toBe(1);
    expect(levenshtein(chars('cat'), chars('cats'))).toBe(1);
    expect(levenshtein(chars('the big black cat'), chars('the cat'))).toBe(10);
  });

  /**
   * A transposition costs 2, not 1. This is plain Levenshtein and must never quietly become
   * Damerau-Levenshtein: every CER and WER number ever published, and every number in
   * `__fixtures__/parity.json`, is against a library that charges 2 here.
   */
  it('charges 2 for a transposition — this is not Damerau-Levenshtein', () => {
    expect(levenshtein(chars('ab'), chars('ba'))).toBe(2);
    expect(levenshtein(chars('recieve'), chars('receive'))).toBe(2);
  });

  /**
   * The implementation puts the shorter sequence on the row axis to keep memory at O(min),
   * which is a swap the caller cannot see. If that swap were ever wrong the function would
   * be asymmetric, so symmetry is the property that guards it.
   */
  it('is symmetric over 100 random pairs', () => {
    let seed = 20260812;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = 'abcde';
    const word = (): string[] =>
      Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * 5)]!);

    for (let i = 0; i < 100; i++) {
      const a = word();
      const b = word();
      expect(levenshtein(a, b)).toBe(levenshtein(b, a));
    }
  });

  it('never exceeds the longer length and never undercuts the length difference', () => {
    const a = chars('the united nations report');
    const b = chars('a report');
    const d = levenshtein(a, b);
    expect(d).toBeLessThanOrEqual(Math.max(a.length, b.length));
    expect(d).toBeGreaterThanOrEqual(Math.abs(a.length - b.length));
  });

  /**
   * Units are whatever the caller passes. CER passes code points or grapheme clusters, WER
   * passes words — the same DP, and a multi-character unit must compare as one thing.
   */
  it('treats multi-character units atomically', () => {
    expect(levenshtein(['the', 'cat', 'sat'], ['the', 'cat', 'sit'])).toBe(1);
    // Not 1 + the character distance between 'sat' and 'sit'.
    expect(levenshtein(['cat'], ['dog'])).toBe(1);
  });

  it('survives the row-swap on a long sequence', () => {
    // Long enough that the internal prev/cur swap runs hundreds of times: an aliasing bug
    // in that swap shows up as a wrong distance, not as an error.
    const a = chars('ab'.repeat(400));
    const b = chars('ac'.repeat(400));
    expect(levenshtein(a, b)).toBe(400);
  });
});
