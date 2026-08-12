/**
 * chrF2 — character n-gram F-score, the translation-quality metric.
 *
 * A port of `sacrebleu.metrics.CHRF` at version 2.6.0, read from the installed source rather
 * than from the paper, with the library's defaults: `char_order=6, word_order=0, beta=2,
 * lowercase=False, whitespace=False, eps_smoothing=False`. That configuration is plain
 * chrF2, which is what the research doc's translation numbers are and therefore what the
 * Phase 5 translation report has to be comparable to.
 *
 * `__fixtures__/parity.json` freezes sacrebleu's answers for every case here, so this file
 * is checkable rather than merely careful. Two details in it are not obvious from the
 * formula and are the reason the fixture exists:
 *
 * 1. **A hypothesis n-gram count is reported as 0 when the reference has no n-grams at that
 *    order at all** — `hyp_count if ref_ngrams else 0` in `_get_match_statistics`. A port
 *    that always reports the hypothesis count scores a one-character hypothesis against a
 *    long reference differently from sacrebleu. `chrf-asymmetric-short` is that case.
 * 2. **sacrebleu slices Python `str`, which is code points.** Any use of `.length`,
 *    `charAt` or `[i]` here is a UTF-16 bug that only shows up on astral characters;
 *    `astral-emoji` is that case.
 */

/** Per-order match statistics: hypothesis n-grams, reference n-grams, and the overlap. */
export interface ChrfStats {
  hyp: number;
  ref: number;
  match: number;
}

export interface ChrfOptions {
  charOrder?: number;
  wordOrder?: number;
  beta?: number;
}

const CHAR_ORDER = 6;
const WORD_ORDER = 0;
const BETA = 2;

function ngrams(seq: readonly string[], n: number, sep: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= seq.length; i++) {
    const gram = seq.slice(i, i + n).join(sep);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function overlap(h: Map<string, number>, r: Map<string, number>): ChrfStats {
  let hyp = 0;
  let ref = 0;
  let match = 0;
  for (const v of h.values()) hyp += v;
  for (const v of r.values()) ref += v;
  for (const [gram, count] of h) {
    const other = r.get(gram);
    if (other !== undefined) match += Math.min(count, other);
  }
  // sacrebleu: `hyp_count if ref_ngrams else 0`. With no reference n-grams at this order
  // there is nothing to be precise *about*, so the hypothesis contributes no precision
  // denominator either — and, via the effective-order rule below, the order drops out of the
  // average entirely rather than scoring 0.
  return { hyp: ref === 0 ? 0 : hyp, ref, match };
}

/**
 * `''.join(line.split())` in sacrebleu, i.e. every whitespace run removed — not replaced by
 * a space. Python's `str.split()` and JS `\s` disagree at the margins (Python treats
 * U+001C–U+001F and U+0085 as whitespace, JS treats U+FEFF as whitespace and Python does
 * not); none of those appear in scored text, and `normalizeForScoring` has already collapsed
 * ordinary whitespace by the time this runs.
 */
function charUnits(s: string): string[] {
  return Array.from(s.replace(/\s+/gu, ''));
}

/**
 * sacrebleu's `_remove_punctuation`, used only for chrF++ (`wordOrder > 0`).
 *
 * It is not a tokenizer anyone would design: a leading or trailing ASCII punctuation
 * character is split off as its own token, one at a time, and single-character words are
 * left alone. It is reproduced exactly because chrF++ numbers are only comparable if the
 * tokenization is, and its oddities — `(hi)` becomes `(hi` and `)` — are upstream's, not
 * ours.
 */
const PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function wordUnits(s: string): string[] {
  const out: string[] = [];
  for (const w of s.split(/\s+/u).filter(Boolean)) {
    if (w.length === 1) {
      out.push(w);
      continue;
    }
    const last = w.slice(-1);
    const first = w.slice(0, 1);
    if (PUNCT.has(last)) out.push(w.slice(0, -1), last);
    else if (PUNCT.has(first)) out.push(first, w.slice(1));
    else out.push(w);
  }
  return out;
}

/**
 * Per-order statistics for one hypothesis/reference pair: `charOrder` character orders
 * followed by `wordOrder` word orders, in that order, which is the layout `chrfScore` and
 * the corpus aggregator both assume.
 */
export function chrfStats(hyp: string, ref: string, opts: ChrfOptions = {}): ChrfStats[] {
  const charOrder = opts.charOrder ?? CHAR_ORDER;
  const wordOrder = opts.wordOrder ?? WORD_ORDER;

  const hc = charUnits(hyp);
  const rc = charUnits(ref);
  const out: ChrfStats[] = [];
  for (let n = 1; n <= charOrder; n++) out.push(overlap(ngrams(hc, n, ''), ngrams(rc, n, '')));

  if (wordOrder > 0) {
    const hw = wordUnits(hyp);
    const rw = wordUnits(ref);
    for (let n = 1; n <= wordOrder; n++) out.push(overlap(ngrams(hw, n, ' '), ngrams(rw, n, ' ')));
  }
  return out;
}

/**
 * sacrebleu's `_compute_f_score` on the effective-order path (`eps_smoothing=False`, the
 * default since 2.0.0).
 *
 * Precision and recall are averaged arithmetically across the orders that have *both* a
 * hypothesis and a reference n-gram, and the F-beta is computed once from those averages —
 * not per order and then averaged. Orders with nothing to compare drop out rather than
 * scoring zero, which is what keeps a three-character hypothesis from being punished for
 * having no 4-, 5- or 6-grams to offer.
 */
export function chrfScore(stats: readonly ChrfStats[], beta = BETA): number {
  const factor = beta * beta;
  let avgPrec = 0;
  let avgRec = 0;
  let effective = 0;

  for (const s of stats) {
    if (s.hyp > 0 && s.ref > 0) {
      avgPrec += s.match / s.hyp;
      avgRec += s.match / s.ref;
      effective++;
    }
  }

  if (effective === 0) return 0;
  avgPrec /= effective;
  avgRec /= effective;
  if (avgPrec + avgRec === 0) return 0;
  return (100 * (1 + factor) * avgPrec * avgRec) / (factor * avgPrec + avgRec);
}

/** Sentence-level chrF2, on the 0–100 scale sacrebleu reports. */
export function chrf2(hyp: string, ref: string, opts: ChrfOptions = {}): number {
  return chrfScore(chrfStats(hyp, ref, opts), opts.beta ?? BETA);
}

/**
 * Corpus chrF2: sum the per-order statistics across every pair, then score **once**.
 *
 * Never the mean of the sentence scores. Same reasoning as `corpusCer` — sacrebleu's
 * `corpus_score` aggregates first, so a mean would not be the metric anyone else is
 * reporting, and the fixture's `corpus` block fails immediately if this drifts.
 */
export function corpusChrf2(
  pairs: ReadonlyArray<{ hyp: string; ref: string }>,
  opts: ChrfOptions = {},
): number {
  const orders = (opts.charOrder ?? CHAR_ORDER) + (opts.wordOrder ?? WORD_ORDER);
  const total: ChrfStats[] = Array.from({ length: orders }, () => ({ hyp: 0, ref: 0, match: 0 }));

  for (const { hyp, ref } of pairs) {
    const stats = chrfStats(hyp, ref, opts);
    for (let i = 0; i < stats.length; i++) {
      const acc = total[i]!;
      const s = stats[i]!;
      acc.hyp += s.hyp;
      acc.ref += s.ref;
      acc.match += s.match;
    }
  }

  return chrfScore(total, opts.beta ?? BETA);
}
