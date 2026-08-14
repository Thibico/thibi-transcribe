import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext, Logger } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { CoalescingEventSink, insertAndNotify } from '../emit.js';

/**
 * A connection checked out of the pool for the whole test, and **destroyed** rather than
 * returned.
 *
 * A pooled client cannot be allowed to keep a `LISTEN` and go back in the pool: the
 * subscription outlives the checkout and starts delivering notifications into whatever
 * unrelated query gets that connection next. It is the same hazard that makes PgBouncer in
 * transaction-pooling mode unable to carry `LISTEN` at all, in miniature, and it is why the
 * real `RunEventListener` holds a dedicated client on `DATABASE_URL_DIRECT`.
 */
async function withListener(
  t: TestDb,
  fn: (heard: string[]) => Promise<void>,
): Promise<void> {
  const client = await t.db.$client.connect();
  const heard: string[] = [];
  client.on('notification', (n) => heard.push(n.payload ?? ''));
  await client.query('listen run_events');
  try {
    await fn(heard);
  } finally {
    client.release(true);
  }
}

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping run-event tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!reachable)('run events', () => {
  let t: TestDb;
  let sha = 0;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const newRun = async (): Promise<string> => {
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
    return runId;
  };

  const events = async (runId: string) =>
    (
      await t.db.$client.query<{ seq: string; kind: string; data: Record<string, unknown> }>(
        `select seq, kind, data from run_events where run_id = $1 order by seq`,
        [runId],
      )
    ).rows;

  describe('insertAndNotify', () => {
    it('returns the seq it allocated, monotonically per run', async () => {
      const runId = await newRun();
      const a = await insertAndNotify(t.db, { runId, kind: 'run.progress', data: { progress: 0.1 } });
      const b = await insertAndNotify(t.db, { runId, kind: 'run.progress', data: { progress: 0.2 } });
      expect(b).toBeGreaterThan(a);
      expect((await events(runId)).map((e) => Number(e.seq))).toEqual([a, b]);
    });

    it('notifies a pointer, never the data', async () => {
      // NOTIFY caps a payload at 8000 bytes and a transcript segment blows straight through
      // it. Listeners re-read run_events by seq; this is what "the doorbell, not the
      // transport" means concretely.
      const runId = await newRun();
      await withListener(t, async (heard) => {
        const big = 'x'.repeat(9000);
        const seq = await insertAndNotify(t.db, { runId, kind: 'log', data: { line: big } });
        for (let i = 0; i < 50 && heard.length === 0; i++) await sleep(20);

        expect(heard).toHaveLength(1);
        expect(heard[0]!.length, 'well under the 8000-byte cap').toBeLessThan(500);
        expect(JSON.parse(heard[0]!)).toEqual({ seq, runId, kind: 'log' });
        // The data is in the table, in full.
        expect(((await events(runId))[0]!.data as { line: string }).line).toHaveLength(9000);
      });
    });

    it('is visible to whoever the notification wakes', async () => {
      // The invariant the in-transaction rule buys: a listener must never learn of an event
      // before it can read it. Both become visible at the same instant, because pg_notify
      // inside a transaction is only delivered on commit — so the read below, on a different
      // session, always finds the row.
      const runId = await newRun();
      await withListener(t, async (heard) => {
        await t.db.transaction(async (tx) => {
          await insertAndNotify(tx, { runId, kind: 'run.progress', data: { progress: 0.5 } });
          await insertAndNotify(tx, { runId, kind: 'run.finished', data: { state: 'done' } });
        });

        for (let i = 0; i < 50 && heard.length < 2; i++) await sleep(20);
        expect(heard).toHaveLength(2);

        for (const payload of heard) {
          const { seq } = JSON.parse(payload) as { seq: number };
          const { rows } = await t.db.$client.query<{ n: number }>(
            'select count(*)::int as n from run_events where seq = $1',
            [seq],
          );
          expect(rows[0]!.n, `seq ${seq} was announced but not readable`).toBe(1);
        }
      });
    });

    it('announces nothing when the transaction rolls back', async () => {
      // A transition that did not happen must not be reported as having happened, and this is
      // free rather than a compensating path — precisely because the event shares the
      // caller's transaction.
      const runId = await newRun();
      await withListener(t, async (heard) => {
        await expect(
          t.db.transaction(async (tx) => {
            await insertAndNotify(tx, { runId, kind: 'run.progress', data: { progress: 0.9 } });
            throw new Error('handler threw after emitting');
          }),
        ).rejects.toThrow('handler threw');

        await sleep(200);
        expect(heard).toHaveLength(0);
        expect(await events(runId)).toHaveLength(0);
      });
    });

    it('defaults data to an empty object rather than null', async () => {
      const runId = await newRun();
      await insertAndNotify(t.db, { runId, kind: 'run.cancelling' });
      expect((await events(runId))[0]!.data).toEqual({});
    });
  });

  describe('CoalescingEventSink', () => {
    it('collapses a burst of progress into one row', async () => {
      // A 180-chunk run would otherwise emit a progress event per chunk plus per-chunk logs.
      // The editor does not need 20 Hz, and dropping the superseded ones is safe only because
      // events are snapshots — a dropped `+= 1` would leave the bar permanently short.
      const runId = await newRun();
      const sink = new CoalescingEventSink(t.db, { windowMs: 60 });
      for (let i = 0; i < 50; i++) sink.emit({ runId, kind: 'run.progress', data: { progress: i / 50 } });

      await sleep(200);
      const rows = await events(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data, 'the survivor is the newest, not the first').toEqual({ progress: 49 / 50 });
      await sink.stop();
    });

    it('never makes someone wait out a debounce to learn their run failed', async () => {
      const runId = await newRun();
      const sink = new CoalescingEventSink(t.db, { windowMs: 10_000 });
      sink.emit({ runId, kind: 'run.progress', data: { progress: 0.4 } });
      await sink.emit({ runId, kind: 'run.finished', data: { state: 'failed' } });

      const rows = await events(runId);
      expect(rows.map((r) => r.kind), 'the terminal event does not queue behind the bar').toEqual([
        'run.finished',
      ]);
      await sink.stop();
    });

    it('writes an unrecognised kind straight through', async () => {
      // Coalescing is opt-in per kind. A kind nobody classified is written immediately, which
      // fails safe: too many rows rather than a silently dropped event.
      const runId = await newRun();
      const sink = new CoalescingEventSink(t.db, { windowMs: 10_000 });
      await sink.emit({ runId, kind: 'chunk.done', data: { idx: 3 } });
      expect(await events(runId)).toHaveLength(1);
      await sink.stop();
    });

    it('flushes what it is holding when it stops', async () => {
      const runId = await newRun();
      const sink = new CoalescingEventSink(t.db, { windowMs: 10_000 });
      sink.emit({ runId, kind: 'run.progress', data: { progress: 0.7 } });
      expect(await events(runId), 'still buffered').toHaveLength(0);

      await sink.stop();
      expect(await events(runId)).toHaveLength(1);
    });

    it('drops an event it cannot write rather than failing the step', async () => {
      // This is progress reporting, not the transcript. A run that finished successfully but
      // could not announce it is still a run that finished successfully, and the SSE route's
      // periodic re-read repairs the client's view anyway. Throwing here would convert a
      // cosmetic failure into a dead step.
      const warnings: unknown[] = [];
      const logger = {
        child: () => logger,
        debug: () => {},
        info: () => {},
        warn: (o: object) => warnings.push(o),
        error: () => {},
      } as unknown as Logger;

      const sink = new CoalescingEventSink(t.db, { windowMs: 10, logger });
      // No such run: the foreign key refuses the insert.
      await expect(
        sink.emit({ runId: '00000000-0000-0000-0000-000000000000', kind: 'chunk.done' }),
      ).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      await sink.stop();
    });
  });
});
