import { doublePrecision, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A token bucket per provider, shared across every worker container.
 *
 * It exists because provider quota is not per process. Google's is per *project*: ten
 * containers each politely respecting `maxConcurrentRequests: 8` is eighty concurrent
 * requests against one quota, and each of them discovers the limit independently by being
 * rejected. Holding the bucket in Postgres is what lets one chunk's 429 slow its seven
 * siblings down without any cross-process messaging.
 *
 * **Unconfigured means unthrottled.** A missing row is not an error and not a zero bucket —
 * `takeTokens` returns a zero wait — so adding a provider does not require adding a row
 * before anything works.
 */
export const rateBuckets = pgTable('rate_buckets', {
  /** `google:asia-southeast1` | `groq:openai/gpt-oss-20b` | `openai:whisper-1` */
  key: text('key').primaryKey(),

  /** Burst size. A 429 penalty-debits `capacity / 2`. */
  capacity: doublePrecision('capacity').notNull(),
  refillPerS: doublePrecision('refill_per_s').notNull(),

  /**
   * Allowed to go **negative**, and that is the design rather than a tolerated edge case.
   * The debit is unconditional, so concurrent takers queue behind each other by deficit
   * instead of spinning on a refusal: the row lock serialises them and the arithmetic makes
   * the resulting waits fair and roughly FIFO.
   */
  tokens: doublePrecision('tokens').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RateBucketRow = typeof rateBuckets.$inferSelect;
