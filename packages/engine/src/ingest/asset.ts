import { sql } from 'drizzle-orm';
import type { EngineContext } from '../context.js';

export interface NewAsset {
  id: string;
  sha256: string;
  storageKey: string;
  filename: string;
  mime: string | null;
  bytes: number;
  durationMs: number | null;
  source: 'upload' | 'url' | 'batch' | 'api';
  sourceMeta: unknown;
  probeRaw: unknown;
}

export interface StoredAsset {
  id: string;
  sha256: string;
  storageKey: string;
  filename: string;
  durationMs: number | null;
  bytes: number;
}

export interface CreateOrReuseResult {
  asset: StoredAsset;
  /** False when this sha256 already existed, i.e. the caller just uploaded a duplicate. */
  inserted: boolean;
}

/**
 * Insert an asset, or return the existing row with the same content hash.
 *
 * `media_assets.sha256` is UNIQUE, so re-uploading a recording costs a row lookup instead of
 * a second copy of a 2 GB file. The upload still happened — dedupe is content-addressing,
 * not upload avoidance — so the caller deletes the object it just wrote when `inserted` is
 * false. Clients that can hash first (the CLI always can) skip the transfer entirely.
 *
 * `DO UPDATE` rather than `DO NOTHING`, and the no-op assignment is deliberate: `DO NOTHING`
 * returns zero rows on conflict, and a follow-up SELECT in the same transaction cannot see a
 * concurrent inserter's uncommitted row, so two simultaneous uploads of one file would race
 * and one would get nothing back. `DO UPDATE` blocks on the row lock and always RETURNS.
 *
 * `xmax = 0` is how the insert path is told from the conflict path: on a fresh insert the
 * row has no update transaction, so xmax is zero. It is the only signal Postgres gives that
 * distinguishes them in a single statement.
 */
export async function createOrReuseAsset(
  ctx: EngineContext,
  a: NewAsset,
): Promise<CreateOrReuseResult> {
  const rows = await ctx.db.execute<{
    id: string;
    sha256: string;
    storage_key: string;
    filename: string;
    duration_ms: number | null;
    bytes: string | number;
    inserted: boolean;
  }>(sql`
    insert into media_assets
      (id, sha256, storage_key, filename, mime, bytes, duration_ms, source, source_meta, probe_raw)
    values (
      ${a.id}, ${a.sha256}, ${a.storageKey}, ${a.filename}, ${a.mime},
      ${a.bytes}, ${a.durationMs}, ${a.source},
      ${JSON.stringify(a.sourceMeta ?? {})}::jsonb,
      ${a.probeRaw === undefined ? null : JSON.stringify(a.probeRaw)}::jsonb
    )
    on conflict (sha256) do update
      -- A deliberate no-op that exists only to take the row lock and force a RETURNING row.
      set filename = media_assets.filename
    returning id, sha256, storage_key, filename, duration_ms, bytes, (xmax = 0) as inserted
  `);

  const row = rows.rows[0];
  if (!row) {
    // Unreachable: DO UPDATE always returns a row. Asserted rather than assumed, because a
    // silent undefined here would surface as a null asset id much further downstream.
    throw new Error('createOrReuseAsset: upsert returned no row');
  }

  return {
    asset: {
      id: row.id,
      sha256: row.sha256,
      storageKey: row.storage_key,
      filename: row.filename,
      durationMs: row.duration_ms,
      // bigint arrives as a string from pg; the column is bytes and callers do arithmetic.
      bytes: Number(row.bytes),
    },
    inserted: row.inserted,
  };
}

/** Content-address lookup, for clients that hash before uploading. */
export async function findAssetBySha(
  ctx: EngineContext,
  sha256: string,
): Promise<StoredAsset | null> {
  const rows = await ctx.db.execute<{
    id: string;
    sha256: string;
    storage_key: string;
    filename: string;
    duration_ms: number | null;
    bytes: string | number;
  }>(sql`
    select id, sha256, storage_key, filename, duration_ms, bytes
    from media_assets
    where sha256 = ${sha256} and deleted_at is null
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sha256: row.sha256,
    storageKey: row.storage_key,
    filename: row.filename,
    durationMs: row.duration_ms,
    bytes: Number(row.bytes),
  };
}
