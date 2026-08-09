/**
 * Chunk planning: where to cut, and how much earlier to start each cut.
 *
 * `planBoundaries` is ported from `lib/audio/chunk.ts:79-102` with seconds converted to
 * integer milliseconds. Its back-half-of-window rule and the reasoning for the hard-cut
 * fallback are both correct and non-obvious, so the comments travel verbatim.
 */

export interface ChunkPlan {
  idx: number;
  /** Where the extracted audio starts: `contentStartMs - overlapLeadMs`. */
  offsetMs: number;
  /** The planned boundary — the seam this chunk owns from. */
  contentStartMs: number;
  endMs: number;
  overlapLeadMs: number;
}

export interface PlanOptions {
  /** Hard ceiling on the *extracted* length of any chunk. */
  maxMs: number;
  /** How much earlier than its boundary each chunk after the first starts. */
  overlapLeadMs: number;
  /** Chunks shorter than this are folded away rather than sent. */
  minMs: number;
}

/**
 * Choose split points no longer than `maxMs` apart, snapping to the nearest silence when
 * one falls in a usable window. Burmese speech can run a long way without a clear pause,
 * so a hard cut at the limit is the required fallback — an oversized chunk would simply be
 * rejected by the provider.
 */
export function planBoundaries(
  durationMs: number,
  silencesMs: readonly number[],
  maxMs: number,
): number[] {
  const boundaries: number[] = [0];
  let cursor = 0;

  while (durationMs - cursor > maxMs) {
    const target = cursor + maxMs;
    // Only consider silences in the back half of the window, so chunks stay reasonably
    // full rather than splitting a few seconds in.
    const earliest = cursor + maxMs * 0.5;
    const candidates = silencesMs.filter((s) => s > earliest && s <= target);
    const next = candidates.length ? candidates[candidates.length - 1]! : target;
    boundaries.push(next);
    cursor = next;
  }

  boundaries.push(durationMs);
  return boundaries;
}

/**
 * Wrap `planBoundaries` with the overlap lead.
 *
 * **The budget is reserved before planning, not checked afterwards.** A 55 s plan plus a
 * 1.2 s lead extracts 56.2 s, which exceeds the very cap the plan was built to respect —
 * the provider then rejects a chunk the planner believed was legal. Subtracting the lead
 * from the planning maximum is a one-line fix and it has a named regression test, because
 * it is invisible until a real file is 200 ms over.
 */
export function planChunks(
  durationMs: number,
  silencesMs: readonly number[],
  options: PlanOptions,
): ChunkPlan[] {
  const { maxMs, minMs } = options;
  if (durationMs <= 0) return [];

  // A lead at or above the chunk maximum leaves no room to plan in: reserving it would
  // drive the planning window to nothing and produce thousands of millisecond-long chunks
  // rather than an error. `--overlap-ms` is user input, so clamp rather than throw.
  const overlapLeadMs = Math.max(0, Math.min(options.overlapLeadMs, Math.floor(maxMs / 2)));

  const planMax = Math.max(1, maxMs - overlapLeadMs);
  const boundaries = planBoundaries(durationMs, silencesMs, planMax);

  const plans: ChunkPlan[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const contentStartMs = boundaries[i]!;
    const endMs = boundaries[i + 1]!;
    // Chunk 0 has nothing before it to overlap with, and near t=0 the lead is clamped to
    // whatever audio actually exists.
    const lead = i === 0 ? 0 : Math.min(overlapLeadMs, contentStartMs);
    if (endMs - contentStartMs < minMs) continue;
    plans.push({
      idx: plans.length,
      offsetMs: contentStartMs - lead,
      contentStartMs,
      endMs,
      overlapLeadMs: lead,
    });
  }
  return plans;
}

/**
 * Derive a duration budget from the measured bitrate and take the tighter of the two.
 *
 * Ported verbatim from `lib/audio/chunk.ts:132-136`, including the reason: size can bind
 * before duration — a dense 55 s chunk may still exceed 10 MB.
 */
export function durationBudgetMs(
  bytes: number,
  durationMs: number,
  limits: { maxBytes: number; maxMs: number },
): number {
  if (durationMs <= 0 || bytes <= 0) return limits.maxMs;
  const bytesPerMs = bytes / durationMs;
  // The 0.9 is headroom: FLAC compression varies across a file, so the average bitrate
  // under-predicts the densest chunk.
  const byteBoundMs = Math.max(5000, Math.floor((limits.maxBytes * 0.9) / bytesPerMs));
  return Math.min(limits.maxMs, byteBoundMs);
}
