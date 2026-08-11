/**
 * Speaker identity across re-diarizations.
 *
 * A diarizer's speaker keys are anonymous and arbitrary: `SPEAKER_00` in one run is not
 * `SPEAKER_00` in the next, because the numbering falls out of whatever order clustering
 * happened to produce. Meanwhile a human has typed *"Daw Khin"* against one of them.
 *
 * *"Speaker 01 is Daw Khin"* is a fact about the recording, not about a run — which is why
 * `speakers` is scoped to `job_id` — and this module is what keeps it true when the job is
 * transcribed again. Losing the name on every re-transcription would be the most annoying
 * possible bug in this feature, and one that only appears after a user has done real work.
 */
import { hungarian } from '@thibi/core';
import type { ReconcileOptions } from './reconcile.js';
import { DEFAULTS } from './reconcile.js';

/** Half-open `[startMs, endMs)` spans. Need not be sorted or disjoint. */
export type Intervals = ReadonlyArray<readonly [number, number]>;

export interface PriorSpeaker {
  /** The durable `speakers` row id — what a match preserves. */
  speakerId: string;
  key: string;
  /**
   * The union of intervals currently attributed to this speaker across *any* earlier run
   * of the job — **not** the previous diarization's raw turns. Matching against attributed
   * time is what lets a human's manual reassignment feed forward into the next run.
   */
  intervals: Intervals;
}

export interface FreshSpeaker {
  key: string;
  intervals: Intervals;
}

/** Total covered time, with overlaps counted once. */
export function totalMs(intervals: Intervals): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

/** Time covered by both sets, overlaps within each set counted once. */
export function intervalOverlapMs(a: Intervals, b: Intervals): number {
  const A = [...a].sort((x, y) => x[0] - y[0]);
  const B = [...b].sort((x, y) => x[0] - y[0]);
  // Merge each side first, so a speaker with two overlapping turns cannot double-count the
  // same millisecond of agreement and inflate its own claim on a prior identity.
  const merge = (xs: typeof A): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const [s, e] of xs) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  };
  const ma = merge(A);
  const mb = merge(B);

  let total = 0;
  let i = 0;
  let j = 0;
  while (i < ma.length && j < mb.length) {
    total += Math.max(0, Math.min(ma[i]![1], mb[j]![1]) - Math.max(ma[i]![0], mb[j]![0]));
    if (ma[i]![1] < mb[j]![1]) i++;
    else j++;
  }
  return total;
}

/**
 * Map fresh speaker keys to durable `speakers` row ids by maximising total overlap.
 *
 * One-to-one and globally optimal via Hungarian assignment, not greedy: greedy takes the
 * single best pair first and can strand a later speaker with the partner it needed more.
 *
 * Returns only confident matches. A fresh key absent from the map means **mint a new
 * speaker**, and a prior speaker nobody matched is **kept, never deleted** — if this run
 * found three speakers where the last found four, the fourth's name survives, unattributed.
 */
export function matchSpeakers(
  prior: readonly PriorSpeaker[],
  fresh: readonly FreshSpeaker[],
  o: ReconcileOptions = DEFAULTS,
): Map<string, string> {
  const n = prior.length;
  const m = fresh.length;
  if (n === 0 || m === 0) return new Map();
  if (Math.max(n, m) > 64) {
    // Not a performance limit — 64³ is nothing. More than 64 speakers in one recording
    // means the diarization failed, and silently matching names onto that failure would
    // scatter a human's work across garbage clusters.
    throw new Error(`Refusing speaker identity matching above 64 speakers (${n} prior, ${m} fresh)`);
  }

  // Sorting both sides makes the padded matrix — and therefore the tie-breaking inside
  // `hungarian` — a function of the keys rather than of caller iteration order.
  const P = [...prior].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const F = [...fresh].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const size = Math.max(n, m);
  const cost: number[][] = [];
  const ovl: number[][] = [];
  for (let i = 0; i < size; i++) {
    const costRow: number[] = [];
    const ovlRow: number[] = [];
    for (let j = 0; j < size; j++) {
      // Padding cells score zero overlap, so a dummy is always beaten by any real pair
      // that clears the floor below, and never wins one that does not.
      const value = i < n && j < m ? intervalOverlapMs(P[i]!.intervals, F[j]!.intervals) : 0;
      ovlRow.push(value);
      costRow.push(-value); // maximise overlap ≡ minimise negative overlap
    }
    cost.push(costRow);
    ovl.push(ovlRow);
  }

  const out = new Map<string, string>();
  for (const [i, j] of hungarian(cost)) {
    if (i >= n || j >= m) continue;
    const overlap = ovl[i]![j]!;
    const floor = Math.max(
      o.minIdentityOverlapMs,
      o.minIdentityOverlapFrac * Math.min(totalMs(P[i]!.intervals), totalMs(F[j]!.intervals)),
    );
    // Below the floor this is coincidence, not identity. **A wrong identity carry-over is
    // worse than an extra speaker row**, because a human already put a real name on the
    // old one and the mistake is invisible from the transcript.
    if (overlap < floor) continue;
    out.set(F[j]!.key, P[i]!.speakerId);
  }
  return out;
}
