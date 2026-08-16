import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { AbortedError, NonRetryableError, RateLimitedError } from '../../errors.js';
import { materialisePlan, planRun, type PipelineSpec } from '../plan.js';
import { runStep, type HandlerRegistry, type StepResult } from '../run-step.js';
import { reclaimStaleLeases, liveRunIds, nudgeExternalWork, recoverTick } from '../recover.js';
import type { Doorbell, PendingSend, StepJob } from '../queues.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping runStep tests.` +
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
  async sendStep(send: PendingSend): Promise<void> {
    this.sends.push(send);
  }
}

describe.skipIf(!reachable)('runStep', () => {
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

  const contextFor = (workerId: string): EngineContext =>
    ({
      db: t.db,
      doorbell,
      workerId,
      engineVersion: '0.1.0',
      clock: { now: () => new Date(), sleep: async () => {} },
    }) as unknown as EngineContext;

  beforeEach(() => {
    doorbell = new RecordingDoorbell();
    ctx = contextFor('host:1:boot-a');
  });

  interface StepRow {
    id: string;
    kind: string;
    shard: number;
    state: string;
    attempt: number;
    lease_owner: string | null;
    heartbeat_at: Date | null;
    poll_after: Date | null;
    finished_at: Date | null;
    external_ref: string | null;
    output: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
    cost_usd: number;
  }

  const plant = async (p: PipelineSpec = CHUNKED, chunkCount = 2): Promise<string> => {
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

  const stepBy = async (runId: string, kind: string, shard = -1): Promise<StepRow> => {
    const { rows } = await t.db.$client.query<StepRow>(
      `select * from run_steps where run_id = $1 and kind = $2 and shard = $3`,
      [runId, kind, shard],
    );
    return rows[0]!;
  };

  /** Put a step in the state a doorbell would find it in. */
  const makeReady = async (runId: string, kind: string, shard = -1): Promise<StepJob> => {
    await t.db.$client.query(
      `update run_steps set state = 'ready' where run_id = $1 and kind = $2 and shard = $3`,
      [runId, kind, shard],
    );
    const s = await stepBy(runId, kind, shard);
    return { stepId: s.id, runId, kind: s.kind as StepJob['kind'], attempt: s.attempt };
  };

  const registry = (fn: () => Promise<StepResult>): HandlerRegistry => ({
    'media.probe': async () => fn(),
  });

  const events = async (runId: string): Promise<Array<{ kind: string; data: Record<string, unknown> }>> =>
    (
      await t.db.$client.query<{ kind: string; data: Record<string, unknown> }>(
        `select kind, data from run_events where run_id = $1 order by seq`,
        [runId],
      )
    ).rows;

  it('records a success, clears the lease, and keeps the cost', async () => {
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');
    await runStep(ctx, registry(async () => ({ state: 'done', output: { durationMs: 1000 }, costUsd: 0.25 })), job);

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('done');
    expect(s.output).toEqual({ durationMs: 1000 });
    expect(Number(s.cost_usd)).toBe(0.25);
    expect(s.lease_owner, 'a finished step holds no lease').toBeNull();
    expect(s.finished_at).not.toBeNull();
  });

  it('ignores a doorbell for an attempt that has already moved on', async () => {
    // The duplicate-delivery guard, and the reason the claim is a conditional UPDATE rather
    // than a read followed by a write. A job delivered for attempt 0 must not be able to
    // claim a step now on attempt 1.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');
    await t.db.$client.query(`update run_steps set attempt = 1 where id = $1`, [job.stepId]);

    let ran = 0;
    await runStep(ctx, registry(async () => {
      ran += 1;
      return { state: 'done' };
    }), job);

    expect(ran).toBe(0);
    expect((await stepBy(runId, 'media.probe')).state).toBe('ready');
  });

  it('runs a step once when the same doorbell arrives twice', async () => {
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    let ran = 0;
    const reg = registry(async () => {
      ran += 1;
      return { state: 'done' };
    });
    await runStep(ctx, reg, job);
    await runStep(ctx, reg, job);

    expect(ran).toBe(1);
  });

  it('parks external work without holding a lease, and remembers the reference', async () => {
    // external_ref is the guard that stops a retried submit from double-billing, so it has to
    // survive the step going idle.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');
    const pollAfter = new Date(Date.now() + 60_000);

    await runStep(
      ctx,
      registry(async () => ({
        state: 'awaiting_external',
        externalRef: 'projects/x/operations/y',
        pollAfter,
        output: { progress: 0.05 },
      })),
      job,
    );

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('awaiting_external');
    expect(s.external_ref).toBe('projects/x/operations/y');
    expect(s.lease_owner, 'awaiting_external is not a lease state').toBeNull();
    expect(s.heartbeat_at).toBeNull();
    expect(s.finished_at, 'it has not finished, it is waiting').toBeNull();
  });

  it('does not spend a retry on slot contention', async () => {
    // The rule that keeps a busy hour from marking half the diarize steps dead. No attempt
    // increment, no error recorded, no event — nothing went wrong.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');
    const before = await stepBy(runId, 'media.probe');

    await runStep(
      ctx,
      registry(async () => ({ state: 'no_slot', retryAfter: new Date(Date.now() + 10_000) })),
      job,
    );

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('pending');
    expect(s.attempt, 'contention is not a fault').toBe(before.attempt);
    expect(s.error).toBeNull();
    expect(s.poll_after).not.toBeNull();
    expect(await events(runId)).toEqual([]);
  });

  it('retries a retryable failure into pending, with a backoff the table can show', async () => {
    // Back to `pending` and not `ready`: the reconciler owns promotion and poll_after becomes
    // the startAfter on the resulting send. One promotion path, one send path, and a wait that
    // is visible in a column rather than held inside a sleeping process.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    await runStep(ctx, registry(async () => { throw new RateLimitedError('slow down'); }), job);

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('pending');
    expect(s.attempt).toBe(1);
    expect(s.poll_after!.getTime()).toBeGreaterThan(Date.now());
    expect(s.error!['message']).toBe('slow down');
    expect((await events(runId)).map((e) => e.kind)).toContain('step.retrying');
  });

  it('kills a non-retryable failure immediately, with attempts to spare', async () => {
    // media.probe allows 2 attempts. Spending the second on a 400 cannot succeed, burns quota,
    // and delays the operator seeing the real message by the length of the backoff.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    await runStep(ctx, registry(async () => { throw new NonRetryableError('bad request'); }), job);

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('dead');
    expect(s.attempt).toBe(1);
    expect(s.finished_at).not.toBeNull();
    expect((await events(runId)).map((e) => e.kind)).toContain('step.dead');
  });

  it('skips rather than kills an optional step that ran out of attempts', async () => {
    const runId = await plant({ ...CHUNKED, peaks: true }, 2);
    await t.db.$client.query(
      `update run_steps set state = 'ready', attempt = 1 where run_id = $1 and kind = 'media.peaks'`,
      [runId],
    );
    const s0 = await stepBy(runId, 'media.peaks');
    const job: StepJob = { stepId: s0.id, runId, kind: 'media.peaks', attempt: 1 };

    await runStep(
      ctx,
      { 'media.peaks': async () => { throw new RateLimitedError('nope'); } },
      job,
    );

    const s = await stepBy(runId, 'media.peaks');
    expect(s.state, 'a run whose waveform failed is still a transcript').toBe('skipped');
    expect((await events(runId)).map((e) => e.kind)).toContain('step.skipped');
  });

  it('lands a cancelled step as cancelled, not as a failure to retry', async () => {
    // Without this, cancelling a run schedules more attempts of the thing just cancelled.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    await runStep(ctx, registry(async () => { throw new AbortedError('cancelled by operator'); }), job);

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('cancelled');
    expect(s.poll_after).toBeNull();
  });

  it('writes nothing when the lease was stolen while the handler worked', async () => {
    // The race the ownership predicate exists for: the heartbeat aborts a stolen lease, but
    // the abort can lose to a handler that was about to return. Without `AND lease_owner =
    // $me` on every write, the zombie stamps its result over the live worker's step.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    await runStep(
      ctx,
      registry(async () => {
        // Worker B reclaims mid-flight, exactly as the recovery sweep would.
        await t.db.$client.query(
          `update run_steps set lease_owner = 'host:2:boot-b' where id = $1`,
          [job.stepId],
        );
        return { state: 'done', output: { from: 'the zombie' } };
      }),
      job,
    );

    const s = await stepBy(runId, 'media.probe');
    expect(s.state, 'still worker B\'s to finish').toBe('running');
    expect(s.output).toBeNull();
    expect(s.lease_owner).toBe('host:2:boot-b');
  });

  it('kills a step whose kind has no handler, and says so', async () => {
    // A worker built before a step kind existed, or a typo in the registry. Retrying gets the
    // same registry, so the budget would only delay the operator seeing why.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');

    await runStep(ctx, {}, job);

    const s = await stepBy(runId, 'media.probe');
    expect(s.state).toBe('dead');
    expect(String(s.error!['message'])).toMatch(/no handler registered.*media\.probe/);
  });

  it('reconciles after every outcome, including a failure', async () => {
    // Which is why no error path in this phase needs bespoke repair logic.
    const runId = await plant();
    const job = await makeReady(runId, 'media.probe');
    await runStep(ctx, registry(async () => ({ state: 'done' })), job);

    expect((await stepBy(runId, 'media.normalize')).state, 'the next step was promoted').toBe('ready');
    expect(doorbell.sends.map((s) => s.data.kind)).toContain('media.normalize');
  });
});

describe.skipIf(!reachable)('recovery sweep', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 500;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(() => {
    ctx = {
      db: t.db,
      doorbell: new RecordingDoorbell(),
      workerId: 'host:1:boot-a',
      engineVersion: '0.1.0',
      clock: { now: () => new Date(), sleep: async () => {} },
    } as unknown as EngineContext;
  });

  const plant = async (): Promise<string> => {
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
    await materialisePlan(t.db, runId, planRun(CHUNKED, 2));
    return runId;
  };

  const row = async (runId: string, kind: string) =>
    (
      await t.db.$client.query<{
        state: string;
        attempt: number;
        lease_owner: string | null;
        poll_after: Date | null;
        external_ref: string | null;
        error: Record<string, unknown> | null;
      }>(`select * from run_steps where run_id = $1 and kind = $2`, [runId, kind])
    ).rows[0]!;

  it('reclaims a step whose worker stopped heartbeating', async () => {
    const runId = await plant();
    await t.db.$client.query(
      `update run_steps set state = 'running', lease_owner = 'host:9:dead',
              heartbeat_at = now() - interval '5 minutes'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );

    expect(await reclaimStaleLeases(ctx)).toEqual([runId]);

    const s = await row(runId, 'media.probe');
    expect(s.state, 'dead work, not lost work').toBe('pending');
    expect(s.attempt, 'the work really was attempted and really did fail').toBe(1);
    expect(s.lease_owner).toBeNull();
    expect(s.error!['code']).toBe('HEARTBEAT_LOST');
    expect(s.error!['lastOwner'], 'who to look at in the logs').toBe('host:9:dead');
  });

  it('leaves a healthy heartbeat alone', async () => {
    const runId = await plant();
    await t.db.$client.query(
      `update run_steps set state = 'running', lease_owner = 'host:1:alive', heartbeat_at = now()
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );

    expect(await reclaimStaleLeases(ctx)).toEqual([]);
    expect((await row(runId, 'media.probe')).state).toBe('running');
  });

  it('kills a reclaimed step that has no attempts left', async () => {
    const runId = await plant();
    await t.db.$client.query(
      `update run_steps set state = 'running', attempt = 1, max_attempts = 2,
              lease_owner = 'host:9:dead', heartbeat_at = now() - interval '5 minutes'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );

    await reclaimStaleLeases(ctx);
    expect((await row(runId, 'media.probe')).state).toBe('dead');
  });

  it('NEVER resets external work — it only makes it pollable now', async () => {
    // The single most valuable line in this phase, and the one whose absence is invisible
    // until the invoice arrives. Resetting an awaiting_external step re-submits work that is
    // already running at a provider and pays for it twice, silently, for two hours.
    const runId = await plant();
    await t.db.$client.query(
      `update run_steps
       set state = 'awaiting_external', external_ref = 'projects/x/operations/y',
           attempt = 2, poll_after = now() + interval '5 minutes'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );

    expect(await nudgeExternalWork(ctx)).toEqual([runId]);

    const s = await row(runId, 'media.probe');
    expect(s.state, 'unchanged').toBe('awaiting_external');
    expect(s.external_ref, 'unchanged — this is what stops the double bill').toBe(
      'projects/x/operations/y',
    );
    expect(s.attempt, 'polling is not a retry').toBe(2);
    expect(s.poll_after!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('does not push a poll further out than it already was', async () => {
    const runId = await plant();
    const past = new Date(Date.now() - 60_000);
    await t.db.$client.query(
      `update run_steps set state = 'awaiting_external', poll_after = $2
       where run_id = $1 and kind = 'media.probe'`,
      [runId, past],
    );

    await nudgeExternalWork(ctx);
    expect((await row(runId, 'media.probe')).poll_after!.getTime()).toBeCloseTo(past.getTime(), -3);
  });

  /**
   * The nudge is a *boot* statement, and running it on the 60-second tick was a bug that only
   * a handler using `awaiting_external` could ever expose.
   *
   * `least(poll_after, now())` drags a scheduled poll forward. On the periodic tick that means
   * every poll is pulled back to now once a minute, so a capped backoff of 30 s → 300 s
   * silently becomes a flat 60 s: a two-hour batch run would make 120 pointless requests
   * against a quota the sync path also needs.
   */
  it('does not drag a scheduled poll forward on the periodic tick', async () => {
    const runId = await plant();
    const future = new Date(Date.now() + 5 * 60_000);
    await t.db.$client.query(
      `update run_steps set state = 'awaiting_external', poll_after = $2
       where run_id = $1 and kind = 'media.probe'`,
      [runId, future],
    );

    const tick = await recoverTick(ctx);
    expect(tick.nudged).toBe(0);
    expect((await row(runId, 'media.probe')).poll_after!.getTime()).toBeCloseTo(
      future.getTime(),
      -3,
    );

    // The boot call still does it, which is what makes a restart cost nothing rather than a
    // poll cycle.
    const boot = await recoverTick(ctx, { nudgeExternal: true });
    expect(boot.nudged).toBeGreaterThanOrEqual(1);
    expect((await row(runId, 'media.probe')).poll_after!.getTime()).toBeLessThanOrEqual(
      Date.now() + 1000,
    );
  });

  it('lists live runs and skips finished ones', async () => {
    const live = await plant();
    const done = await plant();
    await t.db.$client.query(`update runs set state = 'done' where id = $1`, [done]);

    const ids = await liveRunIds(ctx);
    expect(ids).toContain(live);
    expect(ids).not.toContain(done);
  });

  it('reports what it repaired', async () => {
    const runId = await plant();
    await t.db.$client.query(
      `update run_steps set state = 'running', lease_owner = 'host:9:dead',
              heartbeat_at = now() - interval '5 minutes'
       where run_id = $1 and kind = 'media.probe'`,
      [runId],
    );

    const report = await recoverTick(ctx);
    expect(report.reclaimed).toBeGreaterThanOrEqual(1);
    expect(report.reconciled).toBeGreaterThanOrEqual(1);
    // And the reconcile that follows re-promotes it, which is the point of the sweep.
    expect((await row(runId, 'media.probe')).state).toBe('ready');
  });
});
