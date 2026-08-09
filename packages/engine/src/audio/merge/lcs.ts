/**
 * Longest common subsequence with backpointers.
 *
 * Used to align the two transcriptions of a chunk overlap. The windows are bounded to ≤60
 * words or ≤400 graphemes per side, so the worst case is 160k DP cells per seam and about
 * 65 seams in an hour of audio — microseconds. There is no reason to optimise this and
 * every reason to keep it readable.
 */

export interface AlignedPair {
  /** Index into `a`. */
  i: number;
  /** Index into `b`. */
  j: number;
}

/**
 * The aligned index pairs of one longest common subsequence, in order.
 *
 * A `Uint16Array` holds the lengths: the windows are small enough that 65,535 is an
 * unreachable ceiling, and a flat typed array beats a nested number[][] for both
 * allocation and cache behaviour.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): AlignedPair[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  // Walk forward from the top-left, which yields the pairs already in order.
  const pairs: AlignedPair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ i, j });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Dice similarity over the aligned windows: `2·|LCS| / (|a| + |b|)`.
 *
 * Chosen over plain LCS length because it is symmetric and normalised — a seam where one
 * side happened to transcribe more words should not score higher simply for having more
 * to match against.
 */
export function diceScore(matched: number, aLength: number, bLength: number): number {
  const total = aLength + bLength;
  if (total === 0) return 1;
  return (2 * matched) / total;
}
