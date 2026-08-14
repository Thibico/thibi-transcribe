import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResponseCache } from '../cache.js';
import type { FleursRow, Split } from '../fleurs/tsv.js';
import { runTranslateEval } from '../llm/translate.js';
import type { LlmRunDeps, LlmRunEvent } from '../llm/types.js';

/**
 * The translation eval.
 *
 * What only this module does is the **join**: FLEURS column 0 is a shared sentence key across
 * languages, so the reference translations come from the target language's own split. The
 * numbers themselves are `corpusChrf2`, proved against sacrebleu in `@thibi/core`.
 */

function row(id: number, raw: string): FleursRow {
  return { id, filename: `${id}.wav`, raw, plain: raw.toLowerCase(), graphemes: '', numSamples: 16_000, gender: 'MALE' };
}

// Hausa ids 1-3, English ids 2-4: the join is two rows, and neither side's count is the
// number a report may print.
const HAUSA = [row(1, 'Ga wannan.'), row(2, 'Ya kamata.'), row(3, 'Ba haka ba.')];
const ENGLISH = [row(2, 'It should be.'), row(3, 'Not like that.'), row(4, 'Something else.')];
const BURMESE = [row(2, 'ဒါဖြစ်သင့်တယ်။'), row(3, 'အဲဒီလိုမဟုတ်ဘူး။')];

interface Harness {
  deps: LlmRunDeps;
  events: LlmRunEvent[];
  calls: Array<{ model: string; user: string }>;
}

function harness(options: { cacheDir: string; reply?: (user: string) => string }): Harness {
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
      loadTsv: async (_dir: string, cfg: string, _split: Split) => ({
        rows: cfg === 'en_us' ? ENGLISH : cfg === 'my_mm' ? BURMESE : HAUSA,
        oid: `oid-${cfg}`,
        dropped: 0,
      }),
      complete: async ({ user, model }) => {
        calls.push({ model, user });
        const text =
          options.reply?.(user) ??
          JSON.stringify({ segments: [{ idx: 0, text: 'It should be.' }] });
        return { text, costUsd: 0.001, inputTokens: 50, outputTokens: 50 };
      },
    },
  };
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thibi-tr-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { n: 10, cacheDir: '', provider: 'fake', models: ['m1'], seed: 1, target: 'en-US' };

describe('runTranslateEval', () => {
  it('reports n after the inner join, not before it', async () => {
    const h = harness({ cacheDir: dir });
    const run = await runTranslateEval(h.deps, { ...base, cacheDir: dir, languages: ['ha-NG'] });
    const hausa = run.languages.find((l) => l.languageCode === 'ha-NG')!;
    // Three Hausa rows and three English rows, but only two ids in common. Asking for n=10
    // and printing 3 would overstate what was scored.
    expect(hausa.joined).toBe(2);
    expect(hausa.n).toBe(2);
  });

  it('adds the ceiling and the bar to every run', async () => {
    // Both are measured here rather than quoted from the research: 87.0 and 65.6 are numbers
    // from somebody else's table and may not appear as though observed.
    const h = harness({ cacheDir: dir });
    const run = await runTranslateEval(h.deps, { ...base, cacheDir: dir, languages: ['ha-NG'] });
    expect(run.languages.map((l) => l.role)).toEqual(['measured', 'ceiling', 'bar']);
    const ceiling = run.languages.find((l) => l.role === 'ceiling')!;
    expect(ceiling.languageCode).toBe('en-US');
    expect(ceiling.arms[0]!.chrf2).not.toBeNull();
  });

  it('sends the source language as the source and scores against the target row', async () => {
    const h = harness({ cacheDir: dir });
    await runTranslateEval(h.deps, { ...base, cacheDir: dir, languages: ['ha-NG'] });
    const hausaCalls = h.calls.filter((c) => c.user.includes('Ya kamata'));
    expect(hausaCalls).toHaveLength(1);
    const segs = h.events.filter((e) => e.t === 'seg' && e.lang === 'ha-NG');
    expect(segs[0]).toMatchObject({ evalKind: 'translate' });
    // The reference is the English row with the same id, which is the whole trick.
    expect(segs.map((s) => (s.t === 'seg' ? s.ref : '')).sort()).toEqual([
      'It should be.',
      'Not like that.',
    ]);
  });

  it('scores a perfect translation at 100 and a wrong one below it', async () => {
    const perfect = harness({
      cacheDir: dir,
      reply: (user) => {
        const source = JSON.parse(user).segments[0].text as string;
        const answer = source === 'Ya kamata.' ? 'It should be.' : 'Not like that.';
        return JSON.stringify({ segments: [{ idx: 0, text: answer }] });
      },
    });
    const good = await runTranslateEval(perfect.deps, {
      ...base,
      cacheDir: dir,
      languages: ['ha-NG'],
    });
    expect(good.languages[0]!.arms[0]!.chrf2).toBeCloseTo(100, 6);

    // A second cache directory, so the run above cannot answer this one from cache.
    const wrong = harness({
      cacheDir: join(dir, 'second'),
      reply: () => JSON.stringify({ segments: [{ idx: 0, text: 'Completely different words.' }] }),
    });
    const bad = await runTranslateEval(wrong.deps, {
      ...base,
      cacheDir: dir,
      languages: ['ha-NG'],
    });
    expect(bad.languages[0]!.arms[0]!.chrf2!).toBeLessThan(100);
  });

  it('counts an unparseable response rather than scoring it', async () => {
    const h = harness({ cacheDir: dir, reply: () => 'sorry' });
    const run = await runTranslateEval(h.deps, { ...base, cacheDir: dir, languages: ['ha-NG'] });
    const arm = run.languages[0]!.arms[0]!;
    expect(arm.failed).toBe(2);
    expect(arm.scored).toBe(0);
    expect(arm.chrf2).toBeNull();
  });
});
