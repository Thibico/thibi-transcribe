import { mulberry32 } from '@thibi/core';
import type { Clip } from './fleurs/audio.js';
import type { FleursRow } from './fleurs/tsv.js';

/**
 * Sampling, and the composition report that says what the sample actually is.
 *
 * Two strategies, because the two eval families have different constraints:
 *
 * - **ASR** takes tar order. The tarball is ordered lexicographically over random-hash
 *   filenames, which correlates with nothing in the data, so the first N entries are a
 *   random-but-reproducible sample with no seed at all. This is the strategy that costs one
 *   ranged request instead of a 281 MB download, and it is why it is the default.
 * - **cleanup / translate** touch no audio, so they can afford to dedupe by `id`, sort, and
 *   take a seeded shuffle over the whole split.
 *
 * The composition report is not decoration either. §5 risk 2 assigns "report the gender
 * split" as the mitigation for a single speaker dominating a sample — and measurement
 * showed that mitigation reporting a constant: **all 380 rows of `my_mm/dev` are FEMALE**
 * (amendment 68). A split of one value across n rows is a *finding*, not a column, so
 * `describeSample` reports distinctness explicitly rather than leaving a reader to notice
 * that a distribution has one bar.
 */

export interface Deduped {
  rows: FleursRow[];
  /** Rows removed because an earlier row already carried that `id`. */
  duplicatesRemoved: number;
}

/**
 * Keep the first row per `id`, in file order.
 *
 * Measured on `my_mm/dev`: 380 rows carry 148 distinct ids, 2.6 renderings each. An
 * undeduped 30-clip sample therefore draws from roughly 12 sentences and its confidence
 * interval describes those 12, not the language. Trap 1 called this hypothetical; it is the
 * measured shape of the one language this product was built to serve.
 */
export function dedupeById(rows: readonly FleursRow[]): Deduped {
  const seen = new Set<number>();
  const out: FleursRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return { rows: out, duplicatesRemoved: rows.length - out.length };
}

/**
 * Deduped, sorted by `id`, seeded-shuffled, first N. For the text-only evals.
 *
 * Sorting before shuffling is what makes the seed the *only* source of order: file order
 * varies with whatever FLEURS reshuffled last, and a sample that silently depends on it is
 * not reproducible from a runlog. `seed` is written to the runlog for that reason.
 */
export function sampleSeeded(rows: readonly FleursRow[], n: number, seed = 1): FleursRow[] {
  const { rows: unique } = dedupeById(rows);
  const ordered = [...unique].sort((a, b) => a.id - b.id);

  // Fisher-Yates over a copy, with the same PRNG `bootstrapCi` uses — identical on every
  // machine and Node version, which `Math.random()` is not.
  const rnd = mulberry32(seed);
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = ordered[i]!;
    ordered[i] = ordered[j]!;
    ordered[j] = t;
  }
  return ordered.slice(0, n);
}

export interface AsrSample {
  /** Clips paired with the TSV row that carries their reference text. */
  pairs: Array<{ clip: Clip; row: FleursRow }>;
  /**
   * Tar members with no TSV row. Never observed on the live data, but counted rather than
   * dropped quietly: an unmatched clip is a clip that would otherwise shrink the sample
   * below the requested N with nothing to say why.
   */
  unmatched: string[];
}

/**
 * Join tar-order clips back to the TSV by `filename`.
 *
 * Deliberately does **not** dedupe by `id`. Which sentences the tar prefix happens to
 * contain is not ours to choose without downloading more of the tarball, so the honest move
 * is to report the duplication in the composition rather than silently return fewer clips
 * than the caller paid to download. `describeSample` surfaces it.
 */
export function joinTarOrder(clips: readonly Clip[], rows: readonly FleursRow[]): AsrSample {
  const byFilename = new Map(rows.map((r) => [r.filename, r]));
  const pairs: Array<{ clip: Clip; row: FleursRow }> = [];
  const unmatched: string[] = [];
  for (const clip of clips) {
    const row = byFilename.get(clip.filename);
    if (row) pairs.push({ clip, row });
    else unmatched.push(clip.filename);
  }
  return { pairs, unmatched };
}

export interface SampleComposition {
  clips: number;
  /** How many distinct sentences the sample really covers. */
  distinctIds: number;
  /** `gender` value → count, and whether that distribution has any width at all. */
  gender: Record<string, number>;
  /**
   * True when every row carries the same `gender`. The whole point of amendment 68: for
   * `my_mm` this is `true`, so the gender split cannot be read as evidence that the sample
   * is speaker-diverse, and a tier derived from it must state the restriction.
   */
  genderUniform: boolean;
  totalSeconds: number;
}

/**
 * What the sample is, in the terms a report has to state before a CER means anything.
 *
 * `totalSeconds` comes from column 5 (`num_samples ÷ 16000`), so a dry run costs nothing and
 * downloads no audio.
 */
export function describeSample(rows: readonly FleursRow[]): SampleComposition {
  const gender: Record<string, number> = {};
  let totalSamples = 0;
  const ids = new Set<number>();
  for (const r of rows) {
    gender[r.gender] = (gender[r.gender] ?? 0) + 1;
    totalSamples += r.numSamples;
    ids.add(r.id);
  }
  return {
    clips: rows.length,
    distinctIds: ids.size,
    gender,
    genderUniform: rows.length > 0 && Object.keys(gender).length === 1,
    totalSeconds: totalSamples / 16_000,
  };
}
