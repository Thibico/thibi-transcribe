/**
 * Two-row Levenshtein distance over an array of units.
 *
 * Every other metric in this directory is a wrapper around this function: CER passes code
 * points or grapheme clusters, WER passes word tokens. There is one distance implementation
 * so a bug here shows up in every metric at once rather than in one of them quietly.
 *
 * Unit cost 1 for substitution, insertion and deletion — the same convention as `jiwer`,
 * `rapidfuzz` and every published CER/WER number. A transposition therefore costs 2, not 1;
 * this is *not* Damerau-Levenshtein and must not become it, because the parity fixture is
 * generated against libraries that are not.
 */

/**
 * Edit distance between two unit arrays.
 *
 * Distance is symmetric, so the shorter sequence goes on the row axis and memory is
 * O(min(|src|, |dst|)) rather than O(|dst|). At corpus scale — a 200-character Burmese
 * reference against a runaway 4000-character hallucination — that is the difference between
 * two 200-entry rows and two 4000-entry ones.
 */
export function levenshtein(src: readonly string[], dst: readonly string[]): number {
  let a = src;
  let b = dst;
  if (a.length < b.length) {
    const t = a;
    a = b;
    b = t;
  }

  const m = b.length;
  if (m === 0) return a.length;

  // Uint32Array, not number[]: a corpus-level call can be tens of thousands of units wide
  // and this is the inner loop of the whole eval harness.
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1]! + (ai === b[j - 1] ? 0 : 1);
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    // Swap the row references rather than copying: `prev.set(cur)` is an O(m) memcpy on
    // every one of |a| iterations, which is the same asymptotic cost as the DP itself.
    const t = prev;
    prev = cur;
    cur = t;
  }

  return prev[m]!;
}
