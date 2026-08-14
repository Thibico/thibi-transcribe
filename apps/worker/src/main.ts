import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildContext } from '@thibi/runtime';
import {
  CoalescingEventSink,
  PgBossDoorbell,
  SUBSCRIPTIONS,
  isUserFacing,
  reconcileAllLive,
  recoverTick,
  runStep,
  type EngineContext,
  type Logger,
} from '@thibi/engine';
import { parseWorkerEnv, WorkerEnvError } from './env.js';
import { startHealthServer, type HealthState } from './health.js';
import { createHandlerRegistry } from './handlers/index.js';

/**
 * Defaults that are not the operator's business, kept here rather than as env vars nobody
 * will ever set. The overview's rule is that a knob exists when someone has a reason to turn
 * it, and these two are load-bearing timings rather than tuning.
 */
const RECOVER_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 30_000;

/**
 * How long a graceful stop is allowed to take.
 *
 * Under the 120-second `stop_grace_period` the compose file sets, so the drain finishes on
 * its own terms rather than being SIGKILLed halfway. A handler that cannot finish inside it
 * is killed by Docker and picked up by the next boot's heartbeat sweep 90 seconds later —
 * which is the "lose at most one chunk" guarantee, stated as a number.
 */
const DRAIN_TIMEOUT_MS = 100_000;

export const ENGINE_VERSION = '0.1.0';

async function main(): Promise<void> {
  const env = parseWorkerEnv(process.env);

  /**
   * Who this worker is, for the whole life of the process.
   *
   * The `bootId` is what distinguishes a restarted container from its predecessor on the same
   * host with the same pid — without it, a worker that came back could inherit a lease its
   * dead self was holding and the stolen-lease check would pass when it must fail.
   */
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  const runtime = await buildContext({
    engineVersion: ENGINE_VERSION,
    appName: 'thibi-worker',
    googleDefaults: { region: 'asia-southeast1', model: 'chirp_2' },
    concurrency: Math.max(2, Math.round(4 * env.concurrency)),
    // The one part of the context that really differs from the CLI's: progress goes into
    // `run_events` and out over NOTIFY, coalesced, instead of being printed to stderr.
    events: (logger, db) =>
      db ? new CoalescingEventSink(db, { logger }) : { emit: () => {} },
  });

  const logger: Logger = runtime.ctx.logger;
  if (!runtime.db) {
    throw new WorkerEnvError(
      'DATABASE_URL is not set, and a worker without a database has nothing to do.',
      'Start the dev stack with\n  docker compose -f infra/compose.dev.yml up -d',
    );
  }

  const doorbell = await PgBossDoorbell.create({
    connectionString: env.databaseUrlDirect!,
    max: Math.max(4, env.queues.length + 2),
    logger,
  });

  const ctx: EngineContext = { ...runtime.ctx, doorbell, workerId };
  const registry = createHandlerRegistry();

  const state: HealthState = { draining: false, ready: false };
  const health = await startHealthServer(env.healthPort, () => state, logger);

  logger.info(
    { workerId, queues: env.queues, concurrency: env.concurrency },
    'worker starting',
  );

  /**
   * Recover before subscribing, not after.
   *
   * Whatever the previous process was holding has to be reclaimed before this one starts
   * competing for it, or the first thirty seconds are spent racing a ghost.
   */
  const report = await recoverTick(ctx);
  logger.info({ ...report }, 'boot recovery complete');

  const timers = [
    setInterval(() => {
      void recoverTick(ctx).catch((err: unknown) => logger.error({ err }, 'recovery tick failed'));
    }, RECOVER_INTERVAL_MS),
    setInterval(() => {
      void reconcileAllLive(ctx).catch((err: unknown) =>
        logger.error({ err }, 'reconcile tick failed'),
      );
    }, RECONCILE_INTERVAL_MS),
  ];
  for (const t of timers) t.unref();

  for (const queue of env.queues) {
    await doorbell.work(queue, async (jobs) => {
      // Each step owns its own failure: `runStep` records it on the step and reconciles.
      // Letting one escape would fail the whole pg-boss batch, which is state we have
      // deliberately decided not to keep.
      await Promise.all(jobs.map((job) => runStep(ctx, registry, job)));
    });
    logger.info({ queue, ...SUBSCRIPTIONS[queue] }, 'subscribed');
  }

  state.ready = true;
  logger.info({ queues: env.queues.length }, 'worker ready');

  await drainOn(['SIGTERM', 'SIGINT'], async (signal) => {
    logger.info({ signal }, 'draining');
    // /readyz goes 503 immediately so nothing routes new work here, while /healthz stays 200:
    // a draining worker is not broken, and killing it now abandons the chunk it is finishing.
    state.draining = true;
    for (const t of timers) clearInterval(t);

    await doorbell.stop({ timeoutMs: DRAIN_TIMEOUT_MS });
    await new Promise<void>((resolve) => health.close(() => resolve()));
    await closeQuietly(runtime.close, logger);
    logger.info({}, 'graceful stop complete');
    process.exit(0);
  });
}

/** Register a one-shot drain on each signal, ignoring repeats so a second Ctrl-C is not fatal. */
async function drainOn(
  signals: NodeJS.Signals[],
  drain: (signal: NodeJS.Signals) => Promise<void>,
): Promise<void> {
  let draining = false;
  for (const signal of signals) {
    process.on(signal, () => {
      if (draining) return;
      draining = true;
      void drain(signal);
    });
  }
  // Hold the process open. Everything from here is signal- and queue-driven.
  await new Promise<never>(() => {});
}

async function closeQuietly(close: () => Promise<void>, logger: Logger): Promise<void> {
  try {
    await close();
  } catch (err) {
    logger.warn({ err }, 'error while closing the database pool');
  }
}

main().catch((err: unknown) => {
  // A misconfiguration is a sentence, not a stack trace. A trace over "WORKER_QUEUES names a
  // queue that does not exist" is how a good message gets scrolled past.
  if (err instanceof WorkerEnvError) {
    process.stderr.write(`${err.message}\n${err.hint}\n`);
  } else if (isUserFacing(err)) {
    process.stderr.write(`${err.message}\n${err.hint ? `${err.hint}\n` : ''}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
