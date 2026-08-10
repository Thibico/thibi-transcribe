import type { Segment } from '@thibi/core';
import { copyWords, type WordRow } from '@thibi/db';
import type { EngineContext } from '../context.js';
import type { ChunkPlan } from '../audio/plan.js';
import type { RunPipeline } from '@thibi/db';

/**
 * Persistence, as stages rather than side effects scattered through the pipeline.
 *
 * Three entry points, because *when* each runs is part of the design:
 *
 *  - `createRun` before anything, so a crash leaves a row explaining what was attempted;
 *  - `persistChunks` from the planner's callback, **before any cutting or network call**,
 *    which is what lets Phase 9 resume a run rather than restart it;
 *  - `persistResult` at the end, in one transaction per run.
 *
 * Keeping these out of `transcribe.ts` is what makes `--no-db` a real configuration rather
 * than a flag threaded through every step.
 */

export interface CreateRunInput {
  sha256: string;
  storageKey: string;
  filename: string;
  mime?: string | null;
  bytes: number;
  durationMs: number | null;
  probeRaw: unknown;
  title: string;
  languageCode: string;
  providerId: string;
  model: string;
  mode: 'sync' | 'sync_chunked' | 'batch';
  projectId?: string | null;
}

export interface CreateRunResult {
  assetId: string;
  jobId: string;
  runId: string;
  /** True when this exact file was already uploaded: content addressing makes dedupe free. */
  assetExisted: boolean;
}

export async function createRun(
  ctx: EngineContext,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const client = await ctx.db.$client.connect();
  try {
    await client.query('begin');

    // Content-addressed dedupe. A re-upload of the same recording costs a lookup, not a
    // second copy of a 2 GB file.
    const existing = await client.query<{ id: string }>(
      'select id from media_assets where sha256 = $1',
      [input.sha256],
    );
    let assetId = existing.rows[0]?.id;
    const assetExisted = assetId !== undefined;

    if (!assetId) {
      const inserted = await client.query<{ id: string }>(
        `insert into media_assets
           (sha256, storage_key, filename, mime, bytes, duration_ms, source, probe_raw)
         values ($1,$2,$3,$4,$5,$6,'upload',$7)
         returning id`,
        [
          input.sha256,
          input.storageKey,
          input.filename,
          input.mime ?? null,
          input.bytes,
          input.durationMs,
          JSON.stringify(input.probeRaw ?? null),
        ],
      );
      assetId = inserted.rows[0]!.id;
    }

    const job = await client.query<{ id: string }>(
      `insert into jobs (project_id, asset_id, title, language_code, status)
       values ($1,$2,$3,$4,'running') returning id`,
      [input.projectId ?? null, assetId, input.title, input.languageCode],
    );
    const jobId = job.rows[0]!.id;

    const run = await client.query<{ id: string }>(
      `insert into runs
         (job_id, provider_id, model, language_code, mode, state, engine_version, started_at)
       values ($1,$2,$3,$4,$5,'running',$6, now()) returning id`,
      [jobId, input.providerId, input.model, input.languageCode, input.mode, ctx.engineVersion],
    );
    const runId = run.rows[0]!.id;

    await client.query('update jobs set primary_run_id = $1 where id = $2', [runId, jobId]);
    await client.query('commit');

    return { assetId, jobId, runId, assetExisted };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Write the chunk plan.
 *
 * Called before any cutting and before any network request, so a crash mid-run leaves a
 * complete record of what was meant to happen. `overlap_lead_ms` is stored per chunk
 * because the seam merge needs it to know where the duplicate region begins.
 */
export async function persistChunks(
  ctx: EngineContext,
  runId: string,
  plans: readonly ChunkPlan[],
): Promise<void> {
  if (plans.length === 0) return;
  const client = await ctx.db.$client.connect();
  try {
    const values: unknown[] = [];
    const tuples = plans.map((p, i) => {
      const base = i * 6;
      values.push(runId, p.idx, p.offsetMs, p.contentStartMs, p.endMs, p.overlapLeadMs);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
    });
    await client.query(
      `insert into run_chunks (run_id, idx, offset_ms, content_start_ms, end_ms, overlap_lead_ms)
       values ${tuples.join(',')}
       on conflict (run_id, idx) do nothing`,
      values,
    );
  } finally {
    client.release();
  }
}

export interface PersistResultInput {
  runId: string;
  jobId: string;
  segments: readonly Segment[];
  wordTimingQuality: 'full' | 'partial' | 'none';
  pipeline: RunPipeline;
  costUsd: number;
  partial: boolean;
  failedChunks: ReadonlySet<number>;
}

export interface PersistResultOutput {
  segmentsInserted: number;
  wordsInserted: number;
}

/**
 * Write segments, words and the verbatim text layer, in one transaction.
 *
 * Words go in with `COPY … FROM STDIN`: a three-hour file is ~30,000 rows per run, and
 * individual inserts are far slower and hold the transaction open long enough to matter.
 */
export async function persistResult(
  ctx: EngineContext,
  input: PersistResultInput,
): Promise<PersistResultOutput> {
  const client = await ctx.db.$client.connect();
  try {
    await client.query('begin');

    // Map chunk index → chunk row id, so each segment points at the request it came from.
    const chunkRows = await client.query<{ id: string; idx: number }>(
      'select id, idx from run_chunks where run_id = $1',
      [input.runId],
    );
    const chunkIdByIdx = new Map(chunkRows.rows.map((r) => [r.idx, r.id]));

    const segmentIds: string[] = [];
    if (input.segments.length > 0) {
      const COLUMNS = 9;
      const values: unknown[] = [];
      const tuples = input.segments.map((s, i) => {
        values.push(
          input.runId,
          s.idx,
          s.startMs,
          s.endMs,
          s.text,
          s.textRaw,
          s.confidence,
          s.chunkIdx === null || s.chunkIdx === undefined
            ? null
            : (chunkIdByIdx.get(s.chunkIdx) ?? null),
          // Derived here rather than trusted from the caller: it must agree with the word
          // rows actually written, because every consumer branches on it.
          s.words.length > 0,
        );
        const base = i * COLUMNS;
        return `(${Array.from({ length: COLUMNS }, (_, c) => `$${base + c + 1}`).join(',')})`;
      });

      // `returning id` on a multi-row INSERT yields ids in the order the rows were
      // supplied, which is what lets words be attached by position below.
      const inserted = await client.query<{ id: string }>(
        `insert into segments
           (run_id, idx, start_ms, end_ms, text, text_raw, confidence, chunk_id, has_words)
         values ${tuples.join(',')}
         returning id`,
        values,
      );
      segmentIds.push(...inserted.rows.map((r) => r.id));
    }

    const wordRows: WordRow[] = [];
    input.segments.forEach((segment, i) => {
      const segmentId = segmentIds[i]!;
      for (const word of segment.words) {
        wordRows.push({
          segmentId,
          runId: input.runId,
          idx: word.idx,
          startMs: word.startMs,
          endMs: word.endMs,
          text: word.text,
          confidence: word.confidence,
        });
      }
    });
    await copyWords(client, wordRows);

    /**
     * One `(verbatim, '', origin='asr')` row per segment, duplicating `segments.text`.
     *
     * Redundant on purpose. `resolveLayer` then has one uniform path, and a human edit
     * *supersedes an existing row* rather than inventing the first one. The cost is about
     * 1 MB per audio-hour; the alternative puts a special case in the editor's hottest
     * read path.
     */
    if (input.segments.length > 0) {
      const values: unknown[] = [];
      const tuples = input.segments.map((s, i) => {
        const b = i * 3;
        values.push(segmentIds[i], input.runId, s.text);
        return `($${b + 1},$${b + 2},'verbatim','','asr',$${b + 3})`;
      });
      await client.query(
        `insert into segment_texts (segment_id, run_id, layer, target_lang, origin, text)
         values ${tuples.join(',')}`,
        values,
      );
    }

    for (const idx of input.failedChunks) {
      await client.query(
        `update run_chunks set status = 'failed' where run_id = $1 and idx = $2`,
        [input.runId, idx],
      );
    }
    await client.query(
      `update run_chunks set status = 'done' where run_id = $1 and status = 'pending'`,
      [input.runId],
    );

    // A run with one bad chunk is `partial`, not `failed`: a three-hour transcript missing
    // 55 seconds is still valuable.
    const state = input.partial ? 'partial' : 'done';
    await client.query(
      `update runs
          set state = $2, word_timing_quality = $3, pipeline = $4, cost_usd = $5,
              progress = 1, finished_at = now()
        where id = $1`,
      [
        input.runId,
        state,
        input.wordTimingQuality,
        JSON.stringify(input.pipeline),
        input.costUsd,
      ],
    );
    await client.query('update jobs set status = $2, updated_at = now() where id = $1', [
      input.jobId,
      state,
    ]);

    await client.query('commit');
    return { segmentsInserted: segmentIds.length, wordsInserted: wordRows.length };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
