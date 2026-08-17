import { sql } from 'drizzle-orm';
import type { Db } from '@thibi/db';
import type { EngineContext } from '../context.js';

/**
 * An outbound token bucket per provider, shared across every container.
 *
 * The problem it solves is one the per-queue `batchSize` cannot: **quotas are per project, and
 * `batchSize` is per process.** Ten containers each politely respecting
 * `maxConcurrentRequests: 8` is eighty concurrent requests against one Google project, and the
 * provider's answer to that is 429s that look like our bug. Layer 1 is which container
 * subscribes to what, layer 2 is `batchSize`, and this is the only layer that knows what every
 * *other* worker is doing — because the state is a row rather than a variable.
 *
 * ## The bucket goes negative, and that is the design
 *
 * The debit is unconditional. A taker that finds no tokens does not spin on a refusal and try
 * again; it takes its tokens anyway, drives the balance below zero, and is told how long to
 * wait for the deficit it just created. Concurrent takers therefore queue *behind each other*
 * rather than against the bucket, the row lock serialises them, and the waits come out fair and
 * roughly FIFO. A conditional debit would give the opposite: every worker polling a bucket that
 * refuses them all, and the unluckiest one starving.
 *
 * ## An unconfigured provider is unthrottled, deliberately
 *
 * No row means no wait. That is what keeps this from being a thing you must remember to
 * configure before anything works — the throttle is opt-in per provider, and a missing row is
 * "nobody has expressed an opinion about this provider's quota", not "block everything". The
 * cost of the other default is a system that appears broken on first run.
 */

/** Anything with `execute`: the pool, or a transaction handle. */
type Executor = Pick<Db, 'execute'>;

/**
 * Debit `n` tokens; return how many milliseconds the caller must wait before proceeding.
 *
 * Zero means go now. The refill is computed from `updated_at` inside the same statement, so
 * there is no separate tick to run and no drift between processes — the arithmetic is a
 * function of wall-clock time and the row, and any worker computes the same answer.
 *
 * `LEAST(capacity, …)` caps the refill so a bucket idle overnight does not bank a burst big
 * enough to blow the quota in the first second of the morning.
 */
export async function takeTokens(db: Executor, key: string, n = 1): Promise<number> {
  const { rows } = await db.execute<{ tokens: number; refill_per_s: number }>(sql`
    update rate_buckets set
      tokens = least(
                 capacity,
                 tokens + extract(epoch from (now() - updated_at)) * refill_per_s
               ) - ${n},
      updated_at = now()
    where key = ${key}
    returning tokens, refill_per_s
  `);

  const row = rows[0];
  if (!row) return 0; // Unconfigured provider: no opinion, no throttle.

  const tokens = Number(row.tokens);
  const refillPerS = Number(row.refill_per_s);
  if (tokens >= 0) return 0;

  // A bucket that cannot refill can never repay a deficit, so waiting on it is waiting forever.
  // Treat it as unthrottled rather than as an infinite sleep; a misconfigured row must not be
  // able to wedge every worker that touches it.
  if (!(refillPerS > 0)) return 0;

  return Math.ceil((-tokens / refillPerS) * 1000);
}

/**
 * Charge a provider's rejection to everyone about to talk to it.
 *
 * A 429 debits `capacity / 2`, which is how one chunk's rejection slows its seven siblings
 * **without any cross-process messaging**: they read the deficit out of the row on their next
 * `takeTokens`. Half the capacity rather than a fixed number so the penalty scales with how
 * bursty the bucket was configured to be.
 *
 * Deliberately not `tokens = 0`. Flattening the balance would let the next taker through
 * immediately, which is the opposite of what a 429 means, and would lose the deficit that
 * several concurrent rejections should accumulate.
 */
export async function penalise(db: Executor, key: string): Promise<void> {
  await db.execute(sql`
    update rate_buckets set
      tokens = least(
                 capacity,
                 tokens + extract(epoch from (now() - updated_at)) * refill_per_s
               ) - capacity / 2,
      updated_at = now()
    where key = ${key}
  `);
}

/**
 * Declare a bucket, or update its shape without disturbing its balance.
 *
 * `capacity` and `refill_per_s` are configuration; `tokens` is live state shared with every
 * other worker. Re-running this on boot must not hand out a free burst by resetting the
 * balance — which is why the upsert leaves `tokens` alone on conflict, and why a *new* bucket
 * starts full rather than empty: a fresh deployment should be able to work immediately.
 */
export async function declareBucket(
  db: Executor,
  key: string,
  spec: { capacity: number; refillPerS: number },
): Promise<void> {
  await db.execute(sql`
    insert into rate_buckets (key, capacity, refill_per_s, tokens)
    values (${key}, ${spec.capacity}, ${spec.refillPerS}, ${spec.capacity})
    on conflict (key) do update
      set capacity = excluded.capacity, refill_per_s = excluded.refill_per_s
      where rate_buckets.capacity is distinct from excluded.capacity
         or rate_buckets.refill_per_s is distinct from excluded.refill_per_s
  `);
}

export interface BucketWaitOptions {
  /**
   * Above this, do not sleep — tell the caller to requeue.
   *
   * A worker asleep on a bucket is a worker holding a slot and doing nothing, and the whole
   * point of `no_slot` is that contention should cost a queue position rather than a lease.
   * Thirty seconds is the operator-facing `MAX_BUCKET_WAIT_MS`.
   */
  maxWaitMs: number;
}

export type BucketOutcome =
  /** Proceed. `waitedMs` is how long was spent sleeping, for the log. */
  | { kind: 'go'; waitedMs: number }
  /** Too long to hold a worker for. The caller should return `no_slot` with this. */
  | { kind: 'requeue'; retryAfter: Date };

/**
 * Wait for a bucket, or say the wait is too long to hold a worker for.
 *
 * The branch is the interesting part and it is the same trade `no_slot` exists for: a short
 * wait is cheaper to sleep through than to re-queue, and a long one is cheaper to re-queue than
 * to hold a lease through. Callers turn `requeue` into `{ state: 'no_slot' }`, which costs no
 * retry budget — being throttled is not a fault, and spending an attempt on it is how a busy
 * hour marks half a run dead.
 */
export async function awaitBucket(
  ctx: EngineContext,
  key: string,
  n: number,
  options: BucketWaitOptions,
): Promise<BucketOutcome> {
  const waitMs = await takeTokens(ctx.db, key, n);
  if (waitMs <= 0) return { kind: 'go', waitedMs: 0 };

  if (waitMs > options.maxWaitMs) {
    return { kind: 'requeue', retryAfter: new Date(ctx.clock.now().getTime() + waitMs) };
  }

  ctx.logger?.info({ key, waitMs }, 'rate: waiting on the provider bucket');
  await ctx.clock.sleep(waitMs, ctx.signal);
  return { kind: 'go', waitedMs: waitMs };
}
