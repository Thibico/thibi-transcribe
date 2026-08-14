import { bootstrapCi } from '@thibi/core';
import {
  buildCleanupPrompt,
  detectZawgyi,
  promptVars,
  zawgyiToUnicode,
  CLEANUP_CURRENT,
  CLEANUP_RESTRAINT,
  CLEANUP_VERSIONS,
} from '@thibi/engine';
import { LANGUAGES } from '@thibi/languages';
import { loadTsv as loadTsvLive, NoEvalSetError, type FleursRow, type Split } from '../fleurs/tsv.js';
import { paramsHashOf, responseKey, textHashOf } from '../cache.js';
import { scoreProfileFor } from '../profile.js';
import { sampleSeeded } from '../sample.js';
import { aggregateCleanup, scoreCleanup, type CleanupAggregate, type CleanupStats } from './metrics.js';
import { BudgetExhausted, Ledger } from './ledger.js';
import { parseSegmentsResponse } from './parse.js';
import { TEMPERATURE, type CleanupArm, type LlmRunDeps, type LlmRunOptions } from './types.js';

/**
 * `thibi eval cleanup` — the measurement that decides whether an editorial prompt may ship.
 *
 * Zero audio. The input is FLEURS column 3 (lowercased, unpunctuated — the shape a recogniser
 * emits) and the reference is column 2 (punctuated and cased — the shape a person would
 * publish), so the eval asks precisely the question the pass exists to answer: *given a
 * transcript, does this prompt move it toward publishable text or away from it?*
 *
 * The finding it has to be able to reproduce is that the answer for the shipped prompt is
 * **away**, in every language tested. That is why `control` is an arm rather than a baseline
 * constant, and why the gate's pass condition is beating the control per language rather than
 * clearing a threshold.
 */

export interface CleanupArmResult extends CleanupAggregate {
  arm: CleanupArm;
  /** Empty for `control`, which makes no call and therefore has no model. */
  model: string;
  promptId: string | null;
  promptVersion: number | null;
  cerPunctCi95: readonly [number, number] | null;
  costUsd: number;
  cachedSegments: number;
  /**
   * Responses that could not be parsed into `{idx, text}`.
   *
   * Counted and excluded rather than replaced by the input: a failed arm that fell back to
   * its input would score identically to `control` and read as harmless.
   */
  failed: number;
  /** Up to two segments the arm rewrote, rendered in full. A rate is not a diagnosis. */
  examples: Array<{ id: number; input: string; output: string }>;
  /** Entity tokens that left the multiset, deduped. `UN` is what this is for. */
  entitiesLost: string[];
}

export interface CleanupLanguageResult {
  languageCode: string;
  cfg: string | null;
  tsvOid: string | null;
  n: number;
  distinctIds: number;
  arms: CleanupArmResult[];
  error?: string;
}

export interface CleanupRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  models: readonly string[];
  arms: readonly CleanupArm[];
  split: Split;
  n: number;
  seed: number;
  languages: CleanupLanguageResult[];
  spentUsd: number;
  budgetExhausted: boolean;
}

export interface RunCleanupOptions extends LlmRunOptions {
  arms: readonly CleanupArm[];
}

const PROMPT_ID: Record<Exclude<CleanupArm, 'control'>, string> = {
  current: CLEANUP_CURRENT,
  restraint: CLEANUP_RESTRAINT,
};


export async function runCleanupEval(
  deps: LlmRunDeps,
  opts: RunCleanupOptions,
): Promise<CleanupRunResult> {
  const split = opts.split ?? 'dev';
  const seed = opts.seed ?? 1;
  const startedAt = deps.now();
  const log = opts.onProgress ?? (() => {});
  const ledger = new Ledger(opts.budgetUsd ?? null);

  const languages: CleanupLanguageResult[] = [];
  for (const code of opts.languages) {
    if (ledger.exhausted) {
      languages.push(empty(code, 'not run: budget exhausted'));
      continue;
    }
    try {
      const result = await runLanguage(deps, opts, split, seed, code, ledger, log);
      languages.push(result);
      await deps.onEvent?.({
        t: 'llmsummary',
        evalKind: 'cleanup',
        lang: code,
        result: { ...result },
      });
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        await deps.onEvent?.({
          t: 'budget',
          spentUsd: ledger.spent,
          limitUsd: opts.budgetUsd ?? 0,
        });
        // Same rule as the ASR runner: the arms this language did buy are discarded rather
        // than reported. A CER over however many segments the money reached is not the
        // measurement anyone asked for, and in a table it is indistinguishable from a
        // complete one. The responses stay cached, so resuming pays only for the remainder.
        languages.push(empty(code, 'stopped part-way: budget exhausted'));
        continue;
      }
      languages.push(empty(code, err instanceof Error ? err.message : String(err)));
    }
  }

  return {
    runId: opts.runId ?? `${startedAt.toISOString().replace(/[:.]/gu, '-')}-${opts.provider}`,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    provider: opts.provider,
    models: opts.models,
    arms: opts.arms,
    split,
    n: opts.n,
    seed,
    languages,
    spentUsd: ledger.spent,
    budgetExhausted: ledger.exhausted,
  };
}

async function runLanguage(
  deps: LlmRunDeps,
  opts: RunCleanupOptions,
  split: Split,
  seed: number,
  code: string,
  ledger: Ledger,
  log: (line: string) => void,
): Promise<CleanupLanguageResult> {
  const entry = LANGUAGES[code];
  const cfg = entry?.fleurs.config ?? null;
  if (!entry || cfg === null) return empty(code, undefined, cfg);

  const loadTsv = deps.loadTsv ?? loadTsvLive;
  let rows: FleursRow[];
  let oid: string;
  try {
    const loaded = await loadTsv(opts.cacheDir, cfg, split);
    rows = loaded.rows;
    oid = loaded.oid;
  } catch (err) {
    if (err instanceof NoEvalSetError) return empty(code, undefined, null);
    throw err;
  }

  const profile = scoreProfileFor(code);
  if (!profile) return empty(code, `no scoring profile for ${code}`, cfg);

  // Deduped by sentence id, sorted, seeded-shuffled. No audio is involved, so unlike the ASR
  // sampler this one can draw from the whole split rather than from a tar prefix.
  const sample = sampleSeeded(rows, opts.n, seed);
  for (const row of sample) {
    await deps.onEvent?.({
      t: 'seg',
      evalKind: 'cleanup',
      lang: code,
      id: row.id,
      input: row.plain,
      ref: row.raw,
    });
  }

  const scoreOne = (input: string, hypothesis: string, reference: string): CleanupStats =>
    scoreCleanup({
      input,
      hypothesis,
      reference,
      profile,
      isLatinScript: entry.script === 'Latn',
      ...(profile.zawgyiApplies
        ? { convertZawgyi: (t: string) => (detectZawgyi(t) ? zawgyiToUnicode(t) : t) }
        : {}),
    });

  const arms: CleanupArmResult[] = [];

  // The control first, and free. Running it before anything billable means a budget that runs
  // out still leaves the column every other arm is judged against.
  if (opts.arms.includes('control')) {
    const scored = sample.map((row) => ({
      stats: scoreOne(row.plain, row.plain, row.raw),
      row,
      hyp: row.plain,
    }));
    arms.push(finishArm('control', '', null, null, scored, 0, 0, 0));
  }

  for (const arm of opts.arms) {
    if (arm === 'control') continue;
    for (const model of opts.models) {
      const promptId = PROMPT_ID[arm];
      const promptVersion = CLEANUP_VERSIONS[promptId as keyof typeof CLEANUP_VERSIONS];
      /**
       * `promptId` and `promptVersion` are in the key, and that one line is what makes the
       * gate real. Without it a bumped prompt is a cache **hit**, the gate passes on the
       * previous prompt's numbers, and the whole mechanism is theatre (§5.10).
       */
      const paramsHash = paramsHashOf({ promptId, promptVersion, temperature: TEMPERATURE });
      const scored: Array<{ stats: CleanupStats; row: FleursRow; hyp: string }> = [];
      let cost = 0;
      let cached = 0;
      let failed = 0;

      for (const [i, row] of sample.entries()) {
        const vars = promptVars(code);
        const prompt = buildCleanupPrompt({
          vars,
          segments: [{ idx: 0, text: row.plain }],
          variant: promptId as 'cleanup.current' | 'cleanup.restraint',
        });
        const key = responseKey({
          provider: opts.provider,
          model,
          lang: code,
          clipHash: textHashOf(row.plain),
          paramsHash,
        });

        let text = await deps.cache.get<{ text: string }>(key).then((v) => v?.text ?? null);
        let cacheHit = true;
        let segCost = 0;
        if (text !== null) {
          cached++;
        } else {
          ledger.checkBefore();
          const out = await deps.complete({ system: prompt.system, user: prompt.user, model });
          text = out.text;
          cacheHit = false;
          segCost = out.costUsd;
          cost += out.costUsd;
          ledger.add(out.costUsd);
          await deps.cache.set(key, { text }, deps.now());
        }

        const parsed = parseSegmentsResponse(text);
        const hyp = parsed?.get(0) ?? null;
        await deps.onEvent?.({
          t: 'llm',
          evalKind: 'cleanup',
          lang: code,
          id: row.id,
          arm,
          model,
          promptId,
          promptVersion,
          cacheHit,
          usd: segCost,
          hyp,
        });
        if (hyp === null) {
          failed++;
        } else {
          scored.push({ stats: scoreOne(row.plain, hyp, row.raw), row, hyp });
        }
        log(`  ${code} ${arm}/${model} ${i + 1}/${sample.length}${cacheHit ? ' (cached)' : ''}`);
      }

      arms.push(finishArm(arm, model, promptId, promptVersion, scored, cost, cached, failed));
    }
  }

  return {
    languageCode: code,
    cfg,
    tsvOid: oid,
    n: sample.length,
    distinctIds: new Set(sample.map((r) => r.id)).size,
    arms,
  };
}

/**
 * Aggregate one arm, and pick the examples.
 *
 * The examples are chosen by `content_delta` descending, because that is the metric with no
 * argument attached: those are segments where the model changed something other than
 * punctuation, case and whitespace, and printing them in full is what turns "content_delta
 * 0.004" into a reviewer seeing which word moved.
 */
export interface ScoredSegment {
  stats: CleanupStats;
  row: FleursRow;
  hyp: string;
}

export function finishArm(
  arm: CleanupArm,
  model: string,
  promptId: string | null,
  promptVersion: number | null,
  scored: readonly ScoredSegment[],
  costUsd: number,
  cachedSegments: number,
  failed: number,
): CleanupArmResult {
  const rewritten = scored
    .filter((x) => x.stats.content.edits > 0)
    .sort((a, b) => b.stats.content.edits - a.stats.content.edits)
    .slice(0, 2);

  const lost = new Set<string>();
  for (const x of scored) for (const token of x.stats.entitiesLost) lost.add(token);

  return {
    ...aggregateCleanup(scored.map((x) => x.stats)),
    arm,
    model,
    promptId,
    promptVersion,
    cerPunctCi95: bootstrapCi(scored.map((x) => x.stats.cerPunct)),
    costUsd,
    cachedSegments,
    failed,
    examples: rewritten.map((x) => ({ id: x.row.id, input: x.row.plain, output: x.hyp })),
    entitiesLost: [...lost],
  };
}

function empty(code: string, error?: string, cfg: string | null = null): CleanupLanguageResult {
  return {
    languageCode: code,
    cfg,
    tsvOid: null,
    n: 0,
    distinctIds: 0,
    arms: [],
    ...(error ? { error } : {}),
  };
}

