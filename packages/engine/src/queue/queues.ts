/**
 * Queue names, kind→queue routing, and the one interface pg-boss hides behind.
 *
 * Nothing in this file imports pg-boss. That is the point: `reconcile.ts` and the planner
 * depend on `Doorbell`, and the pg-boss adapter is the only implementation. The overview's
 * cut list contemplates replacing pg-boss with ~150 lines of `FOR UPDATE SKIP LOCKED`, and
 * this interface is what makes that a two-day job rather than a rewrite. It costs ten lines
 * and it is cheaper to define now than to retrofit.
 */

/**
 * Every kind of node that can appear in a run's DAG.
 *
 * `maintenance.*` is deliberately absent. Maintenance work is runless — pg-boss cron, no
 * `run_id`, no dependencies, nothing to reconcile — so modelling it as a `run_steps` row
 * would mean a step belonging to no run, and every query in this module would grow a
 * `WHERE run_id IS NOT NULL`. It has a queue but no kind.
 */
export const STEP_KINDS = [
  'media.probe',
  'media.normalize',
  'media.peaks',
  'plan.chunks',
  'asr.chunk',
  'asr.batch.submit',
  'asr.poll',
  'asr.fetch',
  'diarize',
  'diarize.poll',
  'reconcile.speakers',
  'normalize.text',
  'editorial.pass',
  'export',
  'staging.cleanup',
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export function isStepKind(value: string): value is StepKind {
  return (STEP_KINDS as readonly string[]).includes(value);
}

/**
 * The queues, and the containers that subscribe to them.
 *
 * The split between `worker` and `worker-heavy` is the load-bearing part. A 1 h 40 m
 * pyannote job on a one-hour interview must not be able to starve the sub-second `asr.poll`
 * that keeps a `batchRecognize` alive — putting polls on the heavy queue is precisely the
 * mistake that makes a batch run look hung.
 *
 * **`worker` is a real queue and not a synonym for the container.** The phase-9 plan's
 * step-kind table routes `normalize.text` and `reconcile.speakers` here, but its queue table,
 * its `SUBSCRIPTIONS` map and its default `WORKER_QUEUES` all omit it — so as written, every
 * run would plan two steps onto a queue no container subscribes to and they would sit `ready`
 * forever while the queue showed depth 0. That is the exact misconfiguration the plan warns
 * about under "oldest ready age", authored into the plan itself. It is listed here, in
 * `SUBSCRIPTIONS`, and in the worker's default queue set, and a test asserts all three agree.
 */
export const ALL_QUEUES = [
  /** ffmpeg and the chunk planner: CPU-bound and bounded. */
  'media',
  /** In-process CPU work with no external dependency — text normalization, reconciliation. */
  'worker',
  /** Network-bound; the real concurrency limit is the provider's, not ours. */
  'asr.cloud',
  /** faster-whisper. Same GPU and RAM as `diarize`, same contention. */
  'asr.local',
  /** Sub-second work only. Must never queue behind something that takes an hour. */
  'asr.poll',
  'diarize',
  'editorial',
  'export',
  /** Runless cron. */
  'maintenance',
] as const;

export type QueueName = (typeof ALL_QUEUES)[number];

export function isQueueName(value: string): value is QueueName {
  return (ALL_QUEUES as readonly string[]).includes(value);
}

/** Queues served by the default `worker` container. */
export const LIGHT_QUEUES: readonly QueueName[] = [
  'media',
  'worker',
  'asr.cloud',
  'asr.poll',
  'editorial',
  'export',
  'maintenance',
];

/** Queues served by `worker-heavy`: everything that contends for the GPU. */
export const HEAVY_QUEUES: readonly QueueName[] = ['diarize', 'asr.local'];

/**
 * Default queue per kind.
 *
 * `asr.chunk` is the one the planner overrides: it routes to `asr.local` when the pipeline
 * says the provider runs on this box. Nothing else varies by pipeline.
 */
export const ROUTE: Record<StepKind, QueueName> = {
  'media.probe': 'media',
  'media.normalize': 'media',
  'media.peaks': 'media',
  'plan.chunks': 'media',
  'staging.cleanup': 'media',
  'asr.chunk': 'asr.cloud',
  'asr.batch.submit': 'asr.cloud',
  'asr.fetch': 'asr.cloud',
  'asr.poll': 'asr.poll',
  'diarize.poll': 'asr.poll',
  diarize: 'diarize',
  'reconcile.speakers': 'worker',
  'normalize.text': 'worker',
  'editorial.pass': 'editorial',
  export: 'export',
};

export function routeOf(kind: StepKind): QueueName {
  return ROUTE[kind];
}

/**
 * Progress weight per kind, in arbitrary units that only matter relative to each other.
 *
 * Progress is weighted rather than step-counted because that is what a user experiences: on
 * a chunked run the eight `asr.chunk` steps are almost the whole wait, and a bar that jumped
 * to 40% after `media.probe` and `media.normalize` — two of five steps — would be lying.
 *
 * `diarize.poll` is 0 on purpose: its weight is folded into `diarize`, because the pair is
 * one piece of work to anybody watching and counting the poll separately would make
 * diarization appear to finish twice.
 */
export const WEIGHT: Record<StepKind, number> = {
  'media.probe': 1,
  'media.normalize': 8,
  'media.peaks': 2,
  'plan.chunks': 1,
  'asr.chunk': 10,
  'asr.batch.submit': 5,
  'asr.poll': 40,
  'asr.fetch': 10,
  diarize: 40,
  'diarize.poll': 0,
  'reconcile.speakers': 4,
  'normalize.text': 3,
  'editorial.pass': 15,
  export: 2,
  'staging.cleanup': 1,
};

/**
 * Per-queue fetch settings, scaled by `WORKER_CONCURRENCY` and clamped for the ASR queues by
 * `provider.capabilities().limits.maxConcurrentRequests` — the engine already knows the
 * provider's cap and an operator should not have to rediscover it.
 *
 * This is only layer 2 of three. Layer 1 is which container subscribes to what; layer 3 is
 * the advisory-lock slots, which exist because `batchSize` is per *process* and somebody will
 * eventually run `--scale worker-heavy=3` on a one-GPU box.
 */
export interface QueueSubscription {
  batchSize: number;
  pollingIntervalSeconds: number;
}

export const SUBSCRIPTIONS: Record<QueueName, QueueSubscription> = {
  media: { batchSize: 2, pollingIntervalSeconds: 1 },
  worker: { batchSize: 2, pollingIntervalSeconds: 1 },
  'asr.cloud': { batchSize: 8, pollingIntervalSeconds: 1 },
  'asr.poll': { batchSize: 4, pollingIntervalSeconds: 2 },
  editorial: { batchSize: 4, pollingIntervalSeconds: 2 },
  export: { batchSize: 2, pollingIntervalSeconds: 2 },
  maintenance: { batchSize: 1, pollingIntervalSeconds: 30 },
  diarize: { batchSize: 1, pollingIntervalSeconds: 5 },
  'asr.local': { batchSize: 1, pollingIntervalSeconds: 5 },
};

/** The payload a doorbell carries. Deliberately tiny: it is a pointer, not the work. */
export interface StepJob {
  stepId: string;
  runId: string;
  kind: StepKind;
  /**
   * The attempt this send was rung for. `runStep` claims with `AND attempt = $n`, so a
   * doorbell that arrives after the step has already moved on is a no-op rather than a
   * second execution.
   */
  attempt: number;
}

export interface PendingSend {
  queue: QueueName;
  /**
   * `${stepId}:${attempt}` — **fresh per attempt**, which is the whole subtlety. A key of
   * just `stepId` would dedupe a retry against its own earlier send and the step would never
   * run again. A key that varied per call would stop deduping the self-healing re-send that
   * covers the crash-between-commit-and-send window.
   */
  singletonKey: string;
  data: StepJob;
  startAfter?: Date;
}

/**
 * The doorbell. It rings; it holds nothing.
 *
 * Implementations must pin `retryLimit: 0` on every send. Two retry mechanisms racing is how
 * a step runs six times while the UI says three, and our retry policy is the one an admin can
 * see on `/admin/queue`.
 */
export interface Doorbell {
  sendStep(send: PendingSend): Promise<void>;
}
