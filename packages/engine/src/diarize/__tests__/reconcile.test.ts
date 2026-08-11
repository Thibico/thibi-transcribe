import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignWords,
  DEFAULTS,
  medianSmooth,
  reconcile,
  voteSegments,
  type RSegment,
  type RWord,
} from '../reconcile.js';
import type { Turn } from '../types.js';

/**
 * `readFileSync` rather than a JSON `import`: `resolveJsonModule` is off repo-wide, so an
 * import type-checks under vitest's esbuild and then fails `tsc -b` at the end of a run.
 */
const FIXTURES = resolve(import.meta.dirname, '../__fixtures__');
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as Fixture;

interface Fixture {
  name: string;
  why: string;
  turns: Turn[];
  segments: RSegment[];
  words: RWord[];
  expect: {
    beforeSmoothing?: Array<{ wordId: string; speakerKey: string | null; margin?: number; source?: string }>;
    words?:
      | Array<{ wordId: string; speakerKey: string | null; margin?: number; marginApprox?: number; source?: string }>
      | { allSources: string; allMargins: number; unassigned: number; medianFlips: number };
    segments?: Array<{
      segmentId: string;
      speakerKey: string | null;
      purity?: number;
      purityApprox?: number;
      needsReview: boolean;
      source: string;
    }>;
    medianFlips?: number;
    unassigned?: number;
    marginBelow?: number;
    everySegmentFlagged?: boolean;
  };
}

const ALL = [
  'two-speaker-clean',
  'flicker-single-word',
  'interjection-genuine',
  'interjection-short-but-certain',
  'interjection-long-but-uncertain',
  'turn-shorter-than-word',
  'overlapping-turns',
  'gap-no-turn',
  'no-words-oromo',
];

describe('reconcile fixtures', () => {
  it.each(ALL)('%s', (name) => {
    const f = load(name);
    const result = reconcile(f.segments, f.words, f.turns);
    const byWord = new Map(result.words.map((w) => [w.wordId, w]));
    const bySegment = new Map(result.segments.map((s) => [s.segmentId, s]));

    if (Array.isArray(f.expect.words)) {
      for (const want of f.expect.words) {
        const got = byWord.get(want.wordId);
        expect(got, `${name}: no assignment for ${want.wordId}`).toBeDefined();
        expect(got!.speakerKey, `${name}: ${want.wordId} speaker`).toBe(want.speakerKey);
        if (want.source !== undefined) expect(got!.source, `${name}: ${want.wordId} source`).toBe(want.source);
        if (want.margin !== undefined) expect(got!.margin, `${name}: ${want.wordId} margin`).toBeCloseTo(want.margin, 6);
        if (want.marginApprox !== undefined) {
          expect(got!.margin, `${name}: ${want.wordId} margin`).toBeCloseTo(want.marginApprox, 3);
        }
      }
    } else if (f.expect.words) {
      const w = f.expect.words;
      expect(result.words.every((x) => x.source === w.allSources)).toBe(true);
      expect(result.words.every((x) => x.margin === w.allMargins)).toBe(true);
      expect(result.stats.unassignedWords).toBe(w.unassigned);
      expect(result.stats.medianFlips).toBe(w.medianFlips);
    }

    if (f.expect.medianFlips !== undefined) expect(result.stats.medianFlips).toBe(f.expect.medianFlips);
    if (f.expect.unassigned !== undefined) expect(result.stats.unassignedWords).toBe(f.expect.unassigned);
    if (f.expect.marginBelow !== undefined) {
      for (const w of result.words) expect(w.margin).toBeLessThan(f.expect.marginBelow);
    }

    for (const want of f.expect.segments ?? []) {
      const got = bySegment.get(want.segmentId);
      expect(got, `${name}: no assignment for ${want.segmentId}`).toBeDefined();
      expect(got!.speakerKey, `${name}: ${want.segmentId} speaker`).toBe(want.speakerKey);
      expect(got!.needsReview, `${name}: ${want.segmentId} needsReview`).toBe(want.needsReview);
      expect(got!.source, `${name}: ${want.segmentId} source`).toBe(want.source);
      if (want.purity !== undefined) expect(got!.purity).toBeCloseTo(want.purity, 6);
      if (want.purityApprox !== undefined) expect(got!.purity).toBeCloseTo(want.purityApprox, 3);
    }

    if (f.expect.everySegmentFlagged) {
      expect(result.segments.every((s) => s.needsReview)).toBe(true);
    }
  });

  it('flicker-single-word is genuinely mis-assigned before the filter runs', () => {
    // Otherwise the fixture proves nothing: a word already assigned A would "pass" a test
    // that only checks the final answer.
    const f = load('flicker-single-word');
    const raw = assignWords(f.words, f.turns);
    for (const want of f.expect.beforeSmoothing ?? []) {
      const got = raw.find((x) => x.wordId === want.wordId)!;
      expect(got.speakerKey).toBe(want.speakerKey);
      expect(got.margin).toBeCloseTo(want.margin!, 6);
    }
  });
});

describe('the median filter guards', () => {
  /**
   * The pair test. Each guard is disabled in turn by moving its threshold, and the fixture
   * built to be held by *that* guard alone must then flip. If a guard is ever deleted, its
   * fixture fails in the suite above; this test is what proves the fixtures are actually
   * load-bearing rather than incidentally passing.
   */
  it('the margin guard alone is what saves a short, certain interjection', () => {
    const f = load('interjection-short-but-certain');
    expect(reconcile(f.segments, f.words, f.turns).stats.medianFlips).toBe(0);

    const withoutMarginGuard = reconcile(f.segments, f.words, f.turns, {
      ...DEFAULTS,
      medianMarginMax: 1.1, // every margin is now "uncertain"
    });
    expect(withoutMarginGuard.stats.medianFlips).toBe(1);
  });

  it('the duration guard alone is what saves a long, uncertain utterance', () => {
    const f = load('interjection-long-but-uncertain');
    expect(reconcile(f.segments, f.words, f.turns).stats.medianFlips).toBe(0);

    const withoutDurationGuard = reconcile(f.segments, f.words, f.turns, {
      ...DEFAULTS,
      medianDurationMaxMs: 10_000, // every word is now "too short to be an utterance"
    });
    expect(withoutDurationGuard.stats.medianFlips).toBe(1);
  });

  it('a genuine interjection survives losing either guard, but not both', () => {
    const f = load('interjection-genuine');
    expect(reconcile(f.segments, f.words, f.turns).stats.medianFlips).toBe(0);
    expect(
      reconcile(f.segments, f.words, f.turns, { ...DEFAULTS, medianMarginMax: 1.1 }).stats.medianFlips,
    ).toBe(0);
    expect(
      reconcile(f.segments, f.words, f.turns, { ...DEFAULTS, medianDurationMaxMs: 10_000 }).stats.medianFlips,
    ).toBe(0);
    expect(
      reconcile(f.segments, f.words, f.turns, {
        ...DEFAULTS,
        medianMarginMax: 1.1,
        medianDurationMaxMs: 10_000,
      }).stats.medianFlips,
    ).toBe(1);
  });

  it('does not cascade: one pass over the original assignments, never the smoothed ones', () => {
    // A B B A with both Bs eligible. Reading from `out` instead of `a` would flip the
    // first B to A, then see A A B A and flip the second, turning a two-word run into
    // nothing. Reading from `a` leaves both alone, because neither is a one-word island.
    const turns: Turn[] = [
      { startMs: 0, endMs: 1000, speakerKey: 'A' },
      { startMs: 1000, endMs: 1400, speakerKey: 'B' },
      { startMs: 1400, endMs: 3000, speakerKey: 'A' },
    ];
    const words: RWord[] = [
      { id: 'w0', segmentId: 's0', idx: 0, startMs: 500, endMs: 900, text: 'a' },
      { id: 'w1', segmentId: 's0', idx: 1, startMs: 950, endMs: 1150, text: 'b1' },
      { id: 'w2', segmentId: 's0', idx: 2, startMs: 1150, endMs: 1350, text: 'b2' },
      { id: 'w3', segmentId: 's0', idx: 3, startMs: 1500, endMs: 1900, text: 'c' },
    ];
    const assigned = assignWords(words, turns);
    expect(assigned.map((x) => x.speakerKey)).toEqual(['A', 'B', 'B', 'A']);
    const smoothed = medianSmooth(words, assigned);
    expect(smoothed.map((x) => x.speakerKey)).toEqual(['A', 'B', 'B', 'A']);
    expect(smoothed.filter((x) => x.source === 'median')).toHaveLength(0);
  });
});

describe('reconcile invariants', () => {
  const turns: Turn[] = [
    { startMs: 0, endMs: 5000, speakerKey: 'A' },
    { startMs: 5000, endMs: 10_000, speakerKey: 'B' },
  ];

  it('sorts words into time order, so database order cannot change the answer', () => {
    // Segment 1 starts before segment 0 ends — a merged chunk seam. Fed in row order the
    // moving cursor would already have retired A's turn by the time it reached w2.
    const segments: RSegment[] = [
      { id: 's0', idx: 0, startMs: 4000, endMs: 6000, hasWords: true },
      { id: 's1', idx: 1, startMs: 1000, endMs: 3000, hasWords: true },
    ];
    const words: RWord[] = [
      { id: 'w0', segmentId: 's0', idx: 0, startMs: 4000, endMs: 4800, text: 'late' },
      { id: 'w1', segmentId: 's0', idx: 1, startMs: 5200, endMs: 5900, text: 'later' },
      { id: 'w2', segmentId: 's1', idx: 0, startMs: 1000, endMs: 1800, text: 'early' },
      { id: 'w3', segmentId: 's1', idx: 1, startMs: 2000, endMs: 2800, text: 'earlier' },
    ];
    const result = reconcile(segments, words, turns);
    const byWord = new Map(result.words.map((w) => [w.wordId, w.speakerKey]));
    expect(byWord.get('w2')).toBe('A');
    expect(byWord.get('w3')).toBe('A');
    expect(byWord.get('w0')).toBe('A');
    expect(byWord.get('w1')).toBe('B');
    expect(result.stats.unassignedWords).toBe(0);
  });

  it('attributes a zero-length word by the instant it sits on', () => {
    // Providers do emit start === end. Under a plain overlap test such a word overlaps
    // nothing and falls through to `nearest`, or to null, for no reason but a timing quirk.
    const segments: RSegment[] = [{ id: 's0', idx: 0, startMs: 2000, endMs: 2000, hasWords: true }];
    const words: RWord[] = [{ id: 'w0', segmentId: 's0', idx: 0, startMs: 2000, endMs: 2000, text: '।' }];
    const result = reconcile(segments, words, turns);
    expect(result.words[0]!.speakerKey).toBe('A');
    expect(result.words[0]!.source).toBe('overlap');
  });

  it('handles no turns at all — a diarization that found nothing', () => {
    const segments: RSegment[] = [{ id: 's0', idx: 0, startMs: 0, endMs: 1000, hasWords: true }];
    const words: RWord[] = [{ id: 'w0', segmentId: 's0', idx: 0, startMs: 0, endMs: 900, text: 'x' }];
    const result = reconcile(segments, words, []);
    expect(result.words[0]!.speakerKey).toBeNull();
    expect(result.segments[0]!).toMatchObject({ speakerKey: null, purity: 0, needsReview: true, source: 'none' });
  });

  it('flags a segment whose words are split evenly between two speakers', () => {
    const segments: RSegment[] = [{ id: 's0', idx: 0, startMs: 4000, endMs: 6000, hasWords: true }];
    const words: RWord[] = [
      { id: 'w0', segmentId: 's0', idx: 0, startMs: 4000, endMs: 5000, text: 'his' },
      { id: 'w1', segmentId: 's0', idx: 1, startMs: 5000, endMs: 6000, text: 'hers' },
    ];
    const result = reconcile(segments, words, turns);
    expect(result.segments[0]!.purity).toBeCloseTo(0.5, 6);
    expect(result.segments[0]!.needsReview).toBe(true);
  });

  it('never reports a purity above 1, even when same-speaker turns overlap the span', () => {
    const segments: RSegment[] = [{ id: 's0', idx: 0, startMs: 1000, endMs: 2000, hasWords: false }];
    const overlapping: Turn[] = [
      { startMs: 0, endMs: 2000, speakerKey: 'A' },
      { startMs: 500, endMs: 2500, speakerKey: 'A' },
    ];
    const result = reconcile(segments, [], overlapping);
    expect(result.segments[0]!.purity).toBe(1);
  });

  it('counts every word exactly once and returns one assignment per segment', () => {
    const f = load('two-speaker-clean');
    const result = reconcile(f.segments, f.words, f.turns);
    expect(result.words).toHaveLength(f.words.length);
    expect(new Set(result.words.map((w) => w.wordId)).size).toBe(f.words.length);
    expect(result.segments).toHaveLength(f.segments.length);
    expect(result.stats.meanPurity).toBeCloseTo(1, 6);
    expect(result.stats.flaggedForReview).toBe(0);
  });

  it('is a pure function of its inputs and mutates none of them', () => {
    const f = load('overlapping-turns');
    const snapshot = JSON.stringify([f.segments, f.words, f.turns]);
    reconcile(f.segments, f.words, f.turns);
    expect(JSON.stringify([f.segments, f.words, f.turns])).toBe(snapshot);
  });
});

describe('voteSegments weighting', () => {
  it('weights by duration, not by word count', () => {
    // Eight short filler words from A against two long content words from B. Counting
    // votes calls this A's sentence; it is B's, and duration says so.
    const turns: Turn[] = [
      { startMs: 0, endMs: 1600, speakerKey: 'A' },
      { startMs: 1600, endMs: 5000, speakerKey: 'B' },
    ];
    const words: RWord[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `a${i}`,
        segmentId: 's0',
        idx: i,
        startMs: i * 200,
        endMs: i * 200 + 150,
        text: 'um',
      })),
      { id: 'b0', segmentId: 's0', idx: 8, startMs: 1700, endMs: 3000, text: 'compensation' },
      { id: 'b1', segmentId: 's0', idx: 9, startMs: 3100, endMs: 4600, text: 'unpaid' },
    ];
    const segments: RSegment[] = [{ id: 's0', idx: 0, startMs: 0, endMs: 4600, hasWords: true }];
    const assigned = assignWords(words, turns);
    expect(assigned.filter((x) => x.speakerKey === 'A')).toHaveLength(8);

    const [seg] = voteSegments(segments, words, assigned, turns);
    expect(seg!.speakerKey).toBe('B');
    expect(seg!.purity).toBeCloseTo(2800 / 4000, 6);
  });
});
