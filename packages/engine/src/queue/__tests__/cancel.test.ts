import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { AbortedError } from '../../errors.js';
import { isRunCancelling, requestCancel } from '../cancel.js';
import { withHeartbeat } from '../lease.js';
import { materialisePlan, planRun, type PipelineSpec } from '../plan.js';
import { runStep, type HandlerRegistry } from '../run-step.js';
import { reconcile } from '../reconcile.js';
import type { Doorbell, PendingSend, StepJob } from '../queues.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping cancellation tests.` +
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

describe.skipIf(!reachable)('cancellation', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 300;

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

  const runRow = async (
    runId: string,
  ): Promise<{ cancel_requested_at: Date | null; cancel_requested_by: string | null }> =>
    (
      await t.db.$client.query<{ cancel_requested_at: Date | null; cancel_requested_by: string | null }>(
        `select cancel_requested_at, cancel_requested_by from runs where id = $1`,
        [runId],
      )
    ).rows[0]!;

  describe('requestCancel', () => {
    it('records when and who, and says a cancel was started', async () => {
      const runId = await plant();

      const outcome = await requestCancel(ctx, runId, 'yan@thibi.co');

      expect(outcome).toEqual({ requested: true, requestedBy: 'yan@thibi.co' });
      const row = await runRow(runId);
      expect(row.cancel_requested_at).not.toBeNull();
      expect(row.cancel_requested_by, 'the column §10 writes and phase 1 never created').toBe(
        'yan@thibi.co',
      );
      expect(await isRunCancelling(ctx, runId)).toBe(true);
    });

    it('leaves the requester null when nobody is signed in', async () => {
      // The CLI has no authenticated user, which is why the column is nullable and not a
      // `users` foreign key. A NOT NULL here would have to be back-filled with a lie.
      const runId = await plant();
      const outcome = await requestCancel(ctx, runId);
      expect(outcome).toEqual({ requested: true, requestedBy: null });
      expect((await runRow(runId)).cancel_requested_by).toBeNull();
    });

    /**
     * A second press is what an impatient user does while a forty-minute diarization refuses
     * to die. It must not move the timestamp — "when was this cancelled" has to keep answering
     * the question it was asked — and it must not read as a failure.
     */
    it('is idempotent, and says so rather than pretending it acted', async () => {
      const runId = await plant();
      await requestCancel(ctx, runId, 'first');
      const at = (await runRow(runId)).cancel_requested_at;

      const again = await requestCancel(ctx, runId, 'second');

      expect(again.requested).toBe(false);
      const row = await runRow(runId);
      expect(row.cancel_requested_at!.getTime()).toBe(at!.getTime());
      expect(row.cancel_requested_by, 'the first requester is the one who cancelled it').toBe(
        'first',
      );
    });

    it('refuses to cancel a run that has already finished', async () => {
      const runId = await plant();
      await t.db.$client.query(`update runs set state = 'done' where id = $1`, [runId]);

      expect((await requestCancel(ctx, runId, 'late')).requested).toBe(false);
      expect((await runRow(runId)).cancel_requested_at).toBeNull();
    });

    it('emits run.cancelling so a watcher learns of it with everything else', async () => {
      const runId = await plant();
      await requestCancel(ctx, runId, 'yan@thibi.co');

      const { rows } = await t.db.$client.query<{ kind: string; data: { by: string } }>(
        `select kind, data from run_events where run_id = $1 order by seq`,
        [runId],
      );
      expect(rows.map((r) => r.kind)).toContain('run.cancelling');
      expect(rows.find((r) => r.kind === 'run.cancelling')!.data.by).toBe('yan@thibi.co');
    });
  });

  describe('propagation', () => {
    it('kills queued steps on the next reconcile, without waiting for anything', async () => {
      const runId = await plant();
      await reconcile(ctx, runId);
      await requestCancel(ctx, runId, 'yan@thibi.co');
      await reconcile(ctx, runId);

      const { rows } = await t.db.$client.query<{ kind: string; state: string }>(
        `select kind, state from run_steps where run_id = $1 order by ordinal`,
        [runId],
      );
      expect(rows.every((r) => r.state === 'cancelled')).toBe(true);
    });

    /**
     * **The mechanism this sitting added.** A cancel that only stops the *next* step is not a
     * cancel — the expensive work is the step already in flight, and reaching it is what §10
     * proposes a `LISTEN` channel for. The heartbeat does it instead, and this is the assertion
     * that it does: the handler is running, the run is cancelled underneath it, and its signal
     * fires without anything else being called.
     */
    it('aborts a handler that is already running', async () => {
      const runId = await plant();
      await t.db.$client.query(
        `update run_steps set state = 'running', lease_owner = 'host:1:boot-a', heartbeat_at = now()
         where run_id = $1 and kind = 'media.probe'`,
        [runId],
      );
      const { rows } = await t.db.$client.query<{ id: string }>(
        `select id from run_steps where run_id = $1 and kind = 'media.probe'`,
        [runId],
      );
      const stepId = rows[0]!.id;

      // 20 ms rather than the real 15 s: the timer is trivial, the statement is the new logic,
      // and a 15-second test is one people stop running.
      const aborted = await withHeartbeat(
        ctx,
        { id: stepId },
        'host:1:boot-a',
        async (signal) => {
          await requestCancel(ctx, runId, 'yan@thibi.co');
          for (let i = 0; i < 200 && !signal.aborted; i++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return signal.aborted ? signal.reason : null;
        },
        { intervalMs: 20 },
      );

      expect(aborted, 'the running handler was never told').toBeInstanceOf(AbortedError);
      expect((aborted as AbortedError).message).toMatch(/cancelled/i);
    });

    it('does not abort a handler whose run is healthy', async () => {
      // The mirror image, and the reason it is worth its own test: a check that fires on every
      // run is not a cancel mechanism, it is an outage.
      const runId = await plant();
      await t.db.$client.query(
        `update run_steps set state = 'running', lease_owner = 'host:1:boot-a', heartbeat_at = now()
         where run_id = $1 and kind = 'media.probe'`,
        [runId],
      );
      const { rows } = await t.db.$client.query<{ id: string }>(
        `select id from run_steps where run_id = $1 and kind = 'media.probe'`,
        [runId],
      );

      const reason = await withHeartbeat(
        ctx,
        { id: rows[0]!.id },
        'host:1:boot-a',
        async (signal) => {
          await new Promise((r) => setTimeout(r, 120));
          return signal.aborted ? signal.reason : null;
        },
        { intervalMs: 20 },
      );

      expect(reason).toBeNull();
    });

    /**
     * The whole path, end to end: a running step is cancelled, its handler observes the abort,
     * and `runStep` lands it `cancelled` rather than scheduling four more attempts of the thing
     * the user just stopped. `AbortedError` being non-retryable is what makes that true.
     */
    it('lands a cancelled step as cancelled and spends no retry', async () => {
      const runId = await plant();
      const { rows } = await t.db.$client.query<{ id: string; attempt: number }>(
        `update run_steps set state = 'ready' where run_id = $1 and kind = 'media.probe'
         returning id, attempt`,
        [runId],
      );
      const job: StepJob = {
        stepId: rows[0]!.id,
        runId,
        kind: 'media.probe',
        attempt: rows[0]!.attempt,
      };

      const registry: HandlerRegistry = {
        'media.probe': async () => {
          await requestCancel(ctx, runId, 'yan@thibi.co');
          throw new AbortedError('the run was cancelled');
        },
      };
      await runStep(ctx, registry, job);

      const step = await t.db.$client.query<{ state: string; attempt: number }>(
        `select state, attempt from run_steps where id = $1`,
        [job.stepId],
      );
      expect(step.rows[0]!.state).toBe('cancelled');
      expect(step.rows[0]!.attempt, 'a cancel is not a failure to retry').toBe(1);

      const run = await t.db.$client.query<{ state: string }>(
        `select state from runs where id = $1`,
        [runId],
      );
      expect(run.rows[0]!.state).toBe('cancelled');
    });
  });
});
