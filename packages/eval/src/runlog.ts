import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bootstrapCi, type EditStats } from '@thibi/core';
import { applyBaselineAndTiers, type AsrRunResult, type LanguageResult, type RunEvent } from './runner.js';
import type { LlmRunEvent, LlmRunHeader } from './llm/types.js';

/**
 * The runlog — `results/runs/<runId>.jsonl`, append-only, one JSON object per line.
 *
 * Two properties earn it its place, and they are the reason it is written as work completes
 * rather than assembled at the end:
 *
 * 1. **A crashed run is still analysable.** Everything paid for before the crash is on
 *    disk, in order, with the provider's own strings.
 * 2. **`thibi eval report --run <id>` costs nothing.** Changing a threshold, a tier rule or
 *    a report layout re-derives from this file with the network off — which is the property
 *    that makes it safe to argue about thresholds, because nobody has to spend $17 to
 *    settle the argument.
 *
 * The second property is why the `score` lines carry per-clip **edit counts** rather than
 * per-clip rates. A rate cannot be summed back into a corpus CER — the corpus estimator is
 * the ratio of sums — and the bootstrap resamples the `(edits, refLen)` pairs, so a runlog
 * of rates could reproduce neither the headline number nor its interval.
 */

/** Written once, first, before any billable call. */
export interface RunHeader {
  t: 'run';
  runId: string;
  startedAt: string;
  argv: readonly string[];
  engineVersion: string;
  provider: string;
  model: string;
  split: string;
  n: number;
  /** Absent in logs written before 2026-08-13; a replay then assumes the default. */
  sampleStrategy?: 'tar-order' | 'id-seeded';
  seed?: number;
  baselineCode: string;
  baselineAdded: boolean;
}

/** Written last. Absent from a log whose run died, which is how a partial log is detected. */
export interface RunFooter {
  t: 'end';
  finishedAt: string;
  spentUsd: number;
  budgetExhausted: boolean;
}

/**
 * One line of a runlog, ASR or LLM.
 *
 * The two eval families share the writer, the footer and the `budget` line, and diverge in
 * what they record per unit of work. An LLM header carries `evalKind` and an ASR header does
 * not, which is what lets `reconstructRun` refuse a log it should not be reading rather than
 * reconstructing an ASR run out of cleanup lines and finding no `score` lines to recompute.
 */
export type RunlogLine = RunHeader | RunFooter | RunEvent | LlmRunHeader | LlmRunEvent;

export const runlogPath = (resultsDir: string, runId: string): string =>
  join(resultsDir, 'runs', `${runId}.jsonl`);

/**
 * Append-only writer.
 *
 * `appendFile` per line rather than a held stream: a run makes a few hundred writes over
 * minutes of provider latency, so the syscall cost is irrelevant, and nothing has to be
 * closed on the crash path — which is exactly the path the file exists for.
 */
export class RunlogWriter {
  private ready: Promise<void> | null = null;

  constructor(readonly path: string) {}

  async write(line: RunlogLine): Promise<void> {
    this.ready ??= mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    await this.ready;
    await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
  }
}

export function parseRunlog(text: string): RunlogLine[] {
  const out: RunlogLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A run killed mid-write leaves a truncated final line. Dropping it is right — the
    // alternative is refusing to report on everything that was paid for before the crash.
    try {
      out.push(JSON.parse(trimmed) as RunlogLine);
    } catch {
      continue;
    }
  }
  return out;
}

export class MalformedRunlogError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`runlog ${path}: ${reason}`);
    this.name = 'MalformedRunlogError';
  }
}

/**
 * Rebuild the run from its log.
 *
 * Deliberately **recomputes** rather than reading back stored aggregates: the corpus CERs
 * come from the per-clip edit counts, the interval from a fresh bootstrap over the same
 * pairs, and the tiers from `applyBaselineAndTiers`. A reader that trusted a stored `cer`
 * would reproduce the old report exactly and would go on reproducing it after someone
 * changed the estimator — which is the one thing this file exists to prevent.
 *
 * The aggregates that are *not* recomputable from edit counts — script integrity, WER,
 * gender composition — are read from the `summary` line, because they are computed over the
 * concatenated text rather than per clip and re-deriving them would mean storing every
 * normalized string twice.
 */
export function reconstructRun(
  lines: readonly RunlogLine[],
  path = '<memory>',
  humanReviews: Readonly<Record<string, unknown>> = {},
): AsrRunResult {
  const anyHeader = lines.find((l) => l.t === 'run');
  if (!anyHeader) throw new MalformedRunlogError(path, 'no run header line');
  if ('evalKind' in anyHeader) {
    // An LLM log read as an ASR one would find no `score` lines, recompute nothing, and
    // return a run with zero languages — a wrong answer rather than an error. §5.13's whole
    // point is that the reader recomputes, so it has to refuse input it cannot recompute.
    throw new MalformedRunlogError(
      path,
      `this is a '${anyHeader.evalKind}' runlog, not an ASR one — read it with the LLM reader`,
    );
  }
  const header = anyHeader as RunHeader;
  const footer = lines.find((l): l is RunFooter => l.t === 'end');

  const statsByLang = new Map<string, { plain: EditStats[]; nospace: EditStats[] }>();
  for (const line of lines) {
    if (line.t !== 'score') continue;
    let bucket = statsByLang.get(line.lang);
    if (!bucket) statsByLang.set(line.lang, (bucket = { plain: [], nospace: [] }));
    bucket.plain.push({ edits: line.edits, refLen: line.refLen });
    bucket.nospace.push({ edits: line.editsNospace, refLen: line.refLenNospace });
  }

  const results: LanguageResult[] = [];
  for (const line of lines) {
    if (line.t !== 'summary') continue;
    const stats = statsByLang.get(line.lang);
    const recomputed: LanguageResult = { ...line.result };
    /**
     * A language the budget stopped part-way has `score` lines *and* an error, because the
     * clips it did buy were scored before the ceiling refused the next call. Recomputing
     * from them would hand the report the partial CER the runner deliberately threw away —
     * a number over however many clips the money happened to reach, indistinguishable in
     * the table from a complete one. The error is the result.
     */
    if (recomputed.error === undefined && stats && stats.plain.length > 0) {
      recomputed.cer = ratioOfSums(stats.plain);
      recomputed.cerNospace = ratioOfSums(stats.nospace);
      recomputed.cerCi95 = bootstrapCi(stats.nospace);
      recomputed.n = stats.plain.length;
    }
    // Ratio and tier are always recomputed; whatever the log holds was computed against the
    // baseline of the run that wrote it, and the thresholds may have moved since.
    recomputed.ratio = null;
    delete recomputed.tier;
    results.push(recomputed);
  }

  applyBaselineAndTiers(results, humanReviews);

  return {
    runId: header.runId,
    startedAt: header.startedAt,
    finishedAt: footer?.finishedAt ?? header.startedAt,
    provider: header.provider,
    model: header.model,
    split: header.split as AsrRunResult['split'],
    n: header.n,
    // Older logs predate the field. `tar-order` is what they were: it was the only strategy
    // that existed, so assuming it is a fact about those runs rather than a default.
    sampleStrategy: header.sampleStrategy ?? 'tar-order',
    seed: header.seed ?? 1,
    baselineCode: header.baselineCode,
    baselineAdded: header.baselineAdded,
    languages: results,
    spentUsd: footer?.spentUsd ?? sumSpend(lines),
    budgetExhausted: footer?.budgetExhausted ?? lines.some((l) => l.t === 'budget'),
  };
}

export async function readRunlog(
  path: string,
  humanReviews: Readonly<Record<string, unknown>> = {},
): Promise<AsrRunResult> {
  return reconstructRun(parseRunlog(await readFile(path, 'utf8')), path, humanReviews);
}

/** True when the run never wrote its footer — it crashed, or it is still going. */
export function isComplete(lines: readonly RunlogLine[]): boolean {
  return lines.some((l) => l.t === 'end');
}

function ratioOfSums(stats: readonly EditStats[]): number | null {
  let edits = 0;
  let refLen = 0;
  for (const s of stats) {
    edits += s.edits;
    refLen += s.refLen;
  }
  return refLen === 0 ? null : edits / refLen;
}

/** For a log with no footer: what had been spent by the time it stopped. */
function sumSpend(lines: readonly RunlogLine[]): number {
  let usd = 0;
  for (const line of lines) if (line.t === 'asr') usd += line.usd;
  return usd;
}
