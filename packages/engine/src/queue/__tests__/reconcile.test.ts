import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { materialisePlan, planRun, type PipelineSpec } from '../plan.js';
import { reconcile, stepFraction } from '../reconcile.js';
import type { Doorbell, PendingSend } from '../queues.js';

describe('stepFraction', () => {
  it('counts a terminal step in full, whatever happened to it', () => {
    // A run that failed shows a full bar and a red state, not a bar frozen at 63% that reads
    // as still working. The frozen bar is what makes people wait an hour for something that
    // already stopped.
    for (const state of ['done', 'skipped', 'failed', 'dead', 'cancelled'] as const) {
      expect(stepFraction({ state, output: null }), state).toBe(1);
    }
  });

  it('credits a started step 10%, and its own report when it has one', () => {
    expect(stepFraction({ state: 'running', output: null })).toBe(0.1);
    expect(stepFraction({ state: 'awaiting_external', output: { progress: 0.26 } })).toBe(0.26);
    // Never inflated upward by guessing, and never out of range.
    expect(stepFraction({ state: 'running', output: { progress: 26 } })).toBe(1);
    expect(stepFraction({ state: 'running', output: { progress: 'lots' } })).toBe(0.1);
  });

  it('credits nothing to work that has not begun', () => {
    expect(stepFraction({ state: 'pending', output: null })).toBe(0);
    expect(stepFraction({ state: 'ready', output: null })).toBe(0);
  });
});

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping reconcile tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const CHUNKED: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'sync_chunked', local: false },
  editorial: [],
  peaks: false,
  exports: [],
};

class RecordingDoorbell implements Doorbell {
  readonly sends: PendingSend[] = [];
  failNext = 0;

  async sendStep(send: PendingSend): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('doorbell unreachable');
    }
    this.sends.push(send);
  }

  get keys(): string[] {
    return this.sends.map((s) => s.singletonKey);
  }

  clear(): void {
    this.sends.length = 0;
  }
}

describe.skipIf(!reachable)('reconcile', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let doorbell: RecordingDoorbell;
  let sha = 0;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(() => {
    doorbell = new RecordingDoorbell();
    ctx = {
      db: t.db,
      doorbell,
      engineVersion: '0.1.0',
      clock: { now: () => new Date(), sleep: async () => {} },
    } as unknown as EngineContext;
  });

  /** A planned run, ready to be driven. */
  const plant = async (p: PipelineSpec, chunkCount: number): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { runId } = await createRun(
      { db: t.db, engineVersion: '0.1.0' } as unknown as EngineContext,
      {
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
      },
    );
    await materialisePlan(t.db, runId, planRun(p, chunkCount));
    return runId;
  };

  interface StepRow {
    kind: string;
    shard: number;
    state: string;
    id: string;
  }

  const steps = async (runId: string): Promise<StepRow[]> =>
    (
      await t.db.$client.query<StepRow>(
        `select id, kind, shard, state from run_steps where run_id = $1 order by ordinal, shard`,
        [runId],
      )
    ).rows;

  const stateOf = async (runId: string, kind: string, shard = -1): Promise<string> => {
    const all = await steps(runId);
    const hit = all.find((s) => s.kind === kind && s.shard === shard);
    if (!hit) throw new Error(`no ${kind}#${shard}`);
    return hit.state;
  };

  const run = async (runId: string): Promise<{ state: string; progress: number }> => {
    const { rows } = await t.db.$client.query<{ state: string; progress: number }>(
      `select state, progress from runs where id = $1`,
      [runId],
    );
    return rows[0]!;
  };

  /** What a worker would do on success, without the worker. */
  const finish = async (runId: string, kind: string, state = 'done', shard = -1): Promise<void> => {
    await t.db.$client.query(
      `update run_steps set state = $3::step_state, finished_at = now()
       where run_id = $1 and kind = $2 and shard = $4`,
      [runId, kind, state, shard],
    );
  };

  const readyKinds = async (runId: string): Promise<string[]> =>
    (await steps(runId)).filter((s) => s.state === 'ready').map((s) => `${s.kind}#${s.shard}`);

  /**
   * Drive every ready step to `done` until nothing this driver is willing to finish is left.
   *
   * `skip` is how a test parks a kind at `ready` — the run is driven up to it and stopped, so
   * the test can decide what happens to that step itself.
   */
  const driveAll = async (runId: string, skip: (k: string, shard: number) => boolean = () => false) => {
    for (let guard = 0; guard < 200; guard++) {
      await reconcile(ctx, runId);
      const ready = (await steps(runId)).filter(
        (s) => s.state === 'ready' && !skip(s.kind, s.shard),
      );
      if (ready.length === 0) return;
      for (const s of ready) await finish(runId, s.kind, 'done', s.shard);
    }
    throw new Error('run did not converge');
  };

  it('promotes only what its dependencies allow, one layer at a time', async () => {
    const runId = await plant(CHUNKED, 8);
    await reconcile(ctx, runId);
    expect(await readyKinds(runId), 'the root and nothing else').toEqual(['media.probe#-1']);
    expect(doorbell.sends).toHaveLength(1);

    await finish(runId, 'media.probe');
    doorbell.clear();
    await reconcile(ctx, runId);
    expect(await readyKinds(runId)).toEqual(['media.normalize#-1']);
  });

  it('fans out to every shard at once and rejoins only when all of them land', async () => {
    const runId = await plant(CHUNKED, 8);
    await driveAll(runId, (k) => k === 'asr.chunk');

    expect(await readyKinds(runId)).toHaveLength(8);
    expect(await stateOf(runId, 'normalize.text'), 'must wait for all eight').toBe('pending');

    for (let i = 0; i < 7; i++) await finish(runId, 'asr.chunk', 'done', i);
    await reconcile(ctx, runId);
    expect(await stateOf(runId, 'normalize.text'), 'seven of eight is not eight').toBe('pending');

    await finish(runId, 'asr.chunk', 'done', 7);
    await reconcile(ctx, runId);
    expect(await stateOf(runId, 'normalize.text')).toBe('ready');
  });

  it('carries on past an optional step that died', async () => {
    const runId = await plant({ ...CHUNKED, peaks: true }, 2);
    await driveAll(runId, (k) => k === 'media.peaks');
    await finish(runId, 'media.peaks', 'dead');
    await driveAll(runId);

    expect(await stateOf(runId, 'media.peaks')).toBe('dead');
    expect((await run(runId)).state, 'a run whose waveform failed is still a transcript').toBe('done');
  });

  it('fails the run when a required step dies, and poisons its dependents rather than hanging them', async () => {
    // Leaving dependents `pending` forever is how a run hangs with no error and no progress —
    // the hardest failure to diagnose from outside, because it looks merely slow.
    const runId = await plant(CHUNKED, 4);
    await reconcile(ctx, runId);
    await finish(runId, 'media.probe');
    await reconcile(ctx, runId);
    await finish(runId, 'media.normalize', 'dead');
    await reconcile(ctx, runId);

    expect(await stateOf(runId, 'plan.chunks')).toBe('failed');
    expect(await stateOf(runId, 'normalize.text')).toBe('failed');
    expect((await run(runId)).state).toBe('failed');

    const { rows } = await t.db.$client.query<{ error: { code: string } }>(
      `select error from run_steps where run_id = $1 and kind = 'plan.chunks'`,
      [runId],
    );
    expect(rows[0]!.error.code).toBe('DEPENDENCY_FAILED');
  });

  it('skips, rather than fails, an optional dependent of a dead required step', async () => {
    const runId = await plant({ ...CHUNKED, exports: [{ format: 'srt', layer: 'verbatim' }] }, 2);
    await reconcile(ctx, runId);
    await finish(runId, 'media.probe');
    await reconcile(ctx, runId);
    await finish(runId, 'media.normalize', 'dead');
    await reconcile(ctx, runId);

    expect(await stateOf(runId, 'export', 0)).toBe('skipped');
  });

  it('finishes a run as partial when one chunk of eight dies', async () => {
    // The behaviour the phase-9 plan intended and its reconciler could not reach: asr.chunk is
    // not optional, so one dead shard made `hardFailed` true and the terminal branch chose
    // `failed` before it ever tested for `partial` — and independently, the poisoning rule
    // marked normalize.text failed, so the transcript would never have been assembled from the
    // seven survivors either. Both are the casualty rule, and this is the test for it.
    const runId = await plant(CHUNKED, 8);
    await driveAll(runId, (k) => k === 'asr.chunk');
    for (let i = 0; i < 7; i++) await finish(runId, 'asr.chunk', 'done', i);
    await finish(runId, 'asr.chunk', 'dead', 7);
    await driveAll(runId);

    expect(await stateOf(runId, 'normalize.text'), 'the survivors still get assembled').toBe('done');
    expect((await run(runId)).state).toBe('partial');
    expect((await run(runId)).progress).toBe(1);
  });

  it('fails a run whose every chunk died', async () => {
    // Nothing was transcribed, so there is no partial transcript to hand anyone. The casualty
    // rule is conditional on a sibling having succeeded precisely so this case stays honest.
    const runId = await plant(CHUNKED, 4);
    await driveAll(runId, (k) => k === 'asr.chunk');
    for (let i = 0; i < 4; i++) await finish(runId, 'asr.chunk', 'dead', i);
    await driveAll(runId);

    expect(await stateOf(runId, 'normalize.text')).toBe('failed');
    expect((await run(runId)).state).toBe('failed');
  });

  it('weights progress by work, not by step count', async () => {
    const runId = await plant(CHUNKED, 8);
    await reconcile(ctx, runId);
    await finish(runId, 'media.probe'); // weight 1
    await reconcile(ctx, runId);
    const afterProbe = (await run(runId)).progress;

    await finish(runId, 'media.normalize'); // weight 8
    await reconcile(ctx, runId);
    const afterNormalize = (await run(runId)).progress;

    expect(afterNormalize - afterProbe).toBeGreaterThan(afterProbe * 5);
  });

  it('never moves progress backwards, in any order things happen to finish', async () => {
    // A property test rather than a case, because the orders that break monotonicity are
    // exactly the ones nobody thinks to write down.
    const runId = await plant({ ...CHUNKED, peaks: true, editorial: [{ kind: 'cleanup' }] }, 6);
    let last = -1;

    for (let i = 0; i < 60; i++) {
      await reconcile(ctx, runId);
      const { progress, state } = await run(runId);
      expect(progress, `progress went backwards at iteration ${i}`).toBeGreaterThanOrEqual(last);
      last = progress;
      if (state !== 'running' && state !== 'pending') break;

      const ready = (await steps(runId)).filter((s) => s.state === 'ready');
      if (ready.length === 0) break;
      const pick = ready[Math.floor(Math.random() * ready.length)]!;
      // A mix of outcomes, so the walk covers skipped and running states too.
      const roll = Math.random();
      const next = roll < 0.7 ? 'done' : roll < 0.9 ? 'running' : 'skipped';
      await finish(runId, pick.kind, next, pick.shard);
    }
  });

  it('leaves a run it did not plan completely alone', async () => {
    // The CLI drives the same stages in one process and never plans a DAG, so its runs have
    // zero steps — and the worker's tick reconciles every live run, those included. Without
    // the guard the terminal check finds nothing outstanding, the pending → running
    // transition fires, and a worker that will never touch that run marks it running at 0%
    // forever. Found by booting the worker against the dev database, not by a test.
    const hex = String(sha++).padStart(64, '0');
    const { runId } = await createRun(
      { db: t.db, engineVersion: '0.1.0' } as unknown as EngineContext,
      {
        sha256: hex,
        storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.flac`,
        filename: 'cli-run.flac',
        bytes: 1234,
        durationMs: 1000,
        probeRaw: null,
        title: 'a run the CLI drives itself',
        languageCode: 'my-MM',
        providerId: 'google',
        model: 'chirp_2',
        mode: 'sync',
      },
    );
    const before = await run(runId);
    await reconcile(ctx, runId);

    expect(await run(runId)).toEqual(before);
    expect(doorbell.sends).toHaveLength(0);
    expect(await t.db.$client.query(`select 1 from run_events where run_id = $1`, [runId]).then((r) => r.rowCount)).toBe(0);
  });

  it('does nothing to a run that has already finished', async () => {
    const runId = await plant(CHUNKED, 2);
    await driveAll(runId);
    expect((await run(runId)).state).toBe('done');

    const before = await t.db.$client.query(`select count(*) as n from run_events where run_id = $1`, [runId]);
    doorbell.clear();
    await reconcile(ctx, runId);
    const after = await t.db.$client.query(`select count(*) as n from run_events where run_id = $1`, [runId]);

    expect(doorbell.sends, 'a terminal run rings no doorbells').toHaveLength(0);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('never sends a step under two different keys, however many reconcilers race', async () => {
    // The phase-9 plan's test says twenty parallel reconciles produce "exactly one send per
    // step". They do not, and should not: every reconcile deliberately re-rings anything
    // already `ready` to cover the window between COMMIT and sendStep. What must hold is that
    // all those sends carry the *same* singleton key, because that is what the doorbell
    // deduplicates on — a second key is a second execution.
    const runId = await plant(CHUNKED, 8);
    await Promise.all(Array.from({ length: 20 }, () => reconcile(ctx, runId)));

    const ready = (await steps(runId)).filter((s) => s.state === 'ready');
    expect(ready).toHaveLength(1);
    expect(new Set(doorbell.keys)).toEqual(new Set([`${ready[0]!.id}:0`]));
  });

  it('leaves committed state intact when the doorbell throws, and re-rings on the next pass', async () => {
    // Sends happen after commit and only after. A crash there must be self-healing, or a run
    // stalls with a promoted step nobody was told about.
    const runId = await plant(CHUNKED, 2);
    doorbell.failNext = 1;
    await expect(reconcile(ctx, runId)).rejects.toThrow('doorbell unreachable');

    expect(await stateOf(runId, 'media.probe'), 'the promotion committed').toBe('ready');
    expect(doorbell.sends).toHaveLength(0);

    await reconcile(ctx, runId);
    expect(doorbell.keys).toHaveLength(1);
  });

  it('cancels what has not started and waits for what has', async () => {
    const runId = await plant(CHUNKED, 8);
    await driveAll(runId, (k) => k === 'asr.chunk');
    await finish(runId, 'asr.chunk', 'running', 0);

    await t.db.$client.query(`update runs set cancel_requested_at = now() where id = $1`, [runId]);
    await reconcile(ctx, runId);

    expect(await stateOf(runId, 'asr.chunk', 1), 'ready work dies immediately').toBe('cancelled');
    expect(await stateOf(runId, 'normalize.text'), 'pending work too').toBe('cancelled');
    expect(await stateOf(runId, 'asr.chunk', 0), 'running work is left to drain').toBe('running');
    expect((await run(runId)).state, 'the run is not terminal until it has drained').toBe('running');

    // The handler observes the AbortSignal and lands the step itself.
    await finish(runId, 'asr.chunk', 'cancelled', 0);
    await reconcile(ctx, runId);
    expect((await run(runId)).state).toBe('cancelled');
  });

  it('holds a retrying step until its backoff expires', async () => {
    // `poll_after` in the future means the step is deliberately pending, not stuck. Promoting
    // it early would spend the whole retry budget in one burst against a provider that just
    // asked us to wait.
    const runId = await plant(CHUNKED, 2);
    await reconcile(ctx, runId);
    await t.db.$client.query(
      `update run_steps set state = 'pending', attempt = 1, poll_after = now() + interval '1 hour'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );
    doorbell.clear();
    await reconcile(ctx, runId);
    expect(await stateOf(runId, 'media.probe')).toBe('pending');
    expect(doorbell.sends).toHaveLength(0);

    await t.db.$client.query(
      `update run_steps set poll_after = now() - interval '1 second'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );
    await reconcile(ctx, runId);
    expect(await stateOf(runId, 'media.probe')).toBe('ready');
    expect(doorbell.keys[0], 'a retry gets its own key, or it dedupes against its own past').toMatch(/:1$/);
  });

  it('emits a terminal event exactly once', async () => {
    const runId = await plant(CHUNKED, 2);
    await driveAll(runId);
    await reconcile(ctx, runId);
    await reconcile(ctx, runId);

    const { rows } = await t.db.$client.query<{ n: string }>(
      `select count(*) as n from run_events where run_id = $1 and kind = 'run.finished'`,
      [runId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
