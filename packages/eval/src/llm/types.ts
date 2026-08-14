import type { Split } from '../fleurs/tsv.js';
import type { ResponseCache } from '../cache.js';
import type { LoadTsvFn } from '../runner.js';

/**
 * The one call that costs money in an LLM eval, injected exactly like `RunAsrDeps.transcribe`.
 *
 * Amendment 75 is the argument, and it was paid for: `runner.ts` took `transcribe` as a
 * dependency while importing `loadTsv` and `fetchClips` directly, so the single module that
 * spends money was the only module in the package no test could reach — and it carried a real
 * budget defect for a day with 84 eval tests green. Ask of any dependency that is imported
 * rather than injected: what can no longer be tested because of it?
 */
export interface LlmRequest {
  system: string;
  user: string;
  model: string;
}

export interface LlmResponse {
  /** The raw assistant message. Parsing is the harness's job, not the caller's. */
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type LlmComplete = (req: LlmRequest) => Promise<LlmResponse>;

/**
 * Temperature is a constant here rather than an option, and it is in the cache key.
 *
 * These evals measure prompts, not sampling luck. A run at a different temperature is a
 * different measurement and must not collide with this one in the cache — hence its presence
 * in `paramsHash` — but nothing in the CLI offers to change it, because a gate whose arms
 * were sampled at different temperatures would be comparing two things at once.
 */
export const TEMPERATURE = 0;

/**
 * The arms of the cleanup eval.
 *
 * `control` makes **no API call**: the hypothesis is the input. It is a real arm and every
 * other arm is scored against it, per language — a table without the control column is not a
 * valid report, because the finding this whole eval exists to reproduce is that a cleanup
 * pass can be *worse than doing nothing*, and only a control can show that. A fixed threshold
 * could not: thresholds get tuned until they pass, and a control cannot be.
 */
export type CleanupArm = 'control' | 'current' | 'restraint';

export interface LlmRunDeps {
  complete: LlmComplete;
  cache: ResponseCache;
  now: () => Date;
  /** Defaults to the live HF loader. Injected so a test never touches the network. */
  loadTsv?: LoadTsvFn;
  onEvent?: (event: LlmRunEvent) => void | Promise<void>;
}

export interface LlmRunOptions {
  languages: readonly string[];
  n: number;
  split?: Split;
  cacheDir: string;
  /** The LLM provider id, for the cache key and the report. `openai`, `groq`, `anthropic`. */
  provider: string;
  models: readonly string[];
  /** The text-eval sampler's shuffle seed. Written to the runlog so a sample is reproducible. */
  seed?: number;
  budgetUsd?: number | null;
  runId?: string;
  onProgress?: (line: string) => void;
}

/**
 * What an LLM run emits.
 *
 * A `seg` line carries the input and the reference **once** per segment; the `llm` lines that
 * follow carry only what each arm returned. That is the whole replay mechanism: every metric
 * in the report is recomputed from these strings, so changing a threshold, a normalizer or
 * the entity regex costs zero API calls, and a stored aggregate cannot outlive the estimator
 * that produced it.
 */
export type LlmRunEvent =
  | {
      t: 'seg';
      evalKind: 'cleanup' | 'translate';
      lang: string;
      id: number;
      /** Cleanup: FLEURS column 3. Translate: the source language's column 2. */
      input: string;
      /** Cleanup: FLEURS column 2. Translate: the target language's column 2. */
      ref: string;
    }
  | {
      t: 'llm';
      evalKind: 'cleanup' | 'translate';
      lang: string;
      id: number;
      arm: string;
      model: string;
      promptId: string;
      promptVersion: number;
      cacheHit: boolean;
      usd: number;
      /** Null when the response could not be parsed — counted, never silently replaced. */
      hyp: string | null;
    }
  | { t: 'budget'; spentUsd: number; limitUsd: number }
  | { t: 'llmsummary'; evalKind: 'cleanup'; lang: string; result: unknown }
  | { t: 'llmsummary'; evalKind: 'translate'; lang: string; result: unknown };

/** Written first, before any billable call, and it is what names the log file. */
export interface LlmRunHeader {
  t: 'run';
  /** Present on LLM logs and absent on ASR ones; the ASR reader refuses a log carrying it. */
  evalKind: 'cleanup' | 'translate';
  runId: string;
  startedAt: string;
  argv: readonly string[];
  engineVersion: string;
  provider: string;
  models: readonly string[];
  arms: readonly string[];
  split: string;
  n: number;
  seed: number;
  /** The target language, `translate` only. */
  target?: string;
}
