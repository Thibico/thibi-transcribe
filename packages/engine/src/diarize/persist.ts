/**
 * The seam between the reconciler and the tables.
 *
 * `reconcile.ts` produces attributions keyed by the diarizer's own anonymous labels —
 * `SPEAKER_00` — and `identity.ts` decides which of those labels is a speaker the job
 * already knows about. This module is what turns both into rows: `diarization_runs`,
 * `speaker_turns`, `speakers`, and the `speaker_id` on every segment and every word.
 *
 * Three things here are load-bearing and none of them are visible from the types:
 *
 * - **`speakers` is scoped to the job.** A re-run reuses rows rather than minting a parallel
 *   set, and `matchSpeakers` is what decides which. A prior speaker nobody matched is
 *   **kept, never deleted** — this module never issues a `delete from speakers`.
 * - **`raw_key` is written beside `speaker_id`.** The diarizer's label is the evidence and
 *   the speaker id is the conclusion; storing only the conclusion makes a mis-mapping
 *   uninvestigable months later, when it is exactly the thing being disputed.
 * - **Words get a speaker too, not just segments** (Phase 3 §Risks, open question 6). That
 *   is ~40k rows for a three-hour file, so they go in by `COPY` into a temp table and one
 *   `update … from`, the same reasoning that made `copyWords` a COPY in Phase 1.
 *
 * Turns may overlap, including two from the same speaker. Nothing here assumes otherwise:
 * the fresh-speaker intervals handed to `matchSpeakers` are unioned by `intervalOverlapMs`,
 * and `speaker_turns` has no exclusion constraint.
 */
import { copyField, copyInto } from '@thibi/db';
import type { EngineContext } from '../context.js';
import type { FreshSpeaker, PriorSpeaker } from './identity.js';
import { matchSpeakers } from './identity.js';
import type { ReconcileOptions, ReconcileResult } from './reconcile.js';
import { DEFAULTS } from './reconcile.js';
import type { Turn } from './types.js';

export interface PersistDiarizationInput {
  runId: string;
  jobId: string;
  /** `pyannote` | `elevenlabs-scribe`. One source per run — mixing makes purity meaningless. */
  source: string;
  model: string;
  params?: Record<string, unknown>;
  /** The sidecar's task id, kept so a run can be traced back to the container's journal. */
  taskId?: string | null;
  turns: readonly Turn[];
  reconciled: ReconcileResult;
  audioDurationMs?: number | null;
  computeMs?: number | null;
  realtimeFactor?: number | null;
  costUsd?: number | null;
  options?: ReconcileOptions;
}

export interface PersistedSpeaker {
  id: string;
  /** Our durable label, `speaker-00`. */
  key: string;
  displayName: string | null;
  /** The diarizer's label(s) this run mapped onto that row. */
  rawKey: string;
  /** False ⇒ carried over from an earlier run of this job, name and all. */
  isNew: boolean;
}

export interface PersistDiarizationOutput {
  diarizationRunId: string;
  speakers: PersistedSpeaker[];
  /** Prior speakers this run found no match for. Kept, not deleted — see the module note. */
  unmatchedPriorKeys: string[];
  turnsInserted: number;
  segmentsUpdated: number;
  wordsUpdated: number;
}

/**
 * Collapse turns into one interval set per diarizer label.
 *
 * Pure and exported so the grouping can be tested without a database. Overlapping turns are
 * kept as-is rather than merged here: `intervalOverlapMs` unions each side before comparing,
 * so merging twice would only be an opportunity to disagree.
 */
export function freshSpeakersFromTurns(turns: readonly Turn[]): FreshSpeaker[] {
  const byKey = new Map<string, Array<[number, number]>>();
  for (const t of turns) {
    const arr = byKey.get(t.speakerKey);
    if (arr) arr.push([t.startMs, t.endMs]);
    else byKey.set(t.speakerKey, [[t.startMs, t.endMs]]);
  }
  return [...byKey.entries()]
    .map(([key, intervals]) => ({ key, intervals }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The numeric suffix of a `speaker-NN` key, or null for anything else. */
function keyIndex(key: string): number | null {
  const m = /^speaker-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Allocate durable keys for the diarizer labels no prior speaker claimed.
 *
 * Numbering continues past whatever the job already used rather than reusing gaps, so
 * `speaker-03` never means two different people across two runs of the same job — the name a
 * human typed is attached to the row, but the *key* is what appears in exports and in
 * `thibi speakers rename`.
 *
 * Ordering is by first speech, then by label, so the first person to talk is `speaker-00` on
 * a first run and the result is deterministic on a re-run.
 */
export function allocateSpeakerKeys(
  existingKeys: readonly string[],
  unmatched: readonly { key: string; firstMs: number }[],
): Map<string, string> {
  let next = -1;
  for (const k of existingKeys) {
    const i = keyIndex(k);
    if (i !== null && i > next) next = i;
  }
  const ordered = [...unmatched].sort(
    (a, b) => a.firstMs - b.firstMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const out = new Map<string, string>();
  for (const u of ordered) {
    next += 1;
    out.set(u.key, `speaker-${String(next).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Twelve is what the editor's palette will hold (Phase 13). It is a display hint and
 * nothing reads it yet; it is written now because assigning it later means rewriting rows a
 * human has already been looking at.
 */
const PALETTE_SIZE = 12;

interface PriorRow {
  id: string;
  key: string;
  start_ms: number;
  end_ms: number;
}

export async function persistDiarization(
  ctx: EngineContext,
  input: PersistDiarizationInput,
): Promise<PersistDiarizationOutput> {
  const options = input.options ?? DEFAULTS;
  const fresh = freshSpeakersFromTurns(input.turns);
  const firstMs = new Map(fresh.map((f) => [f.key, Math.min(...f.intervals.map((i) => i[0]))]));

  const client = await ctx.db.$client.connect();
  try {
    await client.query('begin');

    /**
     * Prior speakers, with the time *currently attributed* to them.
     *
     * Not the previous diarization's raw turns — segments, from any earlier run of this job.
     * That is the whole point: a human who reassigned a segment by hand has changed the
     * evidence this match runs on, so their correction feeds forward into the next run
     * instead of being overwritten by it.
     *
     * Rows merged into another speaker are excluded: their time belongs to the merge target
     * (`thibi speakers merge` repoints it), and letting a merged-away row compete would
     * resurrect a split a human explicitly undid.
     */
    const prior = await client.query<PriorRow>(
      `select sp.id, sp.key, s.start_ms, s.end_ms
         from speakers sp
         join segments s on s.speaker_id = sp.id and s.superseded_at is null
        where sp.job_id = $1 and sp.is_merged_into is null and s.run_id <> $2`,
      [input.jobId, input.runId],
    );
    const priorByKey = new Map<string, PriorSpeaker & { intervals: Array<[number, number]> }>();
    for (const row of prior.rows) {
      const existing = priorByKey.get(row.key);
      if (existing) existing.intervals.push([row.start_ms, row.end_ms]);
      else
        priorByKey.set(row.key, {
          speakerId: row.id,
          key: row.key,
          intervals: [[row.start_ms, row.end_ms]],
        });
    }

    const mapping = matchSpeakers([...priorByKey.values()], fresh, options);

    // Every key the job has ever used, including merged-away rows, so a newly minted key
    // cannot collide with one on the unique `(job_id, key)` index.
    const allKeys = await client.query<{ key: string }>(
      'select key from speakers where job_id = $1',
      [input.jobId],
    );

    const unmatched = fresh
      .filter((f) => !mapping.has(f.key))
      .map((f) => ({ key: f.key, firstMs: firstMs.get(f.key) ?? 0 }));
    const newKeys = allocateSpeakerKeys(
      allKeys.rows.map((r) => r.key),
      unmatched,
    );

    const speakerIdByRawKey = new Map<string, string>(mapping);
    const persisted: PersistedSpeaker[] = [];

    for (const [rawKey, speakerId] of mapping) {
      const row = await client.query<{ key: string; display_name: string | null }>(
        'select key, display_name from speakers where id = $1',
        [speakerId],
      );
      persisted.push({
        id: speakerId,
        key: row.rows[0]!.key,
        displayName: row.rows[0]!.display_name,
        rawKey,
        isNew: false,
      });
    }

    for (const [rawKey, key] of newKeys) {
      const idx = keyIndex(key) ?? 0;
      const inserted = await client.query<{ id: string }>(
        `insert into speakers (job_id, key, color_idx) values ($1, $2, $3) returning id`,
        [input.jobId, key, idx % PALETTE_SIZE],
      );
      const id = inserted.rows[0]!.id;
      speakerIdByRawKey.set(rawKey, id);
      persisted.push({ id, key, displayName: null, rawKey, isNew: true });
    }
    persisted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const matchedIds = new Set(mapping.values());
    const unmatchedPriorKeys = [...priorByKey.values()]
      .filter((p) => !matchedIds.has(p.speakerId))
      .map((p) => p.key)
      .sort();

    const dr = await client.query<{ id: string }>(
      `insert into diarization_runs
         (run_id, job_id, source, model, params, state, task_id, speakers_found,
          audio_duration_ms, compute_ms, realtime_factor, cost_usd, finished_at)
       values ($1,$2,$3,$4,$5::jsonb,'succeeded',$6,$7,$8,$9,$10,$11, now())
       returning id`,
      [
        input.runId,
        input.jobId,
        input.source,
        input.model,
        JSON.stringify(input.params ?? {}),
        input.taskId ?? null,
        fresh.length,
        input.audioDurationMs ?? null,
        input.computeMs ?? null,
        input.realtimeFactor ?? null,
        input.costUsd ?? null,
      ],
    );
    const diarizationRunId = dr.rows[0]!.id;

    // Sorted by start so the table reads in timeline order without an ORDER BY on every
    // query; the index is `(diarization_run_id, start_ms)` for the same reason.
    const sortedTurns = [...input.turns].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const turnsInserted = await copyInto(
      client,
      'speaker_turns',
      ['diarization_run_id', 'speaker_id', 'raw_key', 'start_ms', 'end_ms'],
      sortedTurns,
      (t) =>
        [
          copyField(diarizationRunId),
          copyField(speakerIdByRawKey.get(t.speakerKey) ?? null),
          copyField(t.speakerKey),
          copyField(t.startMs),
          copyField(t.endMs),
        ].join('\t') + '\n',
    );

    /**
     * Segments and words go in through temp tables rather than one statement each.
     *
     * A three-hour file is ~2k segments and ~40k words. Forty thousand round trips inside a
     * transaction is minutes of latency for a write that takes under a second in bulk, and
     * it holds the row locks for all of it.
     */
    await client.query(
      `create temp table _diarize_segments
         (id uuid, speaker_id uuid, purity double precision, needs_review boolean)
       on commit drop`,
    );
    await copyInto(
      client,
      '_diarize_segments',
      ['id', 'speaker_id', 'purity', 'needs_review'],
      input.reconciled.segments,
      (s) =>
        [
          copyField(s.segmentId),
          copyField(s.speakerKey === null ? null : (speakerIdByRawKey.get(s.speakerKey) ?? null)),
          copyField(s.purity),
          copyField(s.needsReview),
        ].join('\t') + '\n',
    );
    const segmentsUpdated = await client.query(
      `update segments s
          set speaker_id = t.speaker_id,
              speaker_purity = t.purity,
              needs_speaker_review = t.needs_review
         from _diarize_segments t
        where s.id = t.id and s.run_id = $1`,
      [input.runId],
    );

    await client.query(
      'create temp table _diarize_words (id bigint, speaker_id uuid) on commit drop',
    );
    await copyInto(
      client,
      '_diarize_words',
      ['id', 'speaker_id'],
      input.reconciled.words,
      (w) =>
        [
          copyField(w.wordId),
          copyField(w.speakerKey === null ? null : (speakerIdByRawKey.get(w.speakerKey) ?? null)),
        ].join('\t') + '\n',
    );
    // `and w.run_id = $1` is not redundant with `w.id = t.id`: it is what stops a caller
    // passing another run's reconcile result from silently rewriting that run's attribution.
    const wordsUpdated = await client.query(
      `update words w
          set speaker_id = t.speaker_id
         from _diarize_words t
        where w.id = t.id and w.run_id = $1`,
      [input.runId],
    );

    await client.query('commit');

    return {
      diarizationRunId,
      speakers: persisted,
      unmatchedPriorKeys,
      turnsInserted,
      segmentsUpdated: segmentsUpdated.rowCount ?? 0,
      wordsUpdated: wordsUpdated.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a diarization attempt that did not produce turns.
 *
 * A failed diarization must still leave a row. `run_steps` does not exist until Phase 9, so
 * without this the only evidence that a user asked for speakers and did not get them is a
 * line on somebody's terminal.
 */
export async function persistDiarizationFailure(
  ctx: EngineContext,
  input: {
    runId: string;
    jobId: string;
    source: string;
    model: string;
    taskId?: string | null;
    state: 'failed' | 'cancelled';
    error: { code: string; message: string; retryable?: boolean };
    audioDurationMs?: number | null;
  },
): Promise<string> {
  const { rows } = await ctx.db.$client.query<{ id: string }>(
    `insert into diarization_runs
       (run_id, job_id, source, model, state, task_id, audio_duration_ms, error, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
     returning id`,
    [
      input.runId,
      input.jobId,
      input.source,
      input.model,
      input.state,
      input.taskId ?? null,
      input.audioDurationMs ?? null,
      JSON.stringify(input.error),
    ],
  );
  return rows[0]!.id;
}

/**
 * The rows the reconciler needs, read back from the run that produced them.
 *
 * Words come out in `(start_ms, segment idx, word idx)` order, but `reconcile()` sorts again
 * and must: database order is not guaranteed to be temporal across a merged chunk seam, and
 * the failure mode there is a wrong answer rather than an error.
 */
export async function loadReconcileInput(
  ctx: EngineContext,
  runId: string,
): Promise<{
  segments: Array<{ id: string; idx: number; startMs: number; endMs: number; hasWords: boolean }>;
  words: Array<{
    id: string;
    segmentId: string;
    idx: number;
    startMs: number;
    endMs: number;
    text: string;
  }>;
}> {
  const segs = await ctx.db.$client.query<{
    id: string;
    idx: number;
    start_ms: number;
    end_ms: number;
    has_words: boolean;
  }>(
    `select id, idx, start_ms, end_ms, has_words
       from segments where run_id = $1 and superseded_at is null order by idx`,
    [runId],
  );
  const ws = await ctx.db.$client.query<{
    id: string;
    segment_id: string;
    idx: number;
    start_ms: number;
    end_ms: number;
    text: string;
  }>(
    `select w.id, w.segment_id, w.idx, w.start_ms, w.end_ms, w.text
       from words w join segments s on s.id = w.segment_id
      where w.run_id = $1 and s.superseded_at is null
      order by w.start_ms, s.idx, w.idx`,
    [runId],
  );
  return {
    segments: segs.rows.map((r) => ({
      id: r.id,
      idx: r.idx,
      startMs: r.start_ms,
      endMs: r.end_ms,
      hasWords: r.has_words,
    })),
    // `id` is a bigint; pg returns it as a string and it stays one all the way to the COPY
    // above. Turning it into a JS number would be silently lossy past 2^53.
    words: ws.rows.map((r) => ({
      id: String(r.id),
      segmentId: r.segment_id,
      idx: r.idx,
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
    })),
  };
}
