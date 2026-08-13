import {
  bootstrapCi,
  editStats,
  normalizeForScoring,
  scriptIntegrity,
  wer,
  type EditStats,
} from '@thibi/core';
import { detectZawgyi, zawgyiToUnicode } from '@thibi/engine';
import { LANGUAGES } from '@thibi/languages';
import { fetchClips as fetchClipsLive, type Clip } from './fleurs/audio.js';
import {
  loadTsv as loadTsvLive,
  NoEvalSetError,
  type FleursRow,
  type Split,
} from './fleurs/tsv.js';
import { joinTarOrder, describeSample } from './sample.js';
import { clipHashOf, paramsHashOf, responseKey, type ResponseCache } from './cache.js';
import { scoreProfileFor, scriptRangesFor } from './profile.js';
import { assignTier, type TierResult } from './tier.js';

/**
 * The ASR eval run.
 *
 * Everything billable enters through `transcribe`, which is injected — the harness never
 * builds a provider, so a test can run the whole pipeline against recorded text and the CLI
 * can wire in the real thing. The budget is checked *before* each call rather than after,
 * because a ledger that notices it has overspent is not a budget.
 *
 * The two FLEURS calls are injected for the same reason, and it took a session to notice
 * they were not. `transcribe` being a dependency while `loadTsv` and `fetchClips` were
 * direct imports meant the module that spends money was the only module in the package with
 * no unit test: the 84 eval tests reached the cache, the tiering, the sampler and the data
 * path, and nothing but a real billable run reached the code that orders them. Every
 * default below is the live implementation, so the CLI passes none of them and a test
 * passes all three.
 */

/** The one call that costs money. */
export type AsrTranscribe = (input: {
  clip: Clip;
  languageCode: string;
}) => Promise<{ text: string; costUsd: number }>;

/** The TSV load, injected. Same signature as `loadTsv`, minus the fetch seam it owns itself. */
export type LoadTsvFn = (
  cacheDir: string,
  cfg: string,
  split: Split,
) => Promise<{ rows: FleursRow[]; oid: string; dropped: number }>;

/** The ranged-tarball pull, injected. Same signature as `fetchClips`. */
export type FetchClipsFn = (cfg: string, split: string, n: number) => Promise<Clip[]>;

export interface RunAsrOptions {
  languages: readonly string[];
  n: number;
  split?: Split;
  cacheDir: string;
  provider: string;
  model: string;
  /** Stop before the call that would exceed this. Null means no ceiling. */
  budgetUsd?: number | null;
  /**
   * The run's identity, minted by the caller.
   *
   * It has to be, because the runlog is *named* by it and has to be open before the first
   * billable call — a run that only learns its own id once it has finished cannot have
   * written anything down on the way, which is the one thing the log is for. Defaults to
   * `makeRunId(now, provider)` for callers that keep no log.
   */
  runId?: string;
  /**
   * The rate the budget check projects each clip's cost from, when one is known.
   *
   * Without it the ceiling can only be enforced retrospectively — see the check in
   * `runOne`, and the correction that put this field here.
   */
  usdPerMinute?: number | null;
  onProgress?: (line: string) => void;
}

export interface RunAsrDeps {
  transcribe: AsrTranscribe;
  cache: ResponseCache;
  now: () => Date;
  /** Defaults to the live HF loader. */
  loadTsv?: LoadTsvFn;
  /** Defaults to the live ranged-tarball pull. */
  fetchClips?: FetchClipsFn;
  /** Called as each event happens, so a crashed run is still analysable. */
  onEvent?: (event: RunEvent) => void | Promise<void>;
}

/**
 * What the runner emits as it goes, for the runlog.
 *
 * The runner does not write files — `packages/eval` is below the CLI and reads no ambient
 * paths — so it reports and the caller decides where that lands. It is also why a test can
 * assert the sequence of events without a temp directory.
 */
export type RunEvent =
  | { t: 'clip'; lang: string; id: number; filename: string; clipHash: string; seconds: number; gender: string }
  | { t: 'asr'; lang: string; id: number; cacheHit: boolean; usd: number; hyp: string }
  | {
      t: 'score';
      lang: string;
      id: number;
      edits: number;
      refLen: number;
      editsNospace: number;
      refLenNospace: number;
    }
  | { t: 'budget'; spentUsd: number; limitUsd: number }
  | { t: 'summary'; lang: string; result: LanguageResult };

export interface LanguageResult {
  languageCode: string;
  cfg: string | null;
  /** The HF blob oid of the TSV this language was scored against — the reference's provenance. */
  tsvOid: string | null;
  n: number;
  clipSeconds: number;
  genderSplit: Record<string, number>;
  /** One value across n rows is a finding, not a column — amendment 68. */
  genderUniform: boolean;
  distinctIds: number;
  cer: number | null;
  cerNospace: number | null;
  cerCi95: readonly [number, number] | null;
  wer: number | null;
  werKind: 'spaces' | 'icu' | null;
  scriptIntegrity: number | null;
  ratio: number | null;
  costUsd: number;
  cachedClips: number;
  /** Clips fetched whose TSV row had no reference — amendment 70, counted not hidden. */
  unmatched: number;
  /**
   * The worst-scoring clip of the sample, as the provider returned it.
   *
   * Un-normalized on both sides, deliberately. A script-integrity failure printed as `0.02`
   * is a number; printed as `ASEAN YAK SOMPHA CHHA KOO` beside the Burmese it was supposed
   * to be, it is a diagnosis, and it is what makes the check comprehensible to someone who
   * did not write it. Null when nothing was scored.
   */
  example: { id: number; ref: string; hyp: string } | null;
  tier?: TierResult;
  error?: string;
}

export interface AsrRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  split: Split;
  n: number;
  baselineCode: string;
  baselineAdded: boolean;
  languages: LanguageResult[];
  spentUsd: number;
  budgetExhausted: boolean;
}

/** Burmese calibrates every other language, so it is measured every run, never hardcoded. */
export const BASELINE_CODE = 'my-MM';

/**
 * A run's id: sortable, filename-safe, and carrying the provider so a directory of them can
 * be read without opening any.
 */
export function makeRunId(startedAt: Date, provider: string): string {
  return `${startedAt.toISOString().replace(/[:.]/gu, '-')}-${provider}`;
}

const SCORE_OPTIONS = {
  // FLEURS column 3 is lowercased and unpunctuated, so the ASR metric scores neither.
  keepPunctuation: false,
  caseFold: true,
  /**
   * Injected, because `@thibi/core` has zero runtime dependencies and the detector and the
   * converter are two npm packages — amendment 62. The first real run proved the design
   * earns its keep: `normalizeForScoring` **refused to score Burmese at all** rather than
   * treating Zawgyi as Unicode, which would have reported a correct transcript as ~100%
   * error and made `my-MM` look unsupported on its own baseline.
   */
  convertZawgyi: (text: string) => (detectZawgyi(text) ? zawgyiToUnicode(text) : text),
} as const;

class BudgetExhausted extends Error {}

export async function runAsrEval(deps: RunAsrDeps, opts: RunAsrOptions): Promise<AsrRunResult> {
  const split = opts.split ?? 'dev';
  const startedAt = deps.now();
  const log = opts.onProgress ?? (() => {});

  // The baseline is not optional: `ratio` is meaningless without it, and a run that quietly
  // skipped it would produce tiers calibrated against nothing.
  const requested = [...opts.languages];
  const baselineAdded = !requested.includes(BASELINE_CODE);
  if (baselineAdded) {
    requested.unshift(BASELINE_CODE);
    log(`  baseline ${BASELINE_CODE} added to this run — ratio is undefined without it`);
  }

  const results: LanguageResult[] = [];
  let spent = 0;
  let exhausted = false;

  // Every language reaches the log, including the ones that failed and the ones the budget
  // never reached. A runlog that records only successes reconstructs a run that appears to
  // have measured fewer languages than were asked for, with nothing to say what happened to
  // the rest.
  const finish = async (r: LanguageResult): Promise<void> => {
    results.push(r);
    // A snapshot, because `applyBaselineAndTiers` mutates these objects afterwards and an
    // event is a statement about the moment it was emitted.
    await deps.onEvent?.({ t: 'summary', lang: r.languageCode, result: { ...r } });
  };

  for (const code of requested) {
    if (exhausted) {
      await finish(emptyResult(code, 'not run: budget exhausted'));
      continue;
    }
    try {
      const r = await runOne(deps, opts, split, code, () => spent, (add) => {
        spent += add;
      }, opts.budgetUsd ?? null, log);
      await finish(r);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        exhausted = true;
        // The clips this language *did* score before the ceiling are dropped rather than
        // reported: a CER over however many clips the budget happened to buy is not the
        // measurement anyone asked for, and it would enter the report indistinguishable
        // from a complete one. The money is not wasted — those responses are cached, so
        // resuming with a larger budget pays only for what is left.
        await finish(emptyResult(code, 'stopped part-way: budget exhausted'));
        continue;
      }
      await finish(emptyResult(code, err instanceof Error ? err.message : String(err)));
    }
  }

  applyBaselineAndTiers(results);

  const finishedAt = deps.now();
  return {
    runId: opts.runId ?? makeRunId(startedAt, opts.provider),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    provider: opts.provider,
    model: opts.model,
    split,
    n: opts.n,
    baselineCode: BASELINE_CODE,
    baselineAdded,
    languages: results,
    spentUsd: spent,
    budgetExhausted: exhausted,
  };
}

/**
 * Ratio and tier, as a second pass over the whole run.
 *
 * Second, because every ratio is against the baseline and the baseline is one of the
 * languages being measured — there is no ratio to compute until the last one is in.
 * Exported because `thibi eval report --run` has to do exactly this to a set of results
 * reconstructed from a runlog, and two implementations of "which tier is this" is the drift
 * the harness cannot afford. Mutates in place, which is what the live run wants and what
 * keeps the replay path from having to clone.
 *
 * `humanReviews` is keyed by language code and is the only route to `verified`; the runner
 * itself never has one, because a sign-off is against a measurement that has not finished
 * happening yet.
 */
export function applyBaselineAndTiers(
  results: LanguageResult[],
  humanReviews: Readonly<Record<string, unknown>> = {},
): void {
  const baseline = results.find((r) => r.languageCode === BASELINE_CODE);
  const baselineCer = baseline?.cerNospace ?? null;
  for (const r of results) {
    if (r.cerNospace !== null && baselineCer !== null && baselineCer > 0) {
      r.ratio = r.cerNospace / baselineCer;
    }
    r.tier = assignTier({
      cerNospace: r.cerNospace,
      ci95: r.cerCi95,
      ratio: r.ratio,
      scriptIntegrity: r.scriptIntegrity,
      n: r.n,
      ...(r.cfg === null ? { noEvalSet: true } : {}),
      humanReview: humanReviews[r.languageCode] ?? null,
    });
  }
}

async function runOne(
  deps: RunAsrDeps,
  opts: RunAsrOptions,
  split: Split,
  code: string,
  spentSoFar: () => number,
  addSpend: (usd: number) => void,
  budgetUsd: number | null,
  log: (line: string) => void,
): Promise<LanguageResult> {
  const entry = LANGUAGES[code];
  const cfg = entry?.fleurs.config ?? null;
  if (!entry || cfg === null) return emptyResult(code, undefined, cfg);

  const loadTsv = deps.loadTsv ?? loadTsvLive;
  const fetchClips = deps.fetchClips ?? fetchClipsLive;

  let rows: FleursRow[];
  let dropped: number;
  let oid: string;
  try {
    const loaded = await loadTsv(opts.cacheDir, cfg, split);
    rows = loaded.rows;
    dropped = loaded.dropped;
    oid = loaded.oid;
  } catch (err) {
    if (err instanceof NoEvalSetError) return emptyResult(code, undefined, null);
    throw err;
  }

  // Over-fetch. A tar-order sample walks into the records that have audio and no reference
  // at a rate of `dropped / total`, so asking for exactly n returns fewer than n scoreable
  // pairs — measured: 30 fetched, 29 usable (amendment 70). Ask for the shortfall plus one,
  // then take the first n that joined.
  const totalRecords = rows.length + dropped;
  const expectedLoss = totalRecords === 0 ? 0 : (opts.n * dropped) / totalRecords;
  const overFetch = Math.min(rows.length + dropped, opts.n + Math.ceil(expectedLoss) + 1);

  const clips = await fetchClips(cfg, split, overFetch);
  const joined = joinTarOrder(clips, rows);
  const pairs = joined.pairs.slice(0, opts.n);

  const profile = scoreProfileFor(code);
  const ranges = scriptRangesFor(code);
  if (!profile) return emptyResult(code, `no scoring profile for ${code}`, cfg);

  const paramsHash = paramsHashOf({ split, n: opts.n, model: opts.model, scoring: SCORE_OPTIONS });
  const perClip: EditStats[] = [];
  const perClipNospace: EditStats[] = [];
  let hypAll = '';
  let refAll = '';
  let cost = 0;
  let cached = 0;
  let worst: { id: number; ref: string; hyp: string; cer: number } | null = null;

  for (const [i, pair] of pairs.entries()) {
    const clipHash = clipHashOf(pair.clip.bytes);
    await deps.onEvent?.({
      t: 'clip',
      lang: code,
      id: pair.row.id,
      filename: pair.row.filename,
      clipHash,
      seconds: pair.row.numSamples / 16_000,
      gender: pair.row.gender,
    });
    const key = responseKey({
      provider: opts.provider,
      model: opts.model,
      lang: code,
      clipHash,
      paramsHash,
    });

    let text = await deps.cache.get<{ text: string }>(key).then((v) => v?.text ?? null);
    let cacheHit = true;
    let clipCost = 0;
    if (text !== null) {
      cached++;
    } else {
      /**
       * Checked before the call, never after: a ledger that notices it has overspent is not
       * a budget.
       *
       * The first version of this check tested `spent >= budget`, which is not that. It
       * permits the call that crosses the ceiling and only refuses the *next* one, so a
       * $0.50 budget spends $1 on a single expensive clip and reports the ceiling as
       * enforced. Nothing caught it because nothing ran this module (§5.8's own wording —
       * "checks before each billable call" — was the specification it failed).
       *
       * So the projection: this clip's own duration at the run's rate, not an average, and
       * not a retrospective sum. Where no rate is known the projection is zero and the
       * check degrades to the old ledger test — still correct in direction, weaker by one
       * clip, and honest about which of the two it is doing.
       */
      const projectedUsd =
        opts.usdPerMinute === null || opts.usdPerMinute === undefined
          ? 0
          : (pair.row.numSamples / 16_000 / 60) * opts.usdPerMinute;
      const wouldSpend = spentSoFar() + projectedUsd;
      if (budgetUsd !== null && (wouldSpend > budgetUsd || spentSoFar() >= budgetUsd)) {
        await deps.onEvent?.({ t: 'budget', spentUsd: spentSoFar(), limitUsd: budgetUsd });
        throw new BudgetExhausted();
      }
      const out = await deps.transcribe({ clip: pair.clip, languageCode: code });
      text = out.text;
      cacheHit = false;
      clipCost = out.costUsd;
      cost += out.costUsd;
      addSpend(out.costUsd);
      await deps.cache.set(key, { text }, deps.now());
    }
    await deps.onEvent?.({
      t: 'asr',
      lang: code,
      id: pair.row.id,
      cacheHit,
      usd: clipCost,
      hyp: text,
    });

    const hyp = normalizeForScoring(text, profile, SCORE_OPTIONS);
    const ref = normalizeForScoring(pair.row.plain, profile, SCORE_OPTIONS);
    const stats = editStats(hyp, ref, 'codepoint');
    const statsNospace = editStats(
      hyp.replace(/\s+/gu, ''),
      ref.replace(/\s+/gu, ''),
      'codepoint',
    );
    perClip.push(stats);
    perClipNospace.push(statsNospace);
    await deps.onEvent?.({
      t: 'score',
      lang: code,
      id: pair.row.id,
      edits: stats.edits,
      refLen: stats.refLen,
      editsNospace: statsNospace.edits,
      refLenNospace: statsNospace.refLen,
    });
    hypAll += (hypAll ? ' ' : '') + hyp;
    refAll += (refAll ? ' ' : '') + ref;

    // The worst clip, kept as the provider wrote it. `>=` rather than `>` so a run where
    // every clip scores identically — a wrong-language transcript, typically — still has an
    // example to print rather than reporting a failure with nothing to look at.
    const clipCer = stats.refLen === 0 ? 0 : stats.edits / stats.refLen;
    if (worst === null || clipCer >= worst.cer) {
      worst = { id: pair.row.id, ref: pair.row.plain, hyp: text, cer: clipCer };
    }
    log(`  ${code} ${i + 1}/${pairs.length}${cached === i + 1 ? ' (cached)' : ''}`);
  }

  const comp = describeSample(pairs.map((p) => p.row));
  const ratioOf = (stats: EditStats[]) => {
    const edits = stats.reduce((s, x) => s + x.edits, 0);
    const refLen = stats.reduce((s, x) => s + x.refLen, 0);
    return refLen === 0 ? null : edits / refLen;
  };
  const werResult = wer(hypAll, refAll, {
    code,
    wordSegmentation: profile.wordSegmentation,
  });
  const integrity = ranges.length > 0 ? scriptIntegrity(hypAll, ranges).fraction : null;

  return {
    languageCode: code,
    cfg,
    tsvOid: oid,
    n: pairs.length,
    clipSeconds: comp.totalSeconds,
    genderSplit: comp.gender,
    genderUniform: comp.genderUniform,
    distinctIds: comp.distinctIds,
    cer: ratioOf(perClip),
    cerNospace: ratioOf(perClipNospace),
    cerCi95: bootstrapCi(perClipNospace),
    wer: werResult.value,
    werKind: werResult.kind,
    scriptIntegrity: integrity,
    ratio: null,
    costUsd: cost,
    cachedClips: cached,
    unmatched: joined.unmatched.length,
    example: worst === null ? null : { id: worst.id, ref: worst.ref, hyp: worst.hyp },
  };
}

function emptyResult(code: string, error?: string, cfg: string | null = null): LanguageResult {
  return {
    languageCode: code,
    cfg,
    tsvOid: null,
    n: 0,
    clipSeconds: 0,
    genderSplit: {},
    genderUniform: false,
    distinctIds: 0,
    cer: null,
    cerNospace: null,
    cerCi95: null,
    wer: null,
    werKind: null,
    scriptIntegrity: null,
    ratio: null,
    costUsd: 0,
    cachedClips: 0,
    unmatched: 0,
    example: null,
    ...(error ? { error } : {}),
  };
}
