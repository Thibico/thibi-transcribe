import { corpusChrf2, normalizeForScoring } from '@thibi/core';
import {
  buildTranslatePrompt,
  detectZawgyi,
  promptVars,
  zawgyiToUnicode,
  TRANSLATE_DEFAULT,
  TRANSLATE_VERSION,
} from '@thibi/engine';
import { LANGUAGES } from '@thibi/languages';
import { loadTsv as loadTsvLive, NoEvalSetError, type FleursRow, type Split } from '../fleurs/tsv.js';
import { paramsHashOf, responseKey, textHashOf } from '../cache.js';
import { scoreProfileFor } from '../profile.js';
import { dedupeById, sampleSeeded } from '../sample.js';
import { BudgetExhausted, Ledger } from './ledger.js';
import { parseSegmentsResponse } from './parse.js';
import { TEMPERATURE, type LlmRunDeps, type LlmRunOptions } from './types.js';

/**
 * `thibi eval translate` — chrF2 against FLEURS' own parallel text.
 *
 * FLEURS column 0 is a **shared sentence key across languages**, which is the entire reason
 * this eval is possible without a translation corpus: the same sentence exists in every
 * config, so an inner join on `id` produces real reference translations for free.
 *
 * **Two controls, and they are measured rather than quoted.** The research this eval
 * reproduces reports an English→English ceiling of 87.0 and a Burmese bar of 65.6; neither
 * number may be written into a report here as though it had been observed, because it has
 * not. So both are run as languages:
 *
 * - the **ceiling** is the target language translated into itself. It is not 100 — the model
 *   rewords — and knowing where it actually sits is what stops a reader taking 72 for "72%
 *   correct".
 * - the **bar** is the language already in production. A candidate at or above it is a
 *   candidate at the quality this product already ships.
 *
 * No gate. Translation quality is a language property, not a regression surface; the gate
 * belongs on cleanup, where a prompt edit silently damages text.
 */

export const CEILING_ROLE = 'ceiling';
export const BAR_CODE = 'my-MM';

export interface TranslateArmResult {
  model: string;
  promptId: string;
  promptVersion: number;
  /** Segments that produced a scoreable pair. Smaller than `n` if any response failed. */
  scored: number;
  chrf2: number | null;
  costUsd: number;
  cachedSegments: number;
  failed: number;
  examples: Array<{ id: number; source: string; output: string; reference: string }>;
}

export interface TranslateLanguageResult {
  languageCode: string;
  cfg: string | null;
  /** Rows the inner join produced. Smaller than either side, and reported as such. */
  joined: number;
  n: number;
  role: 'measured' | 'ceiling' | 'bar';
  arms: TranslateArmResult[];
  error?: string;
}

export interface TranslateRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  models: readonly string[];
  target: string;
  split: Split;
  n: number;
  seed: number;
  languages: TranslateLanguageResult[];
  spentUsd: number;
  budgetExhausted: boolean;
}

export interface RunTranslateOptions extends LlmRunOptions {
  /** BCP-47 registry code, e.g. `en-US`. A parameter, never a literal, all the way down. */
  target: string;
}


export async function runTranslateEval(
  deps: LlmRunDeps,
  opts: RunTranslateOptions,
): Promise<TranslateRunResult> {
  const split = opts.split ?? 'dev';
  const seed = opts.seed ?? 1;
  const startedAt = deps.now();
  const log = opts.onProgress ?? (() => {});
  const ledger = new Ledger(opts.budgetUsd ?? null);

  // The two controls are added the way the ASR runner adds its baseline: a run that quietly
  // skipped them would produce a table of chrF2 scores with nothing to read them against.
  const requested = [...opts.languages];
  for (const code of [opts.target, BAR_CODE]) {
    if (!requested.includes(code)) requested.push(code);
  }

  const languages: TranslateLanguageResult[] = [];
  for (const code of requested) {
    const role: TranslateLanguageResult['role'] =
      code === opts.target ? 'ceiling' : code === BAR_CODE ? 'bar' : 'measured';
    if (ledger.exhausted) {
      languages.push(empty(code, role, 'not run: budget exhausted'));
      continue;
    }
    try {
      const result = await runLanguage(deps, opts, split, seed, code, role, ledger, log);
      languages.push(result);
      await deps.onEvent?.({
        t: 'llmsummary',
        evalKind: 'translate',
        lang: code,
        result: { ...result },
      });
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        await deps.onEvent?.({ t: 'budget', spentUsd: ledger.spent, limitUsd: opts.budgetUsd ?? 0 });
        languages.push(empty(code, role, 'stopped part-way: budget exhausted'));
        continue;
      }
      languages.push(empty(code, role, err instanceof Error ? err.message : String(err)));
    }
  }

  return {
    runId: opts.runId ?? `${startedAt.toISOString().replace(/[:.]/gu, '-')}-${opts.provider}`,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    provider: opts.provider,
    models: opts.models,
    target: opts.target,
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
  opts: RunTranslateOptions,
  split: Split,
  seed: number,
  code: string,
  role: TranslateLanguageResult['role'],
  ledger: Ledger,
  log: (line: string) => void,
): Promise<TranslateLanguageResult> {
  const entry = LANGUAGES[code];
  const cfg = entry?.fleurs.config ?? null;
  const targetEntry = LANGUAGES[opts.target];
  const targetCfg = targetEntry?.fleurs.config ?? null;
  if (!entry || cfg === null) return empty(code, role, undefined, cfg);
  if (!targetEntry || targetCfg === null) {
    return empty(code, role, `no FLEURS config for target ${opts.target}`, cfg);
  }

  const loadTsv = deps.loadTsv ?? loadTsvLive;
  let sourceRows: FleursRow[];
  let targetRows: FleursRow[];
  try {
    sourceRows = (await loadTsv(opts.cacheDir, cfg, split)).rows;
    targetRows =
      cfg === targetCfg ? sourceRows : (await loadTsv(opts.cacheDir, targetCfg, split)).rows;
  } catch (err) {
    if (err instanceof NoEvalSetError) return empty(code, role, undefined, null);
    throw err;
  }

  // Dedupe both sides by `id` before joining, then inner-join. `n` is reported *after* the
  // join because it is smaller than either side and a table that showed the requested n would
  // overstate what was measured.
  const targetById = new Map(dedupeById(targetRows).rows.map((r) => [r.id, r]));
  const joinable = dedupeById(sourceRows).rows.filter((r) => targetById.has(r.id));
  const sample = sampleSeeded(joinable, opts.n, seed);

  const targetProfile = scoreProfileFor(opts.target);
  if (!targetProfile) return empty(code, role, `no scoring profile for ${opts.target}`, cfg);

  for (const row of sample) {
    await deps.onEvent?.({
      t: 'seg',
      evalKind: 'translate',
      lang: code,
      id: row.id,
      input: row.raw,
      ref: targetById.get(row.id)!.raw,
    });
  }

  const scoreText = (s: string) =>
    normalizeForScoring(s, targetProfile, {
      // chrF is punctuation-sensitive and the reference is punctuated English, so neither is
      // stripped. This is a translation metric, not the ASR one.
      keepPunctuation: true,
      caseFold: false,
      ...(targetProfile.zawgyiApplies
        ? { convertZawgyi: (t: string) => (detectZawgyi(t) ? zawgyiToUnicode(t) : t) }
        : {}),
    });

  const paramsHash = paramsHashOf({
    promptId: TRANSLATE_DEFAULT,
    promptVersion: TRANSLATE_VERSION,
    target: opts.target,
    temperature: TEMPERATURE,
  });

  const arms: TranslateArmResult[] = [];
  for (const model of opts.models) {
    const pairs: Array<{ hyp: string; ref: string }> = [];
    const examples: TranslateArmResult['examples'] = [];
    let cost = 0;
    let cached = 0;
    let failed = 0;

    for (const [i, row] of sample.entries()) {
      const reference = targetById.get(row.id)!.raw;
      const prompt = buildTranslatePrompt({
        source: promptVars(code),
        target: promptVars(opts.target),
        segments: [{ idx: 0, text: row.raw }],
      });
      const key = responseKey({
        provider: opts.provider,
        model,
        lang: code,
        clipHash: textHashOf(row.raw),
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

      const hyp = parseSegmentsResponse(text)?.get(0) ?? null;
      await deps.onEvent?.({
        t: 'llm',
        evalKind: 'translate',
        lang: code,
        id: row.id,
        arm: 'translate',
        model,
        promptId: TRANSLATE_DEFAULT,
        promptVersion: TRANSLATE_VERSION,
        cacheHit,
        usd: segCost,
        hyp,
      });
      if (hyp === null) {
        failed++;
      } else {
        pairs.push({ hyp: scoreText(hyp), ref: scoreText(reference) });
        if (examples.length < 2) examples.push({ id: row.id, source: row.raw, output: hyp, reference });
      }
      log(`  ${code} translate/${model} ${i + 1}/${sample.length}${cacheHit ? ' (cached)' : ''}`);
    }

    arms.push({
      model,
      promptId: TRANSLATE_DEFAULT,
      promptVersion: TRANSLATE_VERSION,
      scored: pairs.length,
      // Corpus chrF2: statistics summed across every pair and scored once, never the mean of
      // sentence scores — the same rule as `corpusCer`, and sacrebleu's own aggregation.
      chrf2: pairs.length === 0 ? null : corpusChrf2(pairs),
      costUsd: cost,
      cachedSegments: cached,
      failed,
      examples,
    });
  }

  return {
    languageCode: code,
    cfg,
    joined: joinable.length,
    n: sample.length,
    role,
    arms,
  };
}

function empty(
  code: string,
  role: TranslateLanguageResult['role'],
  error?: string,
  cfg: string | null = null,
): TranslateLanguageResult {
  return {
    languageCode: code,
    cfg,
    joined: 0,
    n: 0,
    role,
    arms: [],
    ...(error ? { error } : {}),
  };
}

