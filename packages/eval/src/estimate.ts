import type { FleursRow } from './fleurs/tsv.js';

/**
 * Dry-run estimation: what a sweep would cost, computed from the TSV with **no audio
 * downloaded**.
 *
 * §5's dry run promises "exact audio seconds straight from the TSV". That is achievable for
 * the text-only evals and, measured, **it is not achievable for the ASR eval**. The ASR
 * sample is tar order, and tar order is lexicographic over random-hash filenames — knowing
 * *which* N rows the sample will contain requires the tarball, which is the audio the dry
 * run exists to avoid fetching. So the honest output is an estimate that says it is one.
 *
 * Measured on `my_mm/dev`, n=30, against a real tar-order pull as ground truth (450.6 s):
 *
 * | Estimator | Error |
 * |---|---|
 * | mean clip length × n | **+2.8%** |
 * | first n rows in TSV order | −10.2% |
 *
 * Hence the mean. TSV order is not tar order and is not a proxy for it; using it would look
 * more precise and be four times further out.
 *
 * `exact` is true only when the request covers the whole split, where the sum is the sum.
 */

export interface AsrEstimate {
  languageCode: string;
  /** FLEURS config, or null for a language with no eval set. */
  cfg: string | null;
  /** Absent eval set: reported as a row, never as an error. The command still exits 0. */
  noEvalSet: boolean;
  clipsRequested: number;
  /** Usable rows in the split — the ceiling on `clipsRequested`. */
  clipsAvailable: number;
  meanClipSeconds: number;
  estimatedSeconds: number;
  /** True only when the estimate is a sum over every usable row rather than a projection. */
  exact: boolean;
  /** Records `parseTsv` refused, from `loadTsv`. */
  droppedRecords: number;
  /**
   * Clips the sample is expected to lose to the join.
   *
   * The dropped records still have audio in the tarball — measured: `id=1607` appears in
   * `my_mm/dev` as three six-field rows whose wavs are present — so a tar-order sample hits
   * them and `joinTarOrder` discards them for having no reference. **A 30-clip fetch
   * returned 29 scoreable pairs on the first real pull.** §5.3 calls an unmatched member
   * "never observed"; it is observable immediately, and it is the same defect as amendment
   * 67 seen from the other end. The runner has to over-fetch by this much or accept a
   * smaller n than it asked for.
   */
  expectedUnscoreable: number;
  usdPerMinute: number | null;
  estimatedUsd: number | null;
}

export interface EstimateInput {
  languageCode: string;
  cfg: string | null;
  rows: readonly FleursRow[];
  droppedRecords: number;
  n: number;
  usdPerMinute: number | null;
}

export function estimateAsr(input: EstimateInput): AsrEstimate {
  const { languageCode, cfg, rows, droppedRecords, n, usdPerMinute } = input;

  if (cfg === null) {
    return {
      languageCode,
      cfg: null,
      noEvalSet: true,
      clipsRequested: n,
      clipsAvailable: 0,
      meanClipSeconds: 0,
      estimatedSeconds: 0,
      exact: false,
      droppedRecords: 0,
      expectedUnscoreable: 0,
      usdPerMinute,
      estimatedUsd: null,
    };
  }

  const available = rows.length;
  const totalSeconds = rows.reduce((s, r) => s + r.numSamples / 16_000, 0);
  const mean = available === 0 ? 0 : totalSeconds / available;
  const clips = Math.min(n, available);
  const exact = clips >= available;
  const estimatedSeconds = exact ? totalSeconds : mean * clips;

  // The tarball holds a member for every record, including the ones without a reference.
  const totalRecords = available + droppedRecords;
  const expectedUnscoreable = totalRecords === 0 ? 0 : (clips * droppedRecords) / totalRecords;

  return {
    languageCode,
    cfg,
    noEvalSet: false,
    clipsRequested: n,
    clipsAvailable: available,
    meanClipSeconds: mean,
    estimatedSeconds,
    exact,
    droppedRecords,
    expectedUnscoreable,
    usdPerMinute,
    estimatedUsd: usdPerMinute === null ? null : (estimatedSeconds / 60) * usdPerMinute,
  };
}

/** `9m 42s`, and `—` for nothing, because `0m 00s` in a no-eval-set row reads as measured. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s === 60 ? `${m + 1}m 00s` : `${m}m ${String(s).padStart(2, '0')}s`;
}

const pad = (s: string, w: number) => s.padEnd(w);
const padStart = (s: string, w: number) => s.padStart(w);

/**
 * The dry-run table.
 *
 * Everything uncertain is marked in the output rather than in a footnote nobody reads: `~`
 * on a projected duration, an explicit note when the join is expected to cost clips, and a
 * `no eval set` row for a language FLEURS does not carry. A reader must be able to tell an
 * estimate from a measurement without being told which columns to distrust.
 */
export function formatDryRun(estimates: readonly AsrEstimate[], providerModel: string): string {
  const lines: string[] = [];
  const W = { lang: 10, clips: 7, audio: 10, pm: 18, usd: 10 };

  lines.push(
    pad('language', W.lang) +
      padStart('clips', W.clips) +
      padStart('audio', W.audio) +
      '  ' +
      pad('provider/model', W.pm) +
      padStart('est. usd', W.usd),
  );

  let totalClips = 0;
  let totalSeconds = 0;
  let totalUsd = 0;
  let anyProjected = false;
  let anyUnpriced = false;

  for (const e of estimates) {
    if (e.noEvalSet) {
      lines.push(
        pad(e.languageCode, W.lang) +
          padStart('—', W.clips) +
          padStart('—', W.audio) +
          '  ' +
          pad('no eval set', W.pm) +
          padStart('—', W.usd),
      );
      continue;
    }
    const clips = Math.min(e.clipsRequested, e.clipsAvailable);
    totalClips += clips;
    totalSeconds += e.estimatedSeconds;
    if (e.estimatedUsd === null) anyUnpriced = true;
    else totalUsd += e.estimatedUsd;
    if (!e.exact) anyProjected = true;

    lines.push(
      pad(e.languageCode, W.lang) +
        padStart(String(clips), W.clips) +
        padStart((e.exact ? '' : '~') + formatDuration(e.estimatedSeconds), W.audio) +
        '  ' +
        pad(providerModel, W.pm) +
        padStart(e.estimatedUsd === null ? 'unpriced' : `$${e.estimatedUsd.toFixed(3)}`, W.usd),
    );
  }

  const width = W.lang + W.clips + W.audio + 2 + W.pm + W.usd;
  lines.push('─'.repeat(width));
  lines.push(
    pad('TOTAL', W.lang) +
      padStart(String(totalClips), W.clips) +
      padStart((anyProjected ? '~' : '') + formatDuration(totalSeconds), W.audio) +
      '  ' +
      pad('', W.pm) +
      padStart(anyUnpriced && totalUsd === 0 ? 'unpriced' : `$${totalUsd.toFixed(3)}`, W.usd),
  );

  if (anyProjected) {
    lines.push('');
    lines.push(
      '~ estimated. The ASR sample is tar order, so which clips it contains is not knowable',
    );
    lines.push(
      '  without downloading the tarball. Projected from mean clip length — measured within',
    );
    lines.push('  3% of a real 30-clip pull. No audio was downloaded for this estimate.');
  }

  // Warn whenever the split contains *any* referenceless record, not above some expected
  // loss. A threshold here would be a chosen-not-measured number deciding whether a user is
  // told their sample can shrink — and the one real pull to date lost a clip at n=30 where
  // the expectation was 0.3. Round-number expectations do not bound what one draw does.
  const losing = estimates.filter((e) => !e.noEvalSet && e.droppedRecords > 0);
  if (losing.length > 0) {
    lines.push('');
    for (const e of losing) {
      const clips = Math.min(e.clipsRequested, e.clipsAvailable);
      lines.push(
        `note  ${e.languageCode}: ${e.droppedRecords} records in this split have no reference text but do have ` +
          `audio,\n      so a ${clips}-clip sample may score fewer than ${clips} ` +
          `(~${e.expectedUnscoreable.toFixed(1)} expected; a real 30-clip pull lost 1).`,
      );
    }
  }

  return lines.join('\n');
}
