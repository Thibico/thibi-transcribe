import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import { PgBossDoorbell } from '../boss.js';
import { ALL_QUEUES, type PendingSend, type StepJob } from '../queues.js';

/**
 * What this suite is for.
 *
 * Every assertion here is a property `reconcile` already relies on, measured against the real
 * library rather than read off its documentation. The one that matters most is the singleton
 * dedup: the plan says "the singleton key makes the re-send free", and under pg-boss's default
 * `standard` policy that is **false** — a `singletonKey` alone does not deduplicate there, and
 * a run whose reconciler ticked forty times would have queued forty jobs for the same step.
 * The `short` policy is what makes the plan's sentence true, and this is where that is
 * established rather than assumed.
 */

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping pg-boss tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const send = (over: Partial<PendingSend> = {}): PendingSend => ({
  queue: 'media',
  singletonKey: 'step-1:0',
  data: { stepId: 'step-1', runId: 'run-1', kind: 'media.probe', attempt: 0 },
  ...over,
});

describe.skipIf(!reachable)('PgBossDoorbell', () => {
  let t: TestDb;
  let doorbell: PgBossDoorbell;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    doorbell = await PgBossDoorbell.create({ connectionString: t.url, max: 4 });
  }, 90_000);

  afterAll(async () => {
    await doorbell?.stop({ graceful: false, timeoutMs: 5_000 });
    await t?.drop();
  }, 90_000);

  /** Read pg-boss's own tables. Only a test may do this; nothing in the engine does. */
  const queued = async (queue: string, key?: string): Promise<number> => {
    const { rows } = await t.db.$client.query<{ n: number }>(
      `select count(*)::int as n from pgboss.job
       where name = $1 and state = 'created' and ($2::text is null or singleton_key = $2)`,
      [queue, key ?? null],
    );
    return rows[0]!.n;
  };

  it('declares every queue at startup, including the ones this container will not work', async () => {
    // A `worker` that does no diarization still has to be able to promote a `diarize` step for
    // `worker-heavy` to pick up. v10+ refuses a send to a queue that does not exist, so
    // declaring only the worked subset would fail at the least convenient moment.
    const { rows } = await t.db.$client.query<{ name: string }>(`select name from pgboss.queue`);
    const names = rows.map((r) => r.name);
    for (const q of ['media', 'worker', 'asr.cloud', 'asr.local', 'asr.poll', 'diarize']) {
      expect(names, `queue "${q}" was not declared`).toContain(q);
    }
  });

  it('deduplicates a re-ring, which is what makes the reconcile tick free', async () => {
    // reconcile re-rings every `ready` step on every pass — the mechanism that covers the
    // window between COMMIT and sendStep. Without dedup that is a queue that grows without
    // bound on any run that takes more than 30 seconds.
    const s = send({ singletonKey: 'dedupe:0' });
    await doorbell.sendStep(s);
    await doorbell.sendStep(s);
    await doorbell.sendStep(s);

    expect(await queued('media', 'dedupe:0')).toBe(1);
  });

  it('deduplicates because of the policy, not because a singleton key was supplied', async () => {
    // The dedup above is a property of the `short` policy, not of passing a singleton key.
    // pg-boss enforces it with a unique index predicated on `policy = 'short'`
    // (`job_i1`, in its own DDL); the default `standard` policy has no equivalent, a singleton
    // key there is inert, and reconcile's re-ring would queue one job per 30-second tick
    // forever. So the policy is asserted on every declared queue rather than left as a default
    // someone could change without noticing what depended on it.
    // Scoped to our queues: pg-boss maintains internal ones of its own (`__pgboss__send-it`)
    // on the default policy, and those are not ours to have an opinion about.
    const { rows } = await t.db.$client.query<{ name: string; policy: string }>(
      `select name, policy from pgboss.queue where name = any($1) order by name`,
      [[...ALL_QUEUES]],
    );
    expect(rows).toHaveLength(ALL_QUEUES.length);
    for (const q of rows) {
      expect(q.policy, `queue "${q.name}" is not on the policy that makes dedup work`).toBe('short');
    }
  });

  it('treats a retry as a different job, because its key carries the attempt', async () => {
    // The mirror image, and the reason the key is `${stepId}:${attempt}` rather than
    // `${stepId}`: a retry deduped against its own earlier send would never run again.
    await doorbell.sendStep(send({ singletonKey: 'retry-me:0' }));
    await doorbell.sendStep(send({ singletonKey: 'retry-me:1' }));

    expect(await queued('media', 'retry-me:0')).toBe(1);
    expect(await queued('media', 'retry-me:1')).toBe(1);
  });

  it('pins retryLimit to 0 on every send', async () => {
    // Our retry policy lives in `run_steps` where an admin can see it. A second mechanism
    // retrying underneath is how a step runs six times while the UI says three.
    await doorbell.sendStep(send({ singletonKey: 'no-retries:0' }));
    const { rows } = await t.db.$client.query<{ retry_limit: number; expire_seconds: number }>(
      `select retry_limit, expire_seconds from pgboss.job where singleton_key = 'no-retries:0'`,
    );
    expect(rows[0]!.retry_limit).toBe(0);
    expect(rows[0]!.expire_seconds, 'a generous lease hint; the heartbeat owns liveness').toBe(1800);
  });

  it('defers a send that carries a backoff', async () => {
    const startAfter = new Date(Date.now() + 3600_000);
    await doorbell.sendStep(send({ singletonKey: 'deferred:0', startAfter }));

    const { rows } = await t.db.$client.query<{ start_after: Date }>(
      `select start_after from pgboss.job where singleton_key = 'deferred:0'`,
    );
    expect(rows[0]!.start_after.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('delivers the job payload back to a worker unchanged', async () => {
    const received: StepJob[] = [];
    await doorbell.work('export', async (jobs) => {
      received.push(...jobs);
    });

    const job: StepJob = { stepId: 'step-9', runId: 'run-9', kind: 'export', attempt: 2 };
    await doorbell.sendStep({ queue: 'export', singletonKey: 'step-9:2', data: job });

    for (let i = 0; i < 60 && received.length === 0; i++) await sleep(100);
    expect(received).toEqual([job]);
  });

  it('does not redeliver a job whose handler threw', async () => {
    // The step's own failure path owns the retry decision, having recorded the error where
    // someone can read it. pg-boss retrying underneath would spend the budget invisibly.
    // On `worker`, which polls every second. `maintenance` polls every 30 s and would make
    // this test either slow or a measure of how long the assertion is willing to wait.
    let calls = 0;
    await doorbell.work('worker', async () => {
      calls += 1;
      throw new Error('handler exploded');
    });

    await doorbell.sendStep({
      queue: 'worker',
      singletonKey: 'boom:0',
      data: { stepId: 'step-b', runId: 'run-b', kind: 'normalize.text', attempt: 0 },
    });

    for (let i = 0; i < 40 && calls === 0; i++) await sleep(100);
    expect(calls).toBe(1);
    // Long enough for a retry to have been delivered if one were scheduled.
    await sleep(2500);
    expect(calls, 'retryLimit: 0 means one attempt, full stop').toBe(1);
  });

  /**
   * **The load-bearing claim in `boss.ts`'s class comment, which had no test.**
   *
   * `short` was chosen over `stately` and `exclusive` because those "also exclude the *active*
   * job", and a re-ring while a step is running has to be allowed. That is not a nicety: it is
   * the entire poll loop. `runStep` calls `reconcile` from its `finally`, which is *inside* the
   * pg-boss handler, so the job carrying the current poll is `active` at the moment the next
   * poll is sent. If `short` excluded active jobs, every self-rescheduling step would ring its
   * own next poll into a void and stall — which is exactly the symptom a live diarization
   * produced on 2026-08-16.
   */
  it('accepts a re-ring sent while a job under the same key is still active', async () => {
    // `!` because the resolvers are assigned inside the executors, which TypeScript cannot see.
    let inHandler!: () => void;
    const entered = new Promise<void>((resolve) => {
      inHandler = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await doorbell.work('editorial', async () => {
      inHandler();
      await held;
    });

    const key = 'active-rering:0';
    const cycle = send({ queue: 'editorial', singletonKey: key });
    await doorbell.sendStep(cycle);
    await entered;

    // The job is active right now. This is the send `reconcile` makes from `runStep`'s finally.
    await doorbell.sendStep({ ...cycle, startAfter: new Date(Date.now() + 3600_000) });
    expect(
      await queued('editorial', key),
      'a re-ring during an active job is how a poll schedules its successor',
    ).toBe(1);

    release();
  });

  /**
   * The poll loop itself, compressed from two hours into a second.
   *
   * A self-rescheduling step runs this cycle for as long as the provider takes: send, work,
   * complete, send again under the *same* key, because polling deliberately does not bump
   * `attempt`. A single dropped link stalls the step until something else happens to ring it,
   * and on 2026-08-16 that cost a diarization which was 64% done and on track to finish.
   *
   * Twenty cycles rather than three: the failure being ruled out is one that appears after a
   * queue has some history — a stale unique index entry, a maintenance pass, a completed job
   * that keeps blocking its own successor.
   */
  it('never drops a link in a repeated send-work-send cycle under one key', async () => {
    // `asr.cloud`, because it is the fastest-polling queue no other test in this file
    // subscribes to — a second `work()` on a queue already worked here would make the count
    // a measure of which handler won.
    const key = 'pollcycle:0';
    const cycle = send({ queue: 'asr.cloud', singletonKey: key });
    let delivered = 0;

    await doorbell.work('asr.cloud', async () => {
      delivered += 1;
      // Ring the next poll from inside the handler, as `runStep`'s finally does.
      await doorbell.sendStep(cycle);
    });

    await doorbell.sendStep(cycle);

    // One cycle per second at this queue's polling interval, so this is generous rather than
    // tight: the failure it looks for is a chain that stops, not one that runs slowly.
    const TARGET = 10;
    for (let i = 0; i < 600 && delivered < TARGET; i++) await sleep(50);

    expect(delivered, 'the chain stalled — see the class comment on `short`').toBeGreaterThanOrEqual(
      TARGET,
    );
  }, 60_000);
});
