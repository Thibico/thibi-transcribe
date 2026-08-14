import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { materialisePlan, planRun, type PipelineSpec, type StepSpec } from '../plan.js';

const BASE: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'sync_chunked', local: false },
  editorial: [],
  peaks: false,
  exports: [],
};

const spec = (over: Partial<PipelineSpec> = {}): PipelineSpec => ({ ...BASE, ...over });

const kinds = (steps: StepSpec[]): string[] => steps.map((s) => s.kind);
const find = (steps: StepSpec[], kind: string, shard = -1): StepSpec => {
  const hit = steps.find((s) => s.kind === kind && s.shard === shard);
  if (!hit) throw new Error(`no ${kind}#${shard} in [${kinds(steps).join(', ')}]`);
  return hit;
};

describe('planRun', () => {
  it('plans a chunked run as a fan-out that rejoins at normalize.text', () => {
    const steps = planRun(spec(), 8);
    expect(steps.filter((s) => s.kind === 'asr.chunk')).toHaveLength(8);
    expect(find(steps, 'normalize.text').dependsOn).toEqual([['asr.chunk', '*']]);
    expect(find(steps, 'asr.chunk', 3).dependsOn).toEqual([['plan.chunks', -1]]);
    expect(find(steps, 'asr.chunk', 3).input).toEqual({ chunkIdx: 3 });
  });

  it('plans a batch run as submit → poll → fetch, with no chunk shards', () => {
    const steps = planRun(spec({ asr: { ...BASE.asr, mode: 'batch' } }), 8);
    expect(steps.filter((s) => s.kind === 'asr.chunk')).toHaveLength(0);
    expect(find(steps, 'asr.poll').dependsOn).toEqual([['asr.batch.submit', -1]]);
    expect(find(steps, 'normalize.text').dependsOn).toEqual([['asr.fetch', -1]]);
    expect(find(steps, 'staging.cleanup').optional, 'a failed GCS delete is not a failed run').toBe(true);
  });

  it('keeps the poll off the queue the long job is on', () => {
    // The split exists so a 1 h 40 m pyannote job cannot starve the sub-second poll that
    // keeps a batchRecognize alive. Polls on the heavy queue is what makes a batch run look
    // hung, and it is a one-word mistake.
    const steps = planRun(spec({ asr: { ...BASE.asr, mode: 'batch' } }), 0);
    expect(find(steps, 'asr.poll').queue).toBe('asr.poll');
    const withDiarize = planRun(spec({ diarize: { providerId: 'pyannote', required: false } }), 1);
    expect(find(withDiarize, 'diarize').queue).toBe('diarize');
    expect(find(withDiarize, 'diarize.poll').queue).toBe('asr.poll');
  });

  it('routes local ASR to the GPU-contended queue and nothing else with it', () => {
    const steps = planRun(spec({ asr: { ...BASE.asr, local: true } }), 2);
    expect(find(steps, 'asr.chunk', 0).queue).toBe('asr.local');
    expect(find(steps, 'media.normalize').queue).toBe('media');
    expect(find(steps, 'normalize.text').queue).toBe('worker');
  });

  it('runs diarization beside ASR, never after it', () => {
    // ~0.6× realtime on CPU means 1 h 40 m on a one-hour interview against about a minute for
    // the ASR. Gating the transcript on it would mean nobody sees a word for an hour and a
    // half, so both consume the same normalized derivative and neither waits for the other.
    const steps = planRun(spec({ diarize: { providerId: 'pyannote', required: false } }), 4);
    expect(find(steps, 'diarize').dependsOn).toEqual([['media.normalize', -1]]);
    expect(find(steps, 'reconcile.speakers').dependsOn).toEqual([
      ['asr.chunk', '*'],
      ['diarize.poll', -1],
    ]);
  });

  it('makes a best-effort diarization optional and a required one not', () => {
    const best = planRun(spec({ diarize: { providerId: 'pyannote', required: false } }), 1);
    expect(find(best, 'diarize').optional).toBe(true);
    const required = planRun(spec({ diarize: { providerId: 'pyannote', required: true } }), 1);
    expect(find(required, 'diarize').optional).toBe(false);
    // reconcile.speakers is optional either way: a transcript with unattributed speakers is
    // still a transcript, and every segment carries needs_speaker_review to say so.
    expect(find(required, 'reconcile.speakers').optional).toBe(true);
  });

  it('shards editorial passes and exports by their position in the spec', () => {
    const steps = planRun(
      spec({
        editorial: [{ kind: 'cleanup' }, { kind: 'translate', targetLang: 'en-US' }],
        exports: [{ format: 'srt', layer: 'verbatim' }],
      }),
      1,
    );
    expect(find(steps, 'editorial.pass', 1).input).toEqual({
      pass: { kind: 'translate', targetLang: 'en-US' },
    });
    expect(find(steps, 'export', 0).optional, 'an export is on demand, never run-fatal').toBe(true);
  });

  it('omits peaks unless asked', () => {
    expect(kinds(planRun(spec(), 1))).not.toContain('media.peaks');
    expect(kinds(planRun(spec({ peaks: true }), 1))).toContain('media.peaks');
  });

  it('plans through plan.chunks when the chunk count is not yet known', () => {
    // The two-stage plan. Duration comes from media.probe and a URL import has none until the
    // download finishes, so the first plan is deliberately made with chunkCount = 0 and the
    // plan.chunks handler re-plans with the real count in the transaction that writes
    // run_chunks. Everything up to that point must still be there.
    const first = planRun(spec(), 0);
    expect(kinds(first)).toContain('plan.chunks');
    expect(first.filter((s) => s.kind === 'asr.chunk')).toHaveLength(0);
  });

  it('emits steps in a topological order', () => {
    // `reconcile` walks steps by ordinal and relies on this: it is what lets one pass promote
    // a whole chain instead of one link per call. Asserted here, at the planner, because that
    // is where the invariant lives — the reconciler only consumes it.
    for (const p of [
      spec({ peaks: true, diarize: { providerId: 'pyannote', required: false } }),
      spec({ asr: { ...BASE.asr, mode: 'batch' }, editorial: [{ kind: 'cleanup' }] }),
      spec({ exports: [{ format: 'srt', layer: 'verbatim' }] }),
    ]) {
      const steps = planRun(p, 5);
      const seen = new Map<string, number>();
      for (const s of steps) {
        for (const [depKind] of s.dependsOn) {
          expect(seen.has(depKind), `${s.kind} depends on ${depKind}, which comes later`).toBe(true);
        }
        seen.set(s.kind, s.ordinal);
      }
      expect(steps.map((s) => s.ordinal)).toEqual(steps.map((_, i) => i));
    }
  });

  it('is pure — the same spec twice is the same plan', () => {
    const p = spec({ peaks: true, diarize: { providerId: 'pyannote', required: true } });
    expect(planRun(p, 8)).toEqual(planRun(p, 8));
  });
});

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping materialisePlan tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

interface StepSnapshot {
  kind: string;
  shard: number;
  ordinal: number;
  queue: string;
  optional: boolean;
  weight: number;
  max_attempts: number;
  depends_on: string[];
  /** The system column that changes on any UPDATE, whether or not a value did. */
  xmin: string;
}

describe.skipIf(!reachable)('materialisePlan', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 0;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = { db: t.db, engineVersion: '0.1.0' } as unknown as EngineContext;
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const newRun = async (): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { runId } = await createRun(ctx, {
      sha256: hex,
      storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.flac`,
      filename: 'interview.flac',
      bytes: 1234,
      durationMs: 33_575,
      probeRaw: null,
      title: 'interview',
      languageCode: 'my-MM',
      providerId: 'google',
      model: 'chirp_2',
      mode: 'sync',
    });
    return runId;
  };

  const snapshot = async (runId: string): Promise<StepSnapshot[]> => {
    const { rows } = await t.db.$client.query<StepSnapshot>(
      `select kind, shard, ordinal, queue, optional, weight, max_attempts, depends_on,
              xmin::text as xmin
       from run_steps where run_id = $1 order by ordinal, shard`,
      [runId],
    );
    return rows;
  };

  it('resolves a wildcard to every shard, at plan time and once', () => {
    // depends_on is uuid[] rather than a natural key precisely so the reconciler never has to
    // re-expand `['asr.chunk','*']` on the hot path.
    return (async () => {
      const runId = await newRun();
      await materialisePlan(t.db, runId, planRun(spec(), 8));
      const rows = await snapshot(runId);

      const chunkIds = new Set(
        (
          await t.db.$client.query<{ id: string }>(
            `select id from run_steps where run_id = $1 and kind = 'asr.chunk'`,
            [runId],
          )
        ).rows.map((r) => r.id),
      );
      const normalize = rows.find((r) => r.kind === 'normalize.text')!;
      expect(normalize.depends_on).toHaveLength(8);
      expect(new Set(normalize.depends_on)).toEqual(chunkIds);
    })();
  });

  it('is convergent — replanning an unchanged run updates literally nothing', async () => {
    // Not "produces compatible rows": zero writes. The planner runs on run creation, on boot
    // recovery and on every manual retry, so a version that rewrote rows each time would churn
    // the table and, worse, would mean a crash mid-plan could not simply be retried.
    const runId = await newRun();
    const steps = planRun(spec({ peaks: true, diarize: { providerId: 'pyannote', required: false } }), 8);

    await materialisePlan(t.db, runId, steps);
    const before = await snapshot(runId);
    await materialisePlan(t.db, runId, steps);
    const after = await snapshot(runId);

    expect(after).toEqual(before);
    // xmin is the assertion that matters: it advances on any UPDATE, even one writing the
    // values that were already there. Comparing only the columns would pass while the second
    // call rewrote all 20 rows.
    expect(after.map((r) => r.xmin)).toEqual(before.map((r) => r.xmin));
  });

  it('orders wildcard dependencies, so replanning cannot rewrite them into a new sequence', async () => {
    // Without `order by dep.id` inside array_agg, Postgres may aggregate the eight matches in
    // any order, `is distinct from` stops suppressing the update, and this test fails
    // intermittently — the worst way for it to fail, because it passes on most runs.
    const runId = await newRun();
    const steps = planRun(spec(), 8);
    await materialisePlan(t.db, runId, steps);
    const first = (await snapshot(runId)).find((r) => r.kind === 'normalize.text')!;

    for (let i = 0; i < 5; i++) await materialisePlan(t.db, runId, steps);
    const last = (await snapshot(runId)).find((r) => r.kind === 'normalize.text')!;

    expect(last.depends_on).toEqual(first.depends_on);
    expect([...last.depends_on].sort()).toEqual(last.depends_on);
    expect(last.xmin).toBe(first.xmin);
  });

  it('extends a half-planned run rather than refusing it', async () => {
    // The two-stage plan in practice: plan through plan.chunks with no chunks, then again with
    // the real count. The second call must add only the new shards, and must rewire the
    // wildcard dependent to include them.
    const runId = await newRun();
    await materialisePlan(t.db, runId, planRun(spec(), 0));
    const before = await snapshot(runId);
    expect(before.filter((r) => r.kind === 'asr.chunk')).toHaveLength(0);

    await materialisePlan(t.db, runId, planRun(spec(), 8));
    const after = await snapshot(runId);

    expect(after.filter((r) => r.kind === 'asr.chunk')).toHaveLength(8);
    expect(after.find((r) => r.kind === 'normalize.text')!.depends_on).toHaveLength(8);
    // Everything that already existed keeps its identity; only its dependency array moved.
    const probeBefore = before.find((r) => r.kind === 'media.probe')!;
    const probeAfter = after.find((r) => r.kind === 'media.probe')!;
    expect(probeAfter.xmin).toBe(probeBefore.xmin);
  });

  it('survives being run twice concurrently', async () => {
    // Boot recovery and a manual retry can land at the same instant. ON CONFLICT DO NOTHING
    // is what makes that a no-op rather than a unique-violation an operator has to repair.
    const runId = await newRun();
    const steps = planRun(spec(), 8);
    await Promise.all([
      materialisePlan(t.db, runId, steps),
      materialisePlan(t.db, runId, steps),
      materialisePlan(t.db, runId, steps),
    ]);
    const rows = await snapshot(runId);
    expect(rows).toHaveLength(steps.length);
    expect(rows.find((r) => r.kind === 'normalize.text')!.depends_on).toHaveLength(8);
  });

  it('does nothing at all with an empty plan', async () => {
    const runId = await newRun();
    await materialisePlan(t.db, runId, []);
    expect(await snapshot(runId)).toHaveLength(0);
  });
});
