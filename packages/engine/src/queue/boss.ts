// A named export in v12; v9 and earlier were `export default`. One of several signature
// changes across the two majors between the phase-9 plan and the current release, and the
// reason every one of them is contained to this file.
import { PgBoss } from 'pg-boss';
import type { Logger } from '../context.js';
import {
  ALL_QUEUES,
  SUBSCRIPTIONS,
  type Doorbell,
  type PendingSend,
  type QueueName,
  type StepJob,
} from './queues.js';

/**
 * The only file in this repository that imports pg-boss.
 *
 * Everything else depends on `Doorbell`, which is two methods wide. That is the overview's
 * cut-list escape hatch made real: if pg-boss ever becomes a problem, the replacement is a
 * `FOR UPDATE SKIP LOCKED` fetch loop behind the same interface and `reconcile.ts` does not
 * change. The plan's risk 1 — version churn — has already half-materialised: it was written
 * against v10 and the current release is v12, two majors on, with queues now first-class
 * objects that must be declared before anything can be sent to them.
 *
 * **What pg-boss is for here, and what it is emphatically not for.** It is a doorbell: it
 * tells a worker that a step is ready, with a delay when we ask for one, and it deduplicates
 * a repeated ring. It holds no state that matters. Deleting its tables and restarting must
 * lose nothing but latency, because `run_steps` is the source of truth and the 30-second
 * reconcile tick re-rings everything that is still `ready`.
 */

/**
 * `standard` would be wrong, and this is the detail the whole re-ring design rests on.
 *
 * `reconcile` re-rings every `ready` step on every pass, which is what covers the window
 * between COMMIT and `sendStep`. Under pg-boss's default `standard` policy a `singletonKey`
 * on its own does **not** deduplicate — dedup there is a throttling feature and needs
 * `singletonSeconds` — so a run whose reconciler ticked forty times would have forty queued
 * jobs for the same step. `short` is the policy that means what the plan assumed: at most one
 * job *queued* per `singletonKey`, and a second send returns null.
 *
 * `short` deliberately rather than `stately` or `exclusive`, both of which also exclude the
 * *active* job. A re-ring while the step is already running is harmless — `runStep` claims
 * with `WHERE state IN ('ready','awaiting_external') AND attempt = $n`, so a duplicate
 * delivery finds `running` and returns without doing anything — and the stricter policies buy
 * that redundant protection at the price of blocking a legitimate retry behind a job that is
 * still finishing.
 *
 * Measured rather than taken from the documentation; see `boss.test.ts`.
 */
const QUEUE_POLICY = 'short';

/**
 * A lease hint, not a policy.
 *
 * Generous on purpose, because the heartbeat sweep owns liveness. pg-boss expiring a job
 * while our step is still `running` would create a duplicate of work already in flight, and
 * the 90-second heartbeat window detects a dead worker far more accurately than any fixed
 * timeout could. 30 minutes is long enough for the longest single handler that holds a worker
 * slot — a chunk transcription — and short enough that pg-boss's own bookkeeping still tidies
 * up after a hard kill.
 */
const EXPIRE_IN_SECONDS = 30 * 60;

export interface CreateDoorbellOptions {
  /**
   * Postgres connection string. pg-boss gets its **own pool**, not the engine's.
   *
   * It polls every queue on a one-to-five-second timer; sharing `ctx.db`'s pool would mean
   * that polling competes for the same connections as the handlers' own queries, and a
   * saturated pool would stall both at once — the doorbell going quiet exactly when the
   * system is busiest. pg-boss ships a Drizzle adapter that would allow sharing; it is not
   * used, for that reason and because it is one more thing to break at the next major.
   */
  connectionString: string;
  /** Default 8. pg-boss needs one connection per worked queue plus maintenance headroom. */
  max?: number;
  /** Default `pgboss`. Its own schema keeps `\dt` legible and makes "drop it all" one line. */
  schema?: string;
  logger?: Logger;
}

/**
 * pg-boss behind `Doorbell`.
 *
 * `sendStep` is the only way out of this module and `boss.send` is not re-exported, which is
 * how `retryLimit: 0` is enforced in one place rather than at every call site. Two retry
 * mechanisms racing is how a step runs six times while the UI says three — and our retry
 * count is the one an admin can see on `/admin/queue` next to the error that caused it.
 */
export class PgBossDoorbell implements Doorbell {
  private constructor(
    private readonly boss: PgBoss,
    private readonly logger: Logger | undefined,
  ) {}

  static async create(options: CreateDoorbellOptions): Promise<PgBossDoorbell> {
    const boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? 'pgboss',
      max: options.max ?? 8,
    });

    // pg-boss emits on its own error channel, and an unhandled 'error' event takes the
    // process down. A doorbell that cannot ring is a latency problem and never a correctness
    // one, because the reconcile tick re-rings whatever is still `ready` — so it must not be
    // able to kill a worker in the middle of a transcription.
    boss.on('error', (err) => {
      options.logger?.error({ err }, 'pg-boss error');
    });

    await boss.start();

    // v10+ requires a queue to exist before anything can be sent to it. Declaring all of them
    // on every boot — rather than only the ones this container works — means a `worker` that
    // does no diarization can still promote a `diarize` step for `worker-heavy` to pick up.
    // Creating a queue that exists is a no-op.
    for (const name of ALL_QUEUES) {
      await boss.createQueue(name, { policy: QUEUE_POLICY });
    }

    return new PgBossDoorbell(boss, options.logger);
  }

  async sendStep(send: PendingSend): Promise<void> {
    const id = await this.boss.send(send.queue, send.data, {
      // Enforced here and nowhere else. See the class comment.
      retryLimit: 0,
      expireInSeconds: EXPIRE_IN_SECONDS,
      singletonKey: send.singletonKey,
      ...(send.startAfter ? { startAfter: send.startAfter } : {}),
    });

    // null means the singleton key already had a job queued — the re-ring did its job by not
    // doing anything. Logged at debug because on a busy run it is the common case.
    if (id === null) {
      this.logger?.debug({ key: send.singletonKey, queue: send.queue }, 'doorbell already rung');
    }
  }

  /**
   * Subscribe to a queue.
   *
   * The handler receives a batch and is responsible for every job in it. It must not throw:
   * a step's failure is recorded on the step, and letting it escape here would mark the whole
   * batch failed in pg-boss's tables, which is state we have already decided not to keep.
   */
  async work(queue: QueueName, handler: (jobs: StepJob[]) => Promise<void>): Promise<void> {
    const sub = SUBSCRIPTIONS[queue];
    await this.boss.work<StepJob>(
      queue,
      { batchSize: sub.batchSize, pollingIntervalSeconds: sub.pollingIntervalSeconds },
      async (jobs) => {
        await handler(jobs.map((j) => j.data));
      },
    );
  }

  /**
   * Fetch no new jobs, let in-flight handlers finish, then release the pool.
   *
   * **One method, not the plan's `stop` then `close`.** v12 dropped the `wait` option because
   * `stop()` now blocks until the drain completes — an improvement — but it also returns
   * early on a second call, so draining with `close: false` and then calling again to release
   * the pool would silently leak every connection. The pool is ours alone (see
   * `connectionString` above), so there is nothing to keep it open for.
   *
   * A handler that cannot finish inside `timeoutMs` is killed by the container's
   * `stop_grace_period` and picked up by the next boot's heartbeat sweep 90 seconds later.
   * That is the "lose at most one chunk" guarantee, stated mechanically.
   */
  async stop(options: { graceful?: boolean; timeoutMs?: number } = {}): Promise<void> {
    await this.boss.stop({
      graceful: options.graceful ?? true,
      close: true,
      timeout: options.timeoutMs ?? 100_000,
    });
  }
}
