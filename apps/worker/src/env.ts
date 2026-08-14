import { ALL_QUEUES, LIGHT_QUEUES, isQueueName, type QueueName } from '@thibi/engine';

/**
 * The worker's own environment, on top of what `@thibi/runtime` already reads.
 *
 * Exhaustive and reviewed, the same way the shared list is. Adding to it is a deliberate act.
 */
export interface WorkerEnv {
  queues: QueueName[];
  /** Multiplier over each queue's `batchSize`. */
  concurrency: number;
  healthPort: number;
  /** Global advisory-lock slots for `diarize`, held across every container. */
  gpuSlots: number;
  /** Global slots for `asr.local`. */
  localAsrSlots: number;
  /** Above this, a rate-bucket wait requeues rather than sleeping while holding a slot. */
  maxBucketWaitMs: number;
  /**
   * The listener connection, which **must bypass any pooler**.
   *
   * PgBouncer in transaction pooling mode hands the connection to another client between
   * statements, so `LISTEN` silently stops working: notifications are lost or delivered to
   * the wrong session, and the symptom is a progress bar that never moves rather than an
   * error anyone can search for. v1 Compose has no PgBouncer; this exists so the first person
   * to add one gets a startup failure instead.
   */
  databaseUrlDirect: string | undefined;
}

export class WorkerEnvError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'WorkerEnvError';
    this.hint = hint;
  }
}

function intOf(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new WorkerEnvError(
      `${name} must be a non-negative integer, but it is "${raw}".`,
      `Unset it to use the default of ${fallback}.`,
    );
  }
  return n;
}

/**
 * Parse and validate. **Fails loudly; never defaults silently.**
 *
 * The one that matters is `WORKER_QUEUES`. A typo there produces a worker that starts
 * cleanly, reports healthy, and does nothing at all — while the queue it was meant to serve
 * shows depth 0 and its steps sit `ready` forever. That is the hardest failure in this phase
 * to diagnose from the outside, so an unknown queue name is a startup error that lists the
 * ones that exist.
 */
export function parseWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  const raw = env['WORKER_QUEUES']?.trim();
  const queues = raw
    ? raw
        .split(',')
        .map((q) => q.trim())
        .filter((q) => q !== '')
    : [...LIGHT_QUEUES];

  const unknown = queues.filter((q) => !isQueueName(q));
  if (unknown.length > 0) {
    throw new WorkerEnvError(
      `WORKER_QUEUES names ${unknown.length === 1 ? 'a queue' : 'queues'} that ${
        unknown.length === 1 ? 'does' : 'do'
      } not exist: ${unknown.join(', ')}.`,
      `Known queues: ${ALL_QUEUES.join(', ')}.`,
    );
  }
  if (queues.length === 0) {
    throw new WorkerEnvError(
      'WORKER_QUEUES is set but empty, so this worker would subscribe to nothing.',
      `Unset it to serve the default set, or name some of: ${ALL_QUEUES.join(', ')}.`,
    );
  }

  const concurrency = Number(env['WORKER_CONCURRENCY'] ?? '1');
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new WorkerEnvError(
      `WORKER_CONCURRENCY must be a positive number, but it is "${env['WORKER_CONCURRENCY']}".`,
      'It is a multiplier over each queue\'s batch size. Unset it for 1.',
    );
  }

  return {
    queues: queues as QueueName[],
    concurrency,
    healthPort: intOf(env['WORKER_HEALTH_PORT'], 8081, 'WORKER_HEALTH_PORT'),
    gpuSlots: intOf(env['GPU_SLOTS'], 1, 'GPU_SLOTS'),
    localAsrSlots: intOf(env['LOCAL_ASR_SLOTS'], 1, 'LOCAL_ASR_SLOTS'),
    maxBucketWaitMs: intOf(env['MAX_BUCKET_WAIT_MS'], 30_000, 'MAX_BUCKET_WAIT_MS'),
    databaseUrlDirect: env['DATABASE_URL_DIRECT'] ?? env['DATABASE_URL'],
  };
}
