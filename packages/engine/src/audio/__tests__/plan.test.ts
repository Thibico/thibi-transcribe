import { describe, expect, it } from 'vitest';
import { durationBudgetMs, planBoundaries, planChunks } from '../plan.js';

const MAX = 55_000;
const LEAD = 1200;
const opts = { maxMs: MAX, overlapLeadMs: LEAD, minMs: 100 };

describe('planBoundaries', () => {
  it('returns a single span when the duration fits', () => {
    expect(planBoundaries(30_000, [], MAX)).toEqual([0, 30_000]);
  });

  it('snaps to the last silence in the back half of the window', () => {
    // Silences at 20 s, 40 s and 52 s with a 55 s window: 20 s is in the front half and
    // ignored, 52 s is the latest usable one.
    expect(planBoundaries(120_000, [20_000, 40_000, 52_000], MAX)[1]).toBe(52_000);
  });

  it('ignores silences in the front half so chunks stay reasonably full', () => {
    // A silence at 8 s would otherwise produce an 8-second chunk and 14 more requests.
    expect(planBoundaries(120_000, [8000], MAX)[1]).toBe(MAX);
  });

  it('hard-cuts at the limit when no silence is usable', () => {
    // Burmese speech can run a long way without a clear pause; an oversized chunk would
    // simply be rejected, so a hard cut is the required fallback.
    const boundaries = planBoundaries(165_000, [], MAX);
    expect(boundaries).toEqual([0, 55_000, 110_000, 165_000]);
  });
});

describe('planChunks', () => {
  it('gives chunk 0 no lead', () => {
    const [first] = planChunks(120_000, [], opts);
    expect(first).toMatchObject({ idx: 0, offsetMs: 0, contentStartMs: 0, overlapLeadMs: 0 });
  });

  it('starts every later chunk early by the lead', () => {
    const plans = planChunks(200_000, [], opts);
    for (const plan of plans.slice(1)) {
      expect(plan.overlapLeadMs).toBe(LEAD);
      expect(plan.offsetMs).toBe(plan.contentStartMs - LEAD);
    }
  });

  /**
   * The named regression from the plan.
   *
   * A 55 s plan plus a 1.2 s lead extracts 56.2 s, which exceeds the very cap the plan was
   * built to respect — and the provider then rejects a chunk the planner believed was
   * legal. Reserving the lead before planning is the one-line fix; without it this is
   * invisible until a real file comes back 200 ms over.
   */
  it('never lets the overlap lead push a chunk over the cap', () => {
    for (const duration of [120_000, 200_000, 3_600_000]) {
      for (const plan of planChunks(duration, [], opts)) {
        expect(plan.endMs - plan.offsetMs).toBeLessThanOrEqual(MAX);
      }
    }
  });

  it('holds the cap when silences move the boundaries around', () => {
    const silences = Array.from({ length: 200 }, (_, i) => i * 3137);
    for (const plan of planChunks(600_000, silences, opts)) {
      expect(plan.endMs - plan.offsetMs).toBeLessThanOrEqual(MAX);
    }
  });

  it('clamps the lead near t=0', () => {
    // A boundary at 1000 ms cannot start 1200 ms earlier — there is no audio there.
    // Reachable when a silence lands early in a short window: max 3000, lead 1200 leaves
    // a 1800 ms planning window whose back half starts at 900 ms.
    const plans = planChunks(10_000, [1000], { maxMs: 3000, overlapLeadMs: 1200, minMs: 100 });
    const second = plans[1]!;
    expect(second.contentStartMs).toBe(1000);
    expect(second.offsetMs).toBe(0);
    expect(second.overlapLeadMs).toBe(1000);
  });

  it('clamps a lead that would leave no room to plan in', () => {
    // `--overlap-ms` is user input. A lead at or above the chunk maximum would drive the
    // planning window to nothing and yield thousands of millisecond-long chunks; clamping
    // to half the maximum keeps the plan sane instead of failing obscurely.
    const plans = planChunks(10_000, [], { maxMs: 1000, overlapLeadMs: 9000, minMs: 100 });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.length).toBeLessThan(30);
    for (const plan of plans) {
      expect(plan.endMs - plan.offsetMs).toBeLessThanOrEqual(1000);
      expect(plan.overlapLeadMs).toBeLessThanOrEqual(500);
    }
  });

  it('numbers chunks contiguously after dropping short tails', () => {
    // A 3 ms remainder must not become a chunk, and must not leave a gap in the indices.
    const plans = planChunks(110_003, [], opts);
    expect(plans.map((p) => p.idx)).toEqual(plans.map((_, i) => i));
  });

  it('returns nothing for a zero-length input', () => {
    expect(planChunks(0, [], opts)).toEqual([]);
  });
});

describe('durationBudgetMs', () => {
  it('lets size bind before duration', () => {
    // 250 kB/s against a 10 MB cap: 10 MB × 0.9 / 250 kB/s ≈ 36 s, tighter than the 55 s
    // duration limit. A dense 55 s chunk would exceed the byte cap.
    const budget = durationBudgetMs(250_000 * 60, 60_000, {
      maxBytes: 10 * 1024 * 1024,
      maxMs: MAX,
    });
    expect(budget).toBeGreaterThan(30_000);
    expect(budget).toBeLessThan(40_000);
  });

  it('keeps the duration limit when the file is sparse', () => {
    expect(durationBudgetMs(1000, 600_000, { maxBytes: 10 * 1024 * 1024, maxMs: MAX })).toBe(MAX);
  });

  it('falls back to the duration limit when the bitrate is unknowable', () => {
    expect(durationBudgetMs(0, 0, { maxBytes: 10 * 1024 * 1024, maxMs: MAX })).toBe(MAX);
  });
});
