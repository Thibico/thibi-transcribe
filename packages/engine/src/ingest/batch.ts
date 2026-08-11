import { sql } from 'drizzle-orm';
import { resolveRate, unitForMode } from '@thibi/db';
import type { EngineContext } from '../context.js';
import { IngestError } from './errors.js';

export interface BatchDefaults {
  languageCode: string;
  providerId: string;
  model: string;
  /** Only affects the estimate here; the run decides for itself later. */
  mode?: 'sync' | 'sync_chunked' | 'batch';
}

export interface BatchItem {
  assetId: string;
  title?: string;
  /** Per-row overrides. One shared language with exceptions, never twenty pickers. */
  languageCode?: string;
  providerId?: string;
  model?: string;
}

export interface IngestBatchInput {
  /** Client-generated. The same key replayed creates nothing new. */
  batchKey: string;
  project: { id: string } | { name: string };
  defaults: BatchDefaults;
  items: BatchItem[];
  /** False returns the estimate and creates nothing — the dialog before the button. */
  confirm: boolean;
  userId?: string | null;
}

export interface BatchEstimateItem {
  assetId: string;
  filename: string;
  durationMs: number | null;
  usd: number | null;
  /** Why there is no price, when there is none. */
  unpricedReason?: 'unknown_duration' | 'no_rate';
}

export interface BatchEstimate {
  items: BatchEstimateItem[];
  totalDurationMs: number;
  totalUsd: number;
  rateSource: 'default' | 'override' | 'mixed' | 'none';
  /** Assets that could not be priced. Listed, never hidden inside the total. */
  unpriced: BatchEstimateItem[];
}

export interface IngestBatchResult {
  projectId: string | null;
  estimate: BatchEstimate;
  jobs: Array<{ id: string; assetId: string; title: string; created: boolean }>;
}

/**
 * Turn N already-uploaded assets into N jobs under one project, with one cost confirmation.
 *
 * Upload and job creation are deliberately two calls. Uploads are long, independent and
 * individually resumable; job creation is one short transaction. Fusing them would mean
 * re-uploading twenty files because the twentieth was a PDF.
 *
 * `confirm: false` is not a dry-run flag bolted on — it is the primary mode. The estimate is
 * the whole point of the command, and a batch that starts spending before showing a number is
 * the failure this shape exists to prevent.
 */
export async function ingestBatch(
  ctx: EngineContext,
  input: IngestBatchInput,
): Promise<IngestBatchResult> {
  if (input.items.length === 0) {
    throw new IngestError('empty_body', 'A batch needs at least one item.');
  }

  const assets = await loadAssets(
    ctx,
    input.items.map((i) => i.assetId),
  );
  for (const item of input.items) {
    if (!assets.has(item.assetId)) {
      throw new IngestError('unreadable_media', `No such asset: ${item.assetId}`);
    }
  }

  const estimate = await estimateBatch(ctx, input, assets);
  if (!input.confirm) return { projectId: null, estimate, jobs: [] };

  const projectId = await getOrCreateProject(ctx, input.project, input.defaults.languageCode);
  const jobs = await createJobs(ctx, input, projectId, assets);
  return { projectId, estimate, jobs };
}

/**
 * Price a batch, listing what it could not price.
 *
 * `resolveRate` returns null rather than zero when nothing matches, and that distinction is
 * preserved all the way to the caller: quoting $0.00 for a two-hour transcription is worse
 * than admitting ignorance, because somebody will believe it.
 */
export async function estimateBatch(
  ctx: EngineContext,
  input: IngestBatchInput,
  assets: Map<string, AssetRow>,
): Promise<BatchEstimate> {
  const unit = unitForMode(input.defaults.mode ?? 'sync_chunked');
  const sources = new Set<'default' | 'override'>();
  const items: BatchEstimateItem[] = [];

  for (const item of input.items) {
    const asset = assets.get(item.assetId);
    if (!asset) continue;
    const base: BatchEstimateItem = {
      assetId: item.assetId,
      // The caller's name for this item, not the asset's stored one. Content dedupe means two
      // uploads of the same recording share an asset row that keeps the *first* filename, so
      // showing `asset.filename` renders one name twice and the user cannot tell which of
      // their files each line is. Caught by ingesting a directory holding two copies of one
      // recording under different names, which listed the same filename on both rows.
      filename: item.title ?? asset.filename,
      durationMs: asset.durationMs,
      usd: null,
    };

    if (asset.durationMs === null) {
      items.push({ ...base, unpricedReason: 'unknown_duration' });
      continue;
    }
    const rate = await resolveRate(ctx.db, {
      providerId: item.providerId ?? input.defaults.providerId,
      model: item.model ?? input.defaults.model,
      unit,
    });
    if (!rate) {
      items.push({ ...base, unpricedReason: 'no_rate' });
      continue;
    }
    sources.add(rate.source);
    items.push({ ...base, usd: (asset.durationMs / 60_000) * rate.usdPerUnit });
  }

  const unpriced = items.filter((i) => i.usd === null);
  return {
    items,
    // Duration totals every item that has one, including the unpriced: "we do not know the
    // cost" and "we do not know the length" are different admissions.
    totalDurationMs: items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0),
    totalUsd: items.reduce((sum, i) => sum + (i.usd ?? 0), 0),
    rateSource:
      sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : [...sources][0]!,
    unpriced,
  };
}

export interface AssetRow {
  id: string;
  filename: string;
  durationMs: number | null;
}

async function loadAssets(ctx: EngineContext, ids: string[]): Promise<Map<string, AssetRow>> {
  const rows = await ctx.db.execute<{ id: string; filename: string; duration_ms: number | null }>(
    sql`select id, filename, duration_ms from media_assets
        where id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) and deleted_at is null`,
  );
  return new Map(
    rows.rows.map((r) => [r.id, { id: r.id, filename: r.filename, durationMs: r.duration_ms }]),
  );
}

async function getOrCreateProject(
  ctx: EngineContext,
  project: { id: string } | { name: string },
  defaultLanguageCode: string,
): Promise<string> {
  if ('id' in project) return project.id;

  // Slug is the identity, so "Election 2026" typed twice is one project rather than two that
  // differ by a space. ON CONFLICT DO UPDATE for the same reason as the asset upsert:
  // DO NOTHING returns no row and a concurrent creator's row is invisible until it commits.
  const slug = project.name
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  const rows = await ctx.db.execute<{ id: string }>(sql`
    insert into projects (name, slug, default_language_code)
    values (${project.name}, ${slug}, ${defaultLanguageCode})
    on conflict (slug) do update set name = projects.name
    returning id
  `);
  return rows.rows[0]!.id;
}

async function createJobs(
  ctx: EngineContext,
  input: IngestBatchInput,
  projectId: string,
  assets: Map<string, AssetRow>,
): Promise<IngestBatchResult['jobs']> {
  const out: IngestBatchResult['jobs'] = [];

  for (const item of input.items) {
    const asset = assets.get(item.assetId)!;
    // The uploaded filename, not the deduped asset's stored one: on a re-upload the asset row
    // keeps the first uploader's name, and the job title is where the name this user just
    // used has to live, or the list shows them a file they do not recognise.
    const title = item.title ?? asset.filename;

    const inserted = await ctx.db.execute<{ id: string }>(sql`
      insert into jobs (project_id, asset_id, title, language_code, status, source_batch_key, created_by)
      values (
        ${projectId}::uuid, ${item.assetId}::uuid, ${title},
        ${item.languageCode ?? input.defaults.languageCode}, 'pending',
        ${input.batchKey}, ${input.userId ?? null}::uuid
      )
      on conflict do nothing
      returning id
    `);

    const created = inserted.rows[0];
    if (created) {
      out.push({ id: created.id, assetId: item.assetId, title, created: true });
      continue;
    }

    // The partial unique index refused it, which means this exact batch already created this
    // job. A retry after a dropped connection must return the same jobs, not an error.
    const existing = await ctx.db.execute<{ id: string; title: string }>(sql`
      select id, title from jobs
      where project_id = ${projectId}::uuid
        and source_batch_key = ${input.batchKey}
        and asset_id = ${item.assetId}::uuid
    `);
    const row = existing.rows[0];
    if (!row) {
      throw new IngestError(
        'store_failed',
        `Job for asset ${item.assetId} was neither created nor found on replay.`,
      );
    }
    out.push({ id: row.id, assetId: item.assetId, title: row.title, created: false });
  }

  return out;
}
