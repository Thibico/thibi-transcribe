import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { rates } from '../schema/spend.js';

/**
 * The default rate table.
 *
 * **Read from the Cloud Billing Catalog on 2026-08-10, not from documentation and not from
 * memory.** `spikes/s5-rates.mjs` is the instrument; re-run it when Google changes prices and
 * update the `note` with the new date. Service `63DE-82AB-F564`, *Cloud Speech API*.
 *
 * The two Google rows are the entire economic argument for Phase 2 existing. Spike S3
 * measured `batchRecognize` at a flat 5.9x realtime against chunked parallel sync's 3.6-7x
 * advantage, which removes latency as a reason to use it; 0.016 against 0.003 is the reason
 * that remains.
 *
 * Two SKUs are deliberately **not** seeded. `Cloud Speech-to-Text Recognition (Logged)` at
 * $0.012 and `Cloud Speech-to-Text Dynamic Batch Recognition (Logged)` at $0.00225 are 25%
 * cheaper because they let Google retain the audio to improve its models. For a newsroom
 * transcribing confidential sources that is a disclosure and not a saving, so it can never
 * be a default, and no code sets the flag that would earn the discount. If it is ever
 * offered it is an explicit admin choice with that sentence printed beside it.
 *
 * The tiering is also not modelled. `Recognition` drops to $0.010/min above 500,000 minutes
 * a month — 8,300 hours — and `Dynamic Batch` is flat. Nothing this product serves is within
 * two orders of magnitude of that, and a tiered-rate model would be four tables of machinery
 * to make an estimate 0.0001 more accurate for a customer who does not exist. Recorded here
 * so the omission is a decision rather than an oversight.
 */
export interface RateSeed {
  providerId: string;
  model: string;
  unit: string;
  usdPerUnit: number;
  note: string;
}

const CATALOG = 'Cloud Billing Catalog, service 63DE-82AB-F564, read 2026-08-10';

export const DEFAULT_RATES: readonly RateSeed[] = [
  {
    providerId: 'google',
    model: 'chirp_2',
    unit: 'minute',
    usdPerUnit: 0.016,
    note: `Cloud Speech-to-Text Recognition. ${CATALOG}. Tiers to 0.010 above 500k min/month.`,
  },
  {
    providerId: 'google',
    model: 'chirp_2',
    unit: 'batch_minute',
    usdPerUnit: 0.003,
    note: `Cloud Speech-to-Text Dynamic Batch Recognition, flat. ${CATALOG}.`,
  },
  // The model wildcard, so a run on chirp_3 or long/short is costed rather than silently
  // free. Same SKU: Google prices Speech-to-Text v2 per minute of audio, not per model.
  {
    providerId: 'google',
    model: '*',
    unit: 'minute',
    usdPerUnit: 0.016,
    note: `Cloud Speech-to-Text Recognition, any v2 model. ${CATALOG}.`,
  },
  {
    providerId: 'google',
    model: '*',
    unit: 'batch_minute',
    usdPerUnit: 0.003,
    note: `Cloud Speech-to-Text Dynamic Batch Recognition, any v2 model. ${CATALOG}.`,
  },
];

export interface SeedResult {
  inserted: number;
  updated: number;
  /** Rows an admin has edited. Left exactly as they are. */
  skippedOverrides: number;
}

/**
 * Seed or refresh the default rates.
 *
 * Idempotent, and it **never touches a row whose `source` is `override`**. That is the whole
 * contract: re-seeding after a price change must correct our defaults without silently
 * reverting a correction an admin made on purpose — which is the failure that makes people
 * stop trusting a settings screen.
 */
export async function seedRates(db: Db, seeds: readonly RateSeed[] = DEFAULT_RATES): Promise<SeedResult> {
  const result: SeedResult = { inserted: 0, updated: 0, skippedOverrides: 0 };

  for (const seed of seeds) {
    const existing = await db
      .select({ id: rates.id, source: rates.source, usdPerUnit: rates.usdPerUnit })
      .from(rates)
      .where(
        and(
          eq(rates.providerId, seed.providerId),
          eq(rates.model, seed.model),
          eq(rates.unit, seed.unit),
        ),
      )
      .limit(1);

    const row = existing[0];
    if (row === undefined) {
      await db.insert(rates).values({ ...seed, source: 'default' });
      result.inserted++;
      continue;
    }
    if (row.source === 'override') {
      result.skippedOverrides++;
      continue;
    }
    if (row.usdPerUnit === seed.usdPerUnit) continue;

    await db
      .update(rates)
      .set({ usdPerUnit: seed.usdPerUnit, note: seed.note, updatedAt: new Date() })
      .where(eq(rates.id, row.id));
    result.updated++;
  }

  return result;
}

/**
 * The unit a run mode is billed in.
 *
 * `sync` and `sync_chunked` are the same SKU — chunking is our implementation detail and
 * Google bills the audio either way, which is exactly why chunked sync costs 5.33x more than
 * batch for identical audio.
 */
export function unitForMode(mode: 'sync' | 'sync_chunked' | 'batch'): 'minute' | 'batch_minute' {
  return mode === 'batch' ? 'batch_minute' : 'minute';
}

export interface ResolvedRate {
  usdPerUnit: number;
  source: 'default' | 'override';
  /** True when the `*` wildcard row was used because the exact model had none. */
  wildcard: boolean;
  note: string | null;
}

/**
 * Look up a rate, falling back from the exact model to the provider's `*` row.
 *
 * Returns null rather than zero when nothing matches. A missing rate must read as "we do not
 * know what this costs" — quoting $0.00 for a two-hour transcription is worse than admitting
 * ignorance, because someone will believe it.
 */
export async function resolveRate(
  db: Db,
  key: { providerId: string; model: string; unit: string },
): Promise<ResolvedRate | null> {
  for (const model of [key.model, '*']) {
    const rows = await db
      .select({
        usdPerUnit: rates.usdPerUnit,
        source: rates.source,
        note: rates.note,
      })
      .from(rates)
      .where(
        and(eq(rates.providerId, key.providerId), eq(rates.model, model), eq(rates.unit, key.unit)),
      )
      .limit(1);

    const row = rows[0];
    if (row) return { ...row, wildcard: model === '*' };
  }
  return null;
}
