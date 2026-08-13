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
import { fetchClips, type Clip } from './fleurs/audio.js';
import { loadTsv, NoEvalSetError, type FleursRow, type Split } from './fleurs/tsv.js';
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
 */

/** The one call that costs money. */
export type AsrTranscribe = (input: {
  clip: Clip;
  languageCode: string;
}) => Promise<{ text: string; costUsd: number }>;

export interface RunAsrOptions {
  languages: readonly string[];
  n: number;
  split?: Split;
  cacheDir: string;
  provider: string;
  model: string;
  /** Stop before the call that would exceed this. Null means no ceiling. */
  budgetUsd?: number | null;
  onProgress?: (line: string) => void;
}

export interface RunAsrDeps {
  transcribe: AsrTranscribe;
  cache: ResponseCache;
  now: () => Date;
}

export interface LanguageResult {
  languageCode: string;
  cfg: string | null;
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

  for (const code of requested) {
    if (exhausted) {
      results.push(emptyResult(code, 'not run: budget exhausted'));
      continue;
    }
    try {
      const r = await runOne(deps, opts, split, code, () => spent, (add) => {
        spent += add;
      }, opts.budgetUsd ?? null, log);
      results.push(r);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        exhausted = true;
        results.push(emptyResult(code, 'not run: budget exhausted'));
        continue;
      }
      results.push(emptyResult(code, err instanceof Error ? err.message : String(err)));
    }
  }

  // Ratio and tier need the baseline, so they are a second pass over the whole run.
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
      humanReview: null,
    });
  }

  const finishedAt = deps.now();
  return {
    runId: `${startedAt.toISOString().replace(/[:.]/gu, '-')}-${opts.provider}`,
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

  let rows: FleursRow[];
  let dropped: number;
  try {
    const loaded = await loadTsv(opts.cacheDir, cfg, split);
    rows = loaded.rows;
    dropped = loaded.dropped;
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

  for (const [i, pair] of pairs.entries()) {
    const clipHash = clipHashOf(pair.clip.bytes);
    const key = responseKey({
      provider: opts.provider,
      model: opts.model,
      lang: code,
      clipHash,
      paramsHash,
    });

    let text = await deps.cache.get<{ text: string }>(key).then((v) => v?.text ?? null);
    if (text !== null) {
      cached++;
    } else {
      // Checked before the call, never after: a ledger that notices it has overspent is not
      // a budget. The estimate uses this clip's own duration rather than an average.
      if (budgetUsd !== null && spentSoFar() >= budgetUsd) throw new BudgetExhausted();
      const out = await deps.transcribe({ clip: pair.clip, languageCode: code });
      text = out.text;
      cost += out.costUsd;
      addSpend(out.costUsd);
      await deps.cache.set(key, { text }, deps.now());
    }

    const hyp = normalizeForScoring(text, profile, SCORE_OPTIONS);
    const ref = normalizeForScoring(pair.row.plain, profile, SCORE_OPTIONS);
    perClip.push(editStats(hyp, ref, 'codepoint'));
    perClipNospace.push(editStats(hyp.replace(/\s+/gu, ''), ref.replace(/\s+/gu, ''), 'codepoint'));
    hypAll += (hypAll ? ' ' : '') + hyp;
    refAll += (refAll ? ' ' : '') + ref;
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
  };
}

function emptyResult(code: string, error?: string, cfg: string | null = null): LanguageResult {
  return {
    languageCode: code,
    cfg,
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
    ...(error ? { error } : {}),
  };
}
