import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { runs } from './runs.js';

/**
 * What things cost, and what they actually cost.
 *
 * Together these replace the old app's 420-line Cloud Billing catalog scraper. That scraper
 * fetched a price list at runtime, which meant an outage in a Google API nobody was
 * transcribing with could stop a transcript being costed. A configurable rate per
 * provider+model and a recorded ledger row do the same job, offline, and let an admin
 * correct a price the day Google changes it rather than the day we ship a release.
 *
 * These arrive in Phase 2 rather than Phase 14 because Phase 2's whole justification is a
 * price difference — `batchRecognize` is *slower* than chunked sync at every duration
 * (spike S3) and worth using only because it is 5.33x cheaper (spike S5). A cost argument
 * with no ledger behind it is a claim, and this project's rule is that claims get measured.
 */

/**
 * The price of one unit of provider work.
 *
 * `unit` is deliberately a free string rather than an enum: `minute` and `batch_minute` are
 * the same physical unit at different prices because they are different SKUs, and Phase 6's
 * `input_token` / `output_token` will join them. Encoding "which SKU" in the unit keeps the
 * lookup a single equality and avoids a nullable `sku` column that is meaningless for four
 * rows out of five.
 *
 * Seeded values carry `source='default'` and are replaced wholesale by re-seeding; a row an
 * admin has edited carries `source='override'` and is never touched again. That distinction
 * is the entire reason the column exists.
 */
export const rates = pgTable(
  'rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: text('provider_id').notNull(),
    /** `*` matches any model for this provider, so a new model still costs something. */
    model: text('model').notNull(),
    unit: text('unit').notNull(),
    usdPerUnit: doublePrecision('usd_per_unit').notNull(),

    source: text('source', { enum: ['default', 'override'] })
      .notNull()
      .default('default'),

    /**
     * Where the number came from, in prose. Not decoration: an operator who finds a cost
     * that looks wrong needs to know whether it was read from a billing catalog on a
     * particular day or typed in by a colleague.
     */
    note: text('note'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rates_key').on(t.providerId, t.model, t.unit),
    check('rates_non_negative', sql`${t.usdPerUnit} >= 0`),
  ],
);

/**
 * What a run actually consumed.
 *
 * Written *after* the work, from the provider's own reported usage — for batch, Google's
 * `totalBilledDuration` — so the pre-run estimate can be checked against reality rather than
 * believed. `usdPerUnit` is copied in rather than joined at read time: re-pricing history
 * when an admin corrects a rate would rewrite what a run cost last month, and a ledger that
 * changes retroactively is not a ledger.
 *
 * `step_id` is absent until Phase 9 creates `run_steps` to point at. The column is not
 * pre-created here — an unusable FK to a table that does not exist would fail to apply, and
 * Phase 9 adding one column is cheaper than the pretence.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),

    kind: text('kind', { enum: ['asr_minutes', 'llm_tokens'] }).notNull(),
    /** Minutes of audio, or tokens. Fractional: 120.05 minutes is a real answer. */
    quantity: doublePrecision('quantity').notNull(),
    /** The rate applied, frozen at the moment of writing. */
    usdPerUnit: doublePrecision('usd_per_unit').notNull(),
    usd: doublePrecision('usd').notNull(),

    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    unit: text('unit').notNull(),

    /**
     * What the provider said, unmodified — for batch, `{ totalBilledDuration: "7203s" }`.
     * Google reports duration and not price, so this is evidence for the quantity and never
     * for the money. Risk 8 in the Phase 2 plan: reconciling either against a real invoice
     * is still open.
     */
    reported: jsonb('reported').$type<Record<string, unknown> | null>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_records_run').on(t.runId),
    index('usage_records_created').on(t.createdAt),
    check('usage_records_non_negative', sql`${t.quantity} >= 0 and ${t.usd} >= 0`),
  ],
);
