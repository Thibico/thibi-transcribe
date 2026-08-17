import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { awaitBucket, declareBucket, penalise, takeTokens } from '../rate-bucket.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping rate-bucket tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

describe.skipIf(!reachable)('rate buckets', () => {
  let t: TestDb;
  let key = 0;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  /** A fresh key per test: buckets are global by design, so sharing one couples the tests. */
  const bucket = async (capacity: number, refillPerS: number): Promise<string> => {
    const k = `test:${key++}`;
    await declareBucket(t.db, k, { capacity, refillPerS });
    return k;
  };

  const balance = async (k: string): Promise<number> =>
    Number(
      (
        await t.db.$client.query<{ tokens: number }>(
          `select tokens from rate_buckets where key = $1`,
          [k],
        )
      ).rows[0]!.tokens,
    );

  /**
   * **An unconfigured provider is unthrottled, and that is the load-bearing default.**
   *
   * The other choice — no row means block — would make the throttle something you must
   * remember to configure before anything works at all, and the symptom of forgetting would be
   * a system that looks broken on first run rather than one that looks unthrottled.
   */
  it('does not throttle a provider nobody has configured', async () => {
    expect(await takeTokens(t.db, 'nobody:has-configured-this', 1)).toBe(0);
  });

  it('lets a caller straight through while there are tokens', async () => {
    const k = await bucket(10, 1);
    expect(await takeTokens(t.db, k, 1)).toBe(0);
    expect(await balance(k)).toBeCloseTo(9, 1);
  });

  /**
   * The design decision worth a test of its own: the debit is **unconditional** and the balance
   * is allowed to go negative.
   *
   * A conditional debit would refuse the caller, who would then poll — so every worker would
   * spin against a bucket refusing them all, and the unluckiest would starve. Taking the tokens
   * anyway and returning the deficit means concurrent takers queue *behind each other*, and the
   * waits come out fair and roughly FIFO.
   */
  it('goes negative rather than refusing, and quotes the deficit as a wait', async () => {
    /**
     * A near-zero refill rate, so the refill between statements is negligible.
     *
     * Written first with `refillPerS: 1` and an assertion that the wait fell between 1.5 s and
     * 3 s — which is a bet on how quickly the suite gets from one statement to the next. Under a
     * loaded run it lost. The wait is then asserted *against the balance the row actually holds*
     * rather than against a window, which is the same arithmetic with nothing timing-dependent
     * left in it.
     */
    const k = await bucket(2, 0.001);

    expect(await takeTokens(t.db, k, 2), 'the burst is free').toBe(0);
    const wait = await takeTokens(t.db, k, 3);

    const owed = await balance(k);
    expect(owed, 'the debit happened regardless').toBeLessThan(0);
    expect(wait).toBe(Math.ceil((-owed / 0.001) * 1000));
  });

  it('queues concurrent takers behind each other by deficit', async () => {
    // Same reasoning: at one token per second the refill between calls can reorder the waits,
    // so the rate is set low enough that only the deficit moves.
    const k = await bucket(1, 0.001);
    await takeTokens(t.db, k, 1);

    // Three callers arriving at once, each overdrawing further than the last.
    const waits = [
      await takeTokens(t.db, k, 1),
      await takeTokens(t.db, k, 1),
      await takeTokens(t.db, k, 1),
    ];

    expect(waits[0]!).toBeGreaterThan(0);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
  });

  /**
   * A bucket idle overnight must not bank a burst big enough to blow the quota in the first
   * second of the morning, which is what `LEAST(capacity, …)` is for.
   */
  it('refills over time but never above capacity', async () => {
    const k = await bucket(5, 1000);
    await takeTokens(t.db, k, 5);
    await t.db.$client.query(
      `update rate_buckets set updated_at = now() - interval '1 hour' where key = $1`,
      [k],
    );

    expect(await takeTokens(t.db, k, 1)).toBe(0);
    expect(await balance(k), 'an hour at 1000/s would be 3.6M without the cap').toBeCloseTo(4, 1);
  });

  /**
   * How one chunk's 429 slows its seven siblings **with no cross-process messaging**: they read
   * the deficit out of the row on their next `takeTokens`.
   */
  it('charges a rejection to everyone about to make the same call', async () => {
    const k = await bucket(10, 1);
    await penalise(t.db, k);

    expect(await balance(k), 'half the capacity, not a reset to zero').toBeCloseTo(5, 1);
    // Deliberately not `tokens = 0`: flattening the balance would let the next caller straight
    // through, which is the opposite of what a 429 means.
    await penalise(t.db, k);
    expect(await balance(k)).toBeLessThan(1);
  });

  /**
   * A misconfigured row must not be able to wedge every worker that touches it. A bucket that
   * cannot refill can never repay a deficit, so waiting on it is waiting forever.
   */
  it('treats a bucket that cannot refill as unthrottled rather than as an infinite sleep', async () => {
    const k = await bucket(1, 0);
    await takeTokens(t.db, k, 5);
    expect(await takeTokens(t.db, k, 1)).toBe(0);
  });

  it('re-declaring a bucket changes its shape without handing out a free burst', async () => {
    const k = await bucket(10, 1);
    await takeTokens(t.db, k, 8);
    const before = await balance(k);

    await declareBucket(t.db, k, { capacity: 20, refillPerS: 2 });

    const { rows } = await t.db.$client.query<{ capacity: number; refill_per_s: number; tokens: number }>(
      `select capacity, refill_per_s, tokens from rate_buckets where key = $1`,
      [k],
    );
    expect(Number(rows[0]!.capacity)).toBe(20);
    expect(Number(rows[0]!.refill_per_s)).toBe(2);
    // `tokens` is live state shared with every other worker. A boot that reset it would hand
    // every restarting container a full burst.
    expect(Number(rows[0]!.tokens)).toBeCloseTo(before, 1);
  });

  describe('awaitBucket', () => {
    const ctxWith = (sleeps: number[]): EngineContext =>
      ({
        db: t.db,
        clock: {
          now: () => new Date(),
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }) as unknown as EngineContext;

    /**
     * The deficit is deliberately several seconds deep rather than milliseconds.
     *
     * First written with `refillPerS: 100`, where one token repays in 10 ms — so under a loaded
     * full-suite run the bucket had refilled between the two statements, `takeTokens` returned 0,
     * and the assertion failed on a machine that was merely busy. A test whose outcome depends on
     * how fast the suite happens to be running is measuring the machine. Four tokens at one per
     * second needs four seconds of drift to erase, and stays far under `maxWaitMs`.
     */
    it('sleeps through a short wait', async () => {
      const k = await bucket(1, 1);
      const sleeps: number[] = [];
      await takeTokens(t.db, k, 5); // ~4 tokens overdrawn, so ~4 s of wait

      const outcome = await awaitBucket(ctxWith(sleeps), k, 1, { maxWaitMs: 30_000 });

      expect(outcome.kind).toBe('go');
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]!).toBeGreaterThan(0);
      expect(sleeps[0]!, 'and it slept rather than requeueing').toBeLessThanOrEqual(30_000);
    });

    /**
     * The branch this function exists for, and it is the same trade as `no_slot`: a worker
     * asleep on a bucket holds a lease and does nothing, so a long wait is cheaper to requeue
     * than to sleep through. The caller turns this into `{ state: 'no_slot' }`, which costs no
     * retry budget — being throttled is not a fault.
     */
    it('requeues rather than holding a worker through a long wait', async () => {
      const k = await bucket(1, 0.01); // a deficit of one takes 100 s to repay
      const sleeps: number[] = [];
      await takeTokens(t.db, k, 2);

      const outcome = await awaitBucket(ctxWith(sleeps), k, 1, { maxWaitMs: 30_000 });

      expect(outcome.kind).toBe('requeue');
      if (outcome.kind !== 'requeue') return;
      expect(outcome.retryAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(sleeps, 'it must not have slept').toHaveLength(0);
    });
  });
});
