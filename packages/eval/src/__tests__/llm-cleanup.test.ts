import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_RESTRAINT, CLEANUP_VERSIONS } from '@thibi/engine';
import { paramsHashOf, responseKey, ResponseCache, textHashOf } from '../cache.js';
import type { FleursRow, Split } from '../fleurs/tsv.js';
import { runCleanupEval } from '../llm/cleanup.js';
import { gateCleanup } from '../llm/gate.js';
import { TEMPERATURE, type LlmRunDeps, type LlmRunEvent } from '../llm/types.js';

/**
 * The cleanup runner — the module that spends money, under test with nothing billable in it.
 *
 * Everything the harness could get wrong about *how often* it calls a model is here: the free
 * control arm, the cache, the budget ceiling, and what happens to a response it cannot parse.
 * The metrics themselves are asserted in `llm-metrics.test.ts`; asserting a CER here would be
 * asserting Levenshtein twice.
 */

// Hausa, because the entity metric's Latin branch is off for it and the numbers below then
// depend only on what the fake model returns.
const CODE = 'ha-NG';

function row(id: number, plain: string, raw: string): FleursRow {
  return { id, filename: `${id}.wav`, raw, plain, graphemes: '', numSamples: 16_000, gender: 'FEMALE' };
}

const ROWS = [
  row(1, 'ga wannan sanarwa', 'Ga wannan sanarwa.'),
  row(2, 'ya kamata a yi haka', 'Ya kamata a yi haka.'),
];

interface Harness {
  deps: LlmRunDeps;
  events: LlmRunEvent[];
  calls: Array<{ model: string; system: string }>;
}

function harness(options: {
  cacheDir: string;
  reply?: (system: string, user: string) => string;
  costUsd?: number;
  rows?: FleursRow[];
}): Harness {
  const events: LlmRunEvent[] = [];
  const calls: Harness['calls'] = [];
  let tick = 0;
  return {
    events,
    calls,
    deps: {
      now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++)),
      cache: new ResponseCache(options.cacheDir),
      onEvent: (e) => {
        events.push(e);
      },
      loadTsv: async (_dir: string, _cfg: string, _split: Split) => ({
        rows: options.rows ?? ROWS,
        oid: 'oid-1',
        dropped: 0,
      }),
      complete: async ({ system, user, model }) => {
        calls.push({ model, system });
        const text =
          options.reply?.(system, user) ??
          JSON.stringify({ segments: [{ idx: 0, text: `${JSON.parse(user).segments[0].text}.` }] });
        return { text, costUsd: options.costUsd ?? 0.001, inputTokens: 100, outputTokens: 100 };
      },
    },
  };
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thibi-llm-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  languages: [CODE],
  n: 2,
  cacheDir: '',
  provider: 'fake',
  models: ['m1'],
  seed: 1,
};

describe('runCleanupEval', () => {
  it('runs the control arm without calling the model at all', async () => {
    const h = harness({ cacheDir: dir });
    const run = await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['control'] });
    expect(h.calls).toHaveLength(0);
    expect(run.spentUsd).toBe(0);
    const control = run.languages[0]!.arms[0]!;
    expect(control.arm).toBe('control');
    // The control is a real measurement: hypothesis = input, scored against the punctuated
    // reference, so its CER is the cost of doing nothing rather than zero.
    expect(control.cerPunct).toBeGreaterThan(0);
    expect(control.contentDelta).toBe(0);
  });

  it('runs the control before anything billable', async () => {
    // A budget that runs out mid-run still has to leave the column every other arm is judged
    // against, so the free arm goes first.
    const h = harness({ cacheDir: dir });
    const run = await runCleanupEval(h.deps, {
      ...base,
      cacheDir: dir,
      arms: ['restraint', 'control'],
    });
    expect(run.languages[0]!.arms.map((a) => a.arm)).toEqual(['control', 'restraint']);
  });

  it('is free on the second run', async () => {
    const first = harness({ cacheDir: dir });
    await runCleanupEval(first.deps, { ...base, cacheDir: dir, arms: ['control', 'restraint'] });
    expect(first.calls).toHaveLength(2);

    const second = harness({ cacheDir: dir });
    const run = await runCleanupEval(second.deps, {
      ...base,
      cacheDir: dir,
      arms: ['control', 'restraint'],
    });
    expect(second.calls).toHaveLength(0);
    expect(run.spentUsd).toBe(0);
    expect(run.languages[0]!.arms.find((a) => a.arm === 'restraint')!.cachedSegments).toBe(2);
  });

  it('scores each arm against its own prompt id, so two arms are two cache entries', async () => {
    const h = harness({ cacheDir: dir });
    await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['current', 'restraint'] });
    expect(h.calls).toHaveLength(4);
    // The two arms are different prompts, and the cache key carries promptId + promptVersion.
    expect(new Set(h.calls.map((c) => c.system)).size).toBe(2);
  });

  it('writes the response under a key that carries promptId and promptVersion', async () => {
    /**
     * The gate is only real because of this. `paramsHashOf` proves the *hash* changes with a
     * version bump; this proves the runner actually feeds it one, end to end — without that
     * line a bumped prompt is a cache hit and the gate passes on the previous prompt's
     * numbers (§5.10, "one line in §5.8").
     */
    const h = harness({ cacheDir: dir });
    await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['restraint'] });
    const cache = new ResponseCache(dir);
    const keyFor = (promptVersion: number) =>
      responseKey({
        provider: 'fake',
        model: 'm1',
        lang: CODE,
        clipHash: textHashOf(ROWS[0]!.plain),
        paramsHash: paramsHashOf({
          promptId: CLEANUP_RESTRAINT,
          promptVersion,
          temperature: TEMPERATURE,
        }),
      });
    expect(await cache.get(keyFor(CLEANUP_VERSIONS[CLEANUP_RESTRAINT]))).not.toBeNull();
    expect(await cache.get(keyFor(CLEANUP_VERSIONS[CLEANUP_RESTRAINT] + 1))).toBeNull();
  });

  it('counts an unparseable response instead of falling back to the input', async () => {
    const h = harness({ cacheDir: dir, reply: () => 'I am sorry, I cannot do that.' });
    const run = await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['control', 'restraint'] });
    const arm = run.languages[0]!.arms.find((a) => a.arm === 'restraint')!;
    expect(arm.failed).toBe(2);
    expect(arm.n).toBe(0);
    expect(arm.cerPunct).toBeNull();
    // And the runlog says so per segment rather than only in the total.
    const llm = h.events.filter((e) => e.t === 'llm');
    expect(llm.every((e) => e.t === 'llm' && e.hyp === null)).toBe(true);
  });

  it('stops before the call that would exceed the budget', async () => {
    // A ledger that notices it has overspent is not a budget. With a $0.001 cost per call and
    // a $0.0015 ceiling, the second call is refused rather than the third.
    const h = harness({ cacheDir: dir, costUsd: 0.001 });
    const run = await runCleanupEval(h.deps, {
      ...base,
      cacheDir: dir,
      arms: ['control', 'restraint'],
      budgetUsd: 0.0015,
    });
    expect(h.calls).toHaveLength(1);
    expect(run.budgetExhausted).toBe(true);
    // The language is reported as stopped, not as a measurement over one segment.
    expect(run.languages[0]!.error).toContain('budget');
    expect(run.languages[0]!.arms).toHaveLength(0);
  });

  it('records the input and the reference once per segment, and each arm separately', async () => {
    const h = harness({ cacheDir: dir });
    await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['control', 'restraint'] });
    const segs = h.events.filter((e) => e.t === 'seg');
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ input: 'ga wannan sanarwa', ref: 'Ga wannan sanarwa.' });
    // The control makes no call and therefore writes no `llm` line: the log records what
    // happened, and nothing happened.
    expect(h.events.filter((e) => e.t === 'llm')).toHaveLength(2);
  });

  it('reports a language with no FLEURS set at all rather than failing the run', async () => {
    const h = harness({ cacheDir: dir });
    const run = await runCleanupEval(h.deps, {
      ...base,
      cacheDir: dir,
      languages: ['si-LK', CODE],
      arms: ['control'],
    });
    expect(run.languages[0]!.cfg).toBeNull();
    expect(run.languages[0]!.arms).toHaveLength(0);
    expect(run.languages[1]!.arms).toHaveLength(1);
  });
});

describe('the gate, over a real run', () => {
  it('fails an arm that is worse than doing nothing, and names it', async () => {
    // The model returns a rewritten sentence: a different word, correctly punctuated. That is
    // the exact failure shape the research found — fluent output, altered content.
    const h = harness({
      cacheDir: dir,
      reply: () => JSON.stringify({ segments: [{ idx: 0, text: 'Ba haka ba ne ko kaɗan.' }] }),
    });
    const run = await runCleanupEval(h.deps, {
      ...base,
      cacheDir: dir,
      arms: ['control', 'current'],
    });
    const failures = gateCleanup(run);
    expect(failures.map((f) => f.metric)).toContain('cer_punct');
    expect(failures.map((f) => f.metric)).toContain('content_delta');
    expect(failures[0]!.code).toBe(CODE);
    expect(failures[0]!.example?.output).toContain('Ba haka ba ne');
  });

  it('passes an arm that only adds punctuation', async () => {
    const h = harness({ cacheDir: dir });
    const run = await runCleanupEval(h.deps, {
      ...base,
      cacheDir: dir,
      arms: ['control', 'restraint'],
    });
    expect(gateCleanup(run)).toEqual([]);
  });

  it('refuses to pass a run with no control arm', async () => {
    // A gate that silently passes when its comparison is missing is worse than no gate.
    const h = harness({ cacheDir: dir });
    const run = await runCleanupEval(h.deps, { ...base, cacheDir: dir, arms: ['restraint'] });
    expect(gateCleanup(run).map((f) => f.metric)).toEqual(['control_missing']);
  });
});
