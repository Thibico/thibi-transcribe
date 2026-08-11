/**
 * Optimal assignment on a square cost matrix — the Hungarian (Kuhn–Munkres) algorithm, in
 * the O(n³) shortest-augmenting-path form (Jonker–Volgenant potentials over a dense
 * matrix).
 *
 * It exists for one caller: preserving speaker identity across re-diarizations. When a job
 * is transcribed a second time, the diarizer emits fresh anonymous keys — `SPEAKER_00`,
 * `SPEAKER_01` — in whatever order clustering happened to produce, and a human has already
 * put *"Daw Khin"* on one of the old ones. Matching fresh keys to prior speakers by
 * overlap, one-to-one, globally optimal, is exactly an assignment problem. Greedy
 * best-overlap is not the same thing and gets it wrong whenever the greedy first pick
 * steals the partner a later row needed more.
 *
 * **Hand-written rather than a dependency, deliberately.** Real matrices are ≤ 12×12 —
 * more than a dozen speakers in one recording is a different kind of failure, and
 * `matchSpeakers` refuses above 64 — so 12³ = 1728 operations. `@thibi/core` is the
 * zero-runtime-dependency package by policy, `munkres-js` is unmaintained, and this is a
 * textbook algorithm with a closed test set: it is brute-force verifiable against every
 * permutation at n ≤ 8, which the tests do.
 */

/** A `[row, column]` pair. One per row, in row order. */
export type Assignment = readonly [number, number];

/**
 * Minimum-cost perfect matching of rows to columns.
 *
 * `cost` must be square and finite. Callers with a rectangular problem pad it themselves —
 * `matchSpeakers` pads with zero-overlap dummies — because what a padded cell should cost
 * is a question about the caller's problem, not about the algorithm.
 *
 * Costs may be negative; the identity matcher passes `-overlapMs` precisely so that
 * minimising cost maximises overlap.
 *
 * Ties are broken by lowest column index, which makes the result a deterministic function
 * of the input rather than of iteration order. That matters: the mapping decides which
 * human-entered speaker name lands on which fresh key, so an identical re-run has to
 * produce an identical answer. There is a property test for it.
 */
export function hungarian(cost: ReadonlyArray<ReadonlyArray<number>>): Assignment[] {
  const n = cost.length;
  if (n === 0) return [];
  for (const row of cost) {
    if (row.length !== n) throw new Error(`hungarian: matrix must be square, got ${n}×${row.length}`);
    for (const v of row) {
      if (!Number.isFinite(v)) throw new Error('hungarian: costs must be finite');
    }
  }

  // Potentials, 1-indexed with a sentinel at 0 — the standard formulation, kept because
  // the off-by-ones in the compact 0-indexed version are where this algorithm is usually
  // got wrong.
  const u = new Float64Array(n + 1); // row potentials
  const v = new Float64Array(n + 1); // column potentials
  const colToRow = new Int32Array(n + 1).fill(0); // column j ↦ matched row, 0 = free
  const way = new Int32Array(n + 1).fill(0); // column j ↦ predecessor column on the path

  for (let row = 1; row <= n; row++) {
    colToRow[0] = row;
    let col = 0; // the "virtual" column the search starts from
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);

    // Grow a shortest augmenting path until it reaches a free column.
    do {
      used[col] = 1;
      const curRow = colToRow[col]!;
      const costRow = cost[curRow - 1]!;
      let delta = Infinity;
      let next = 0;

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const reduced = costRow[j - 1]! - u[curRow]! - v[j]!;
        if (reduced < minv[j]!) {
          minv[j] = reduced;
          way[j] = col;
        }
        // Strict `<` keeps the lowest column index on a tie, which is what makes the
        // result deterministic.
        if (minv[j]! < delta) {
          delta = minv[j]!;
          next = j;
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[colToRow[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      col = next;
    } while (colToRow[col] !== 0);

    // Walk the path back, flipping matched and unmatched edges.
    do {
      const prev = way[col]!;
      colToRow[col] = colToRow[prev]!;
      col = prev;
    } while (col !== 0);
  }

  const out: Assignment[] = new Array(n);
  for (let j = 1; j <= n; j++) {
    const row = colToRow[j]! - 1;
    out[row] = [row, j - 1];
  }
  return out;
}

/** Total cost of an assignment. Convenience for tests and for logging a match's quality. */
export function assignmentCost(
  cost: ReadonlyArray<ReadonlyArray<number>>,
  assignment: ReadonlyArray<Assignment>,
): number {
  let total = 0;
  for (const [i, j] of assignment) total += cost[i]![j]!;
  return total;
}
