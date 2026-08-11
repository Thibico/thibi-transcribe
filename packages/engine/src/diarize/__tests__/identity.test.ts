import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  intervalOverlapMs,
  matchSpeakers,
  totalMs,
  type FreshSpeaker,
  type PriorSpeaker,
} from '../identity.js';

const FIXTURES = resolve(import.meta.dirname, '../__fixtures__');
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as Fixture;

interface Fixture {
  name: string;
  why: string;
  prior: PriorSpeaker[];
  fresh: FreshSpeaker[];
  expect: {
    mapping: Record<string, string>;
    unmatchedFresh?: string[];
    unmatchedPrior?: string[];
  };
}

/** Deterministic PRNG, so a failing property case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('interval arithmetic', () => {
  it('counts overlapping intervals within one speaker only once', () => {
    // A speaker with two overlapping turns must not be able to double-count the same
    // millisecond and inflate its own claim on a prior identity.
    expect(totalMs([[0, 1000], [500, 1500]])).toBe(1500);
    expect(totalMs([[0, 1000], [2000, 3000]])).toBe(2000);
    expect(totalMs([])).toBe(0);
    expect(intervalOverlapMs([[0, 1000], [500, 1500]], [[0, 2000]])).toBe(1500);
  });

  it('is order-insensitive', () => {
    expect(intervalOverlapMs([[2000, 3000], [0, 1000]], [[900, 2100]])).toBe(200);
    expect(intervalOverlapMs([[0, 1000], [2000, 3000]], [[900, 2100]])).toBe(200);
  });

  it('is zero for disjoint sets', () => {
    expect(intervalOverlapMs([[0, 1000]], [[1000, 2000]])).toBe(0);
  });
});

describe('matchSpeakers fixtures', () => {
  it.each(['rediarize-identity', 'rediarize-new-speaker', 'rediarize-fewer-speakers'])('%s', (name) => {
    const f = load(name);
    const mapping = matchSpeakers(f.prior, f.fresh);

    expect(Object.fromEntries(mapping)).toEqual(f.expect.mapping);

    for (const key of f.expect.unmatchedFresh ?? []) {
      expect(mapping.has(key), `${key} must mint a new speaker, not inherit one`).toBe(false);
    }
    const claimed = new Set(mapping.values());
    for (const speakerId of f.expect.unmatchedPrior ?? []) {
      expect(claimed.has(speakerId), `${speakerId} must be left unmapped, and kept`).toBe(false);
    }
  });
});

describe('matchSpeakers invariants', () => {
  const prior: PriorSpeaker[] = [
    { speakerId: 'p0', key: 'speaker-00', intervals: [[0, 30_000]] },
    { speakerId: 'p1', key: 'speaker-01', intervals: [[30_000, 60_000]] },
  ];

  it('returns nothing when either side is empty', () => {
    expect(matchSpeakers([], [{ key: 'A', intervals: [[0, 1000]] }]).size).toBe(0);
    expect(matchSpeakers(prior, []).size).toBe(0);
  });

  it('refuses above 64 speakers rather than scattering names across a failed diarization', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      key: `S${i}`,
      intervals: [[i * 1000, i * 1000 + 900]] as Array<[number, number]>,
    }));
    expect(() => matchSpeakers(prior, many)).toThrow(/above 64 speakers/);
  });

  it('is injective — two fresh keys can never land on one prior speaker', () => {
    const fresh: FreshSpeaker[] = [
      { key: 'A', intervals: [[0, 20_000]] },
      { key: 'B', intervals: [[0, 25_000]] }, // both overlap p0 heavily
    ];
    const mapping = matchSpeakers(prior, fresh);
    expect(new Set(mapping.values()).size).toBe(mapping.size);
  });

  it('beats greedy: the globally best assignment, not the single best pair', () => {
    // Greedy takes B→p0 first (25 s, the largest single overlap), stranding A with p1 at
    // 5 s for a total of 30 s. The optimum is A→p0 and B→p1 for 20 + 28 = 48 s.
    const fresh: FreshSpeaker[] = [
      { key: 'A', intervals: [[0, 20_000]] },
      { key: 'B', intervals: [[5000, 30_000], [32_000, 60_000]] },
    ];
    const mapping = matchSpeakers(prior, fresh);
    expect(mapping.get('A')).toBe('p0');
    expect(mapping.get('B')).toBe('p1');
  });

  it('is invariant to the order the speakers are passed in', () => {
    const f = load('rediarize-identity');
    const expected = Object.fromEntries(matchSpeakers(f.prior, f.fresh));
    const random = mulberry32(11);
    for (let trial = 0; trial < 25; trial++) {
      const shuffle = <T>(xs: T[]): T[] =>
        [...xs].map((x) => [random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
      expect(Object.fromEntries(matchSpeakers(shuffle(f.prior), shuffle(f.fresh)))).toEqual(expected);
    }
  });

  it('is stable across repeated calls, so a re-run maps the same names', () => {
    const f = load('rediarize-identity');
    const first = Object.fromEntries(matchSpeakers(f.prior, f.fresh));
    for (let i = 0; i < 10; i++) {
      expect(Object.fromEntries(matchSpeakers(f.prior, f.fresh))).toEqual(first);
    }
  });

  it('applies the fractional floor, not just the absolute one', () => {
    // 3 s of overlap clears the 2000 ms absolute floor. Between two speakers who each talk
    // for 30 s it is still coincidence: the fractional floor is 0.2 × 30 s = 6 s.
    const longFresh: FreshSpeaker[] = [{ key: 'A', intervals: [[27_000, 57_000]] }];
    expect(matchSpeakers([prior[0]!], longFresh).size).toBe(0);

    // The floor takes the *minimum* of the two, deliberately. The same 3 s against a fresh
    // speaker who only ever spoke for 3 s is all of them, and that is identity.
    const shortFresh: FreshSpeaker[] = [{ key: 'A', intervals: [[27_000, 30_000]] }];
    expect(matchSpeakers([prior[0]!], shortFresh).get('A')).toBe('p0');
  });

  it('mints a new speaker rather than hijacking a name when nothing clears the floor', () => {
    const fresh: FreshSpeaker[] = [{ key: 'A', intervals: [[100_000, 130_000]] }];
    expect(matchSpeakers(prior, fresh).size).toBe(0);
  });

  it('does not mutate its inputs', () => {
    const f = load('rediarize-identity');
    const snapshot = JSON.stringify([f.prior, f.fresh]);
    matchSpeakers(f.prior, f.fresh);
    expect(JSON.stringify([f.prior, f.fresh])).toBe(snapshot);
  });

  it('survives a permutation of any size up to the refusal threshold', () => {
    // The property the whole feature rests on: N speakers, keys permuted, every name back
    // where it belongs.
    const random = mulberry32(7);
    for (const n of [1, 2, 3, 5, 8, 12]) {
      const priors: PriorSpeaker[] = Array.from({ length: n }, (_, i) => ({
        speakerId: `p${i}`,
        key: `speaker-${String(i).padStart(2, '0')}`,
        intervals: [[i * 60_000, i * 60_000 + 50_000]] as Array<[number, number]>,
      }));
      const order = Array.from({ length: n }, (_, i) => i)
        .map((i) => [random(), i] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, i]) => i);
      const fresh: FreshSpeaker[] = order.map((original, j) => ({
        key: `SPEAKER_${String(j).padStart(2, '0')}`,
        intervals: [[original * 60_000 + 200, original * 60_000 + 49_000]] as Array<[number, number]>,
      }));

      const mapping = matchSpeakers(priors, fresh);
      expect(mapping.size).toBe(n);
      order.forEach((original, j) => {
        expect(mapping.get(`SPEAKER_${String(j).padStart(2, '0')}`)).toBe(`p${original}`);
      });
    }
  });
});
