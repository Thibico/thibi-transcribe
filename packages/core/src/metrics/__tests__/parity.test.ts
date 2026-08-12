import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cer, corpusCer, editStats } from '../cer.js';
import { chrf2, corpusChrf2 } from '../chrf.js';
import { levenshtein } from '../levenshtein.js';
import { corpusWer, wer, werStats } from '../wer.js';
import type { SegmentationRules } from '../../timing/interpolate.js';

/**
 * The cross-check that pays for reimplementing CER, WER and chrF2 in TypeScript.
 *
 * Every number asserted here was produced by `jiwer` and `sacrebleu` on this machine and
 * frozen by `packages/core/scripts/gen-parity.py`. Nothing in the fixture is hand-written:
 * an expectation we invented would only assert that our code agrees with itself, which is
 * the failure mode this whole file exists to prevent.
 *
 * Python is never installed in CI. Regenerating the fixture is a deliberate act with a diff
 * in the pull request.
 *
 * `resolveJsonModule` is off repo-wide — a JSON `import` type-checks under vitest's esbuild
 * and then fails `tsc -b` — so the fixture is read with `readFileSync`.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

interface Jiwer {
  cer: number;
  wer: number;
  refChars: number;
  refWords: number;
  charEdits: number;
  wordEdits: number;
}

interface Case {
  id: string;
  hyp: string;
  ref: string;
  why: string;
  /** null, or the name of a documented disagreement with jiwer. */
  divergence: string | null;
  sacrebleu: { chrf2: number; chrfPlusPlus: number };
  jiwer: Jiwer;
}

interface Fixture {
  generatedAt: string;
  python: string;
  jiwer: string;
  sacrebleu: string;
  chrfSignature: string;
  cases: Case[];
  corpus: {
    pairs: Array<{ hyp: string; ref: string }>;
    jiwer: Jiwer;
    sacrebleu: { chrf2: number; chrfPlusPlus: number };
  };
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, 'parity.json'), 'utf8')) as Fixture;

/** jiwer and our WER both tokenize on whitespace for a space-delimited language. */
const SPACED: SegmentationRules = { code: 'en-US', wordSegmentation: 'spaces' };

/**
 * CER and WER are exact rationals — the same integers divided the same way — so 1e-12 is
 * generous and any real drift blows straight through it.
 *
 * chrF2 is not: sacrebleu accumulates per-order precisions and recalls in Python floats and
 * we accumulate them in JS doubles, in a different order, so the last couple of ULPs differ
 * by construction. 1e-6 on a 0-100 scale is a ten-millionth of a point, far tighter than any
 * difference that could change a reported figure and far looser than float-order noise.
 */
const EXACT = 1e-12;
const FLOAT_ORDER = 1e-6;

const KNOWN_DIVERGENCES = new Set(['empty-reference', 'jiwer-strips', 'jiwer-space-tokenizer']);

describe('parity with jiwer and sacrebleu', () => {
  it('records which library versions produced these numbers', () => {
    expect(fixture.jiwer).toBe('4.0.0');
    expect(fixture.sacrebleu).toBe('2.6.0');
    // chrF2 exactly: 6 char orders, no word orders, whitespace removed, effective-order
    // smoothing. A signature change means the fixture is measuring a different metric.
    expect(fixture.chrfSignature).toContain('nc:6');
    expect(fixture.chrfSignature).toContain('nw:0');
    expect(fixture.chrfSignature).toContain('space:no');
    expect(fixture.chrfSignature).toContain('eff:yes');
  });

  it('has cases, and every divergence tag is one this file knows how to assert', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of fixture.cases) {
      if (c.divergence !== null) expect(KNOWN_DIVERGENCES).toContain(c.divergence);
    }
  });

  describe.each(fixture.cases)('$id', (c) => {
    /**
     * chrF2 has no divergences at all: it is a straight port and every case agrees.
     */
    it('chrF2 matches sacrebleu', () => {
      expect(chrf2(c.hyp, c.ref)).toBeCloseTo(c.sacrebleu.chrf2, 6);
      expect(Math.abs(chrf2(c.hyp, c.ref) - c.sacrebleu.chrf2)).toBeLessThan(FLOAT_ORDER);
    });

    it('chrF++ matches sacrebleu, keeping the word-n-gram path honest', () => {
      const ours = chrf2(c.hyp, c.ref, { wordOrder: 2 });
      expect(Math.abs(ours - c.sacrebleu.chrfPlusPlus)).toBeLessThan(FLOAT_ORDER);
    });

    it('CER matches jiwer', () => {
      if (c.divergence === 'jiwer-strips') {
        // jiwer applies Strip() before measuring; we measure the string we were handed and
        // leave stripping to normalizeForScoring, so one normalizer lives in one place.
        expect(cer(c.hyp, c.ref)).not.toBeCloseTo(c.jiwer.cer, 6);
        expect(cer(c.hyp.trim(), c.ref.trim())).toBeCloseTo(c.jiwer.cer, 12);
        return;
      }
      if (c.divergence === 'empty-reference') {
        // jiwer's process_words special-cases an empty reference and returns the raw
        // insertion count, which is not a rate. `null` is the honest answer.
        expect(cer(c.hyp, c.ref)).toBeNull();
        return;
      }
      const ours = cer(c.hyp, c.ref);
      expect(ours).not.toBeNull();
      expect(Math.abs(ours! - c.jiwer.cer)).toBeLessThan(EXACT);
    });

    it('character edit counts match jiwer, not only the ratio', () => {
      if (c.divergence === 'jiwer-strips') return;
      const stats = editStats(c.hyp, c.ref);
      expect(stats.edits).toBe(c.jiwer.charEdits);
      expect(stats.refLen).toBe(c.jiwer.refChars);
    });

    it('WER matches jiwer', () => {
      if (c.divergence === 'empty-reference') {
        expect(wer(c.hyp, c.ref, SPACED).value).toBeNull();
        // jiwer's answer here is 3 — the insertion count — for a "rate".
        expect(c.jiwer.wer).toBe(c.jiwer.wordEdits);
        return;
      }
      if (c.divergence === 'jiwer-strips') {
        // RemoveMultipleSpaces + Strip means padding never reaches jiwer's tokenizer, and
        // our filter(Boolean) drops the empty tokens, so WER agrees here even though CER
        // does not. Asserted rather than skipped, because that agreement is not obvious.
        expect(wer(c.hyp, c.ref, SPACED).value).toBeCloseTo(c.jiwer.wer, 12);
        return;
      }
      if (c.divergence === 'jiwer-space-tokenizer') {
        /**
         * jiwer collapses runs of **two or more** whitespace characters to a single space
         * and then splits on `' '` alone, so a lone tab never becomes a boundary: `the\tcat`
         * is one token to jiwer and two to us. The consequence is not cosmetic — jiwer sees
         * a 2-token hypothesis against a 3-token reference and reports WER 1.0 for a
         * sentence with one wrong word, where we report 1/3.
         *
         * Reconstructing jiwer's number needs jiwer's tokenizer, so that is what is done
         * here. This is the small, concrete form of §5.5's argument, and the reason WER is
         * ours rather than a call into theirs.
         */
        expect(wer(c.hyp, c.ref, SPACED).value).toBeCloseTo(1 / 3, 12);
        expect(c.jiwer.wer).toBe(1);

        const jiwerTokens = (s: string): string[] =>
          s.replace(/\s\s+/gu, ' ').trim().split(' ').filter(Boolean);
        const h = jiwerTokens(c.hyp);
        const r = jiwerTokens(c.ref);
        expect(h).toHaveLength(2);
        expect(levenshtein(h, r) / r.length).toBeCloseTo(c.jiwer.wer, 12);
        return;
      }
      const ours = wer(c.hyp, c.ref, SPACED);
      expect(ours.value).not.toBeNull();
      expect(Math.abs(ours.value! - c.jiwer.wer)).toBeLessThan(EXACT);
      expect(ours.kind).toBe('spaces');
    });

    it('word edit counts match jiwer, not only the ratio', () => {
      if (c.divergence !== null) return;
      const stats = werStats(c.hyp, c.ref, SPACED);
      expect(stats).not.toBeNull();
      expect(stats!.edits).toBe(c.jiwer.wordEdits);
      expect(stats!.refWords).toBe(c.jiwer.refWords);
    });
  });

  /**
   * The corpus block. This is the assertion that stops `corpusCer` or `corpusChrf2` drifting
   * to the mean of the sentence values — a change that would look harmless, pass every
   * sentence-level test, and move every language in the tier table.
   */
  describe('corpus aggregation', () => {
    const { pairs, jiwer, sacrebleu } = fixture.corpus;

    it('corpus CER is the ratio of sums, exactly as jiwer aggregates it', () => {
      const stats = pairs.map((p) => editStats(p.hyp, p.ref));
      expect(Math.abs(corpusCer(stats)! - jiwer.cer)).toBeLessThan(EXACT);
      expect(stats.reduce((a, s) => a + s.edits, 0)).toBe(jiwer.charEdits);
      expect(stats.reduce((a, s) => a + s.refLen, 0)).toBe(jiwer.refChars);
    });

    it('is NOT the mean of the sentence CERs', () => {
      const mean =
        pairs.reduce((a, p) => a + (cer(p.hyp, p.ref) ?? 0), 0) / pairs.length;
      expect(Math.abs(mean - jiwer.cer)).toBeGreaterThan(0.01);
    });

    it('corpus WER is the ratio of sums, exactly as jiwer aggregates it', () => {
      const stats = pairs.map((p) => werStats(p.hyp, p.ref, SPACED)!);
      expect(Math.abs(corpusWer(stats)! - jiwer.wer)).toBeLessThan(EXACT);
    });

    it('corpus chrF2 aggregates statistics before scoring, as sacrebleu does', () => {
      expect(Math.abs(corpusChrf2(pairs) - sacrebleu.chrf2)).toBeLessThan(FLOAT_ORDER);
      expect(Math.abs(corpusChrf2(pairs, { wordOrder: 2 }) - sacrebleu.chrfPlusPlus)).toBeLessThan(
        FLOAT_ORDER,
      );
    });

    it('is NOT the mean of the sentence chrF2 scores', () => {
      const mean = pairs.reduce((a, p) => a + chrf2(p.hyp, p.ref), 0) / pairs.length;
      expect(Math.abs(mean - sacrebleu.chrf2)).toBeGreaterThan(1);
    });
  });
});
