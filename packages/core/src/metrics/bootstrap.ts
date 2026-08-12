import { type EditStats } from './cer.js';

/**
 * Seeded percentile bootstrap over per-clip statistics.
 *
 * The interval is not decoration. Phase 5 §5.9 assigns `verified` on the **upper bound** of
 * the 95% interval, not on the point estimate — `ciHi <= 0.20 && ciHi / baseline <= 1.15` —
 * because at n=30 the point estimate clears the line long before the interval does. That is
 * the mechanical reason `verified` also requires human sign-off, and it is why this function
 * has to be reproducible: a threshold argument is only settleable if the number can be
 * recomputed from the runlog by someone who was not there.
 */

/**
 * Resample **clips**, not characters, and recompute the ratio of sums each time — the same
 * estimator as the point value.
 *
 * Resampling characters would treat a 200-character clip as 200 independent observations,
 * which they are not: errors within a clip are correlated by speaker, recording and topic,
 * and the interval would come out far too narrow. The clip is the unit of independence, so
 * the clip is the unit of resampling.
 *
 * Returns `null` for an empty input rather than `[NaN, NaN]`. Every other metric in this
 * directory answers "undefined" with `null`, and a NaN would print as `NaN` in a report or,
 * worse, compare `false` against every threshold and quietly pass a language.
 */
export function bootstrapCi(
  perClip: readonly EditStats[],
  b = 2000,
  seed = 1,
  alpha = 0.05,
): readonly [number, number] | null {
  const n = perClip.length;
  if (n === 0) return null;

  const rnd = mulberry32(seed);
  const samples = new Float64Array(b);

  for (let k = 0; k < b; k++) {
    let e = 0;
    let r = 0;
    for (let i = 0; i < n; i++) {
      const p = perClip[(rnd() * n) | 0]!;
      e += p.edits;
      r += p.refLen;
    }
    samples[k] = r === 0 ? 0 : e / r;
  }

  // TypedArray.prototype.sort is numeric by default — unlike Array.prototype.sort, which
  // would sort these lexicographically and produce a plausible, wrong interval.
  samples.sort();

  return [
    samples[Math.floor((alpha / 2) * b)]!,
    samples[Math.min(b - 1, Math.ceil((1 - alpha / 2) * b) - 1)]!,
  ] as const;
}

/**
 * Mulberry32. Small, fast, and — the only property that matters here — identical on every
 * machine and every Node version, which `Math.random()` is not.
 *
 * The seed is written to the runlog, so `thibi eval report --run <id>` reproduces the
 * interval in the report exactly, with no network and no provider calls.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
