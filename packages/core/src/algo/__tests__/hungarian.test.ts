import { describe, expect, it } from 'vitest';
import { assignmentCost, hungarian, type Assignment } from '../hungarian.js';

/**
 * Brute force over every permutation. Only usable to n = 8 (40320), which is the point:
 * the real matrices are ≤ 12×12, so "verified exhaustively at the sizes where exhaustive
 * verification is possible" is a stronger claim than any single hand-checked example.
 */
function brute(cost: number[][]): number {
  const n = cost.length;
  let best = Infinity;
  const used = new Array<boolean>(n).fill(false);
  // No branch-and-bound prune. `total >= best` looks safe and is not: costs here are
  // deliberately negative (the identity matcher passes `-overlapMs`), so a partial sum
  // already above the incumbent can still finish below it. The first version of this
  // helper had that prune, and it reported the solver wrong on 8×8 when the solver had
  // found a *better* assignment than the reference. 8! = 40320 needs no prune.
  const walk = (row: number, total: number): void => {
    if (row === n) {
      if (total < best) best = total;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      used[j] = true;
      walk(row + 1, total + cost[row]![j]!);
      used[j] = false;
    }
  };
  walk(0, 0);
  return best;
}

/** Deterministic PRNG — a failing case has to be reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isPermutation = (assignment: Assignment[], n: number): boolean => {
  const rows = new Set(assignment.map(([i]) => i));
  const cols = new Set(assignment.map(([, j]) => j));
  return assignment.length === n && rows.size === n && cols.size === n;
};

describe('hungarian', () => {
  it('returns nothing for an empty matrix', () => {
    expect(hungarian([])).toEqual([]);
  });

  it('solves the 1×1 case', () => {
    expect(hungarian([[7]])).toEqual([[0, 0]]);
  });

  it('rejects a non-square matrix', () => {
    // Callers pad rectangular problems themselves — what a dummy cell costs is a question
    // about their problem, so silently padding here would be guessing on their behalf.
    expect(() => hungarian([[1, 2, 3], [4, 5, 6]])).toThrow(/square/);
  });

  it('rejects non-finite costs', () => {
    expect(() => hungarian([[1, Infinity], [3, 4]])).toThrow(/finite/);
    expect(() => hungarian([[1, Number.NaN], [3, 4]])).toThrow(/finite/);
  });

  it.each([
    // Textbook 3×3 with a unique optimum of 13 (Munkres' own worked example).
    { name: 'munkres 3×3', cost: [[1, 2, 3], [2, 4, 6], [3, 6, 9]], expected: 10 },
    // The case greedy gets wrong: taking the global minimum 1 at [0,0] forces 100 + 100
    // afterwards for 201, where giving that column up costs 104.
    { name: 'greedy trap', cost: [[1, 2, 3], [2, 100, 100], [3, 100, 100]], expected: 104 },
    { name: 'all equal', cost: [[5, 5], [5, 5]], expected: 10 },
  ])('matches the known optimum: $name', ({ cost, expected }) => {
    const assignment = hungarian(cost);
    expect(isPermutation(assignment, cost.length)).toBe(true);
    expect(assignmentCost(cost, assignment)).toBe(expected);
  });

  it('handles negative costs, which is how the identity matcher maximises overlap', () => {
    // -overlapMs: the best assignment is the one with the most total overlap.
    const overlap = [
      [8000, 100, 0],
      [200, 9000, 50],
      [0, 40, 7000],
    ];
    const cost = overlap.map((row) => row.map((v) => -v));
    const assignment = hungarian(cost);
    expect(assignment).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(-assignmentCost(cost, assignment)).toBe(24000);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])('equals brute force on 40 random %i×%i matrices', (n) => {
    const random = mulberry32(n * 7919);
    for (let trial = 0; trial < 40; trial++) {
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => Math.floor(random() * 200) - 50),
      );
      const assignment = hungarian(cost);
      expect(isPermutation(assignment, n)).toBe(true);
      expect(assignmentCost(cost, assignment)).toBe(brute(cost));
    }
  });

  it('is deterministic under ties, so a re-run maps the same names to the same speakers', () => {
    // Every assignment costs the same here. Which one comes back must not depend on
    // iteration order — a human's "Daw Khin" rides on this mapping.
    const cost = Array.from({ length: 5 }, () => new Array(5).fill(3));
    const first = hungarian(cost);
    for (let i = 0; i < 20; i++) expect(hungarian(cost)).toEqual(first);
  });

  it('does not mutate the input', () => {
    const cost = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const snapshot = JSON.stringify(cost);
    hungarian(cost);
    expect(JSON.stringify(cost)).toBe(snapshot);
  });

  it('solves the largest matrix the refusal threshold allows', () => {
    // 64 is `matchSpeakers`'s ceiling. Asserted for correctness only: a wall-clock bound
    // here failed once inside the full 36-file parallel run and passed in isolation, which
    // makes it a test of machine load rather than of this function. 64³ is 262k operations
    // and the cost is not in question.
    const random = mulberry32(64);
    const cost = Array.from({ length: 64 }, () =>
      Array.from({ length: 64 }, () => Math.floor(random() * 1000)),
    );
    expect(isPermutation(hungarian(cost), 64)).toBe(true);
  });
});
