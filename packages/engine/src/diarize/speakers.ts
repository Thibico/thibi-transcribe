/**
 * Reading and editing the speaker list — the human half of Phase 3.
 *
 * Everything else in this directory exists so that this file's `renameSpeaker` survives a
 * re-transcription. A name is the only part of a diarization a machine cannot produce, so
 * the operations here are deliberately conservative: nothing deletes a speaker, and a merge
 * is recorded as lineage rather than as a disappearance.
 */
import type { EngineContext } from '../context.js';

export interface SpeakerSummary {
  id: string;
  key: string;
  displayName: string | null;
  colorIdx: number;
  /** Set when a human merged this speaker into another. Kept, so the merge is reversible. */
  mergedInto: string | null;
  segments: number;
  words: number;
  /** Attributed speech, summed over segments of the run asked about. */
  speechMs: number;
  /** Share of attributed speech in that run, 0–1. */
  share: number;
}

/**
 * List a job's speakers with how much of a run they hold.
 *
 * Scoped to the job because `speakers` is, but counted against one run because "61% of the
 * talking" is a fact about a transcript. With no `runId`, counts cover every live segment
 * of the job — which is what `thibi speakers list <jobId>` wants when the run is not
 * interesting yet.
 */
export async function listSpeakers(
  ctx: EngineContext,
  jobId: string,
  runId?: string,
): Promise<SpeakerSummary[]> {
  const { rows } = await ctx.db.$client.query<{
    id: string;
    key: string;
    display_name: string | null;
    color_idx: number;
    is_merged_into: string | null;
    segments: string;
    words: string;
    speech_ms: string;
  }>(
    `select sp.id, sp.key, sp.display_name, sp.color_idx, sp.is_merged_into,
            count(distinct s.id)                       as segments,
            coalesce(sum(s.word_count), 0)             as words,
            coalesce(sum(s.end_ms - s.start_ms), 0)    as speech_ms
       from speakers sp
       left join (
         select seg.id, seg.speaker_id, seg.start_ms, seg.end_ms,
                (select count(*) from words w where w.segment_id = seg.id) as word_count
           from segments seg
           join runs r on r.id = seg.run_id
          where seg.superseded_at is null and r.job_id = $1
            and ($2::uuid is null or seg.run_id = $2::uuid)
       ) s on s.speaker_id = sp.id
      where sp.job_id = $1
      group by sp.id, sp.key, sp.display_name, sp.color_idx, sp.is_merged_into
      order by sp.key`,
    [jobId, runId ?? null],
  );

  const summaries = rows.map((r) => ({
    id: r.id,
    key: r.key,
    displayName: r.display_name,
    colorIdx: r.color_idx,
    mergedInto: r.is_merged_into,
    segments: Number(r.segments),
    words: Number(r.words),
    speechMs: Number(r.speech_ms),
    share: 0,
  }));
  const total = summaries.reduce((n, s) => n + s.speechMs, 0);
  if (total > 0) for (const s of summaries) s.share = s.speechMs / total;
  return summaries;
}

export class SpeakerNotFoundError extends Error {
  constructor(jobId: string, key: string) {
    super(`Job ${jobId} has no speaker ${key}.`);
    this.name = 'SpeakerNotFoundError';
  }
}

/**
 * Put a real name on a speaker.
 *
 * Keyed by the durable `speaker-NN`, never by the diarizer's `SPEAKER_00`: the latter is
 * meaningless across runs, which is the entire premise of `identity.ts`.
 */
export async function renameSpeaker(
  ctx: EngineContext,
  jobId: string,
  key: string,
  displayName: string | null,
): Promise<SpeakerSummary> {
  const { rows } = await ctx.db.$client.query<{ id: string }>(
    'update speakers set display_name = $3 where job_id = $1 and key = $2 returning id',
    [jobId, key, displayName],
  );
  if (rows.length === 0) throw new SpeakerNotFoundError(jobId, key);
  const all = await listSpeakers(ctx, jobId);
  return all.find((s) => s.key === key)!;
}

export interface MergeResult {
  from: string;
  into: string;
  segmentsMoved: number;
  wordsMoved: number;
  turnsMoved: number;
}

/**
 * Merge two speakers the diarizer split.
 *
 * The losing row is **kept** and marked `is_merged_into`, not deleted. Three reasons, and
 * only the first is obvious: the merge stays reversible; old `speaker_turns` rows still
 * resolve; and `persistDiarization` excludes merged-away rows from identity matching, so
 * the next diarization cannot resurrect the split a human just undid — it would otherwise
 * match the *same* acoustic cluster back onto the row whose attributed time it kept.
 */
export async function mergeSpeakers(
  ctx: EngineContext,
  jobId: string,
  fromKey: string,
  intoKey: string,
): Promise<MergeResult> {
  if (fromKey === intoKey) throw new Error('Refusing to merge a speaker into itself.');
  const client = await ctx.db.$client.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string; key: string }>(
      'select id, key from speakers where job_id = $1 and key = any($2::text[])',
      [jobId, [fromKey, intoKey]],
    );
    const from = rows.find((r) => r.key === fromKey);
    const into = rows.find((r) => r.key === intoKey);
    if (!from) throw new SpeakerNotFoundError(jobId, fromKey);
    if (!into) throw new SpeakerNotFoundError(jobId, intoKey);

    const segments = await client.query(
      'update segments set speaker_id = $2 where speaker_id = $1',
      [from.id, into.id],
    );
    const words = await client.query('update words set speaker_id = $2 where speaker_id = $1', [
      from.id,
      into.id,
    ]);
    // `raw_key` is untouched: the turn still records which label the diarizer emitted, which
    // is the only way to tell later whether a merge fixed a split or hid a real second voice.
    const turns = await client.query(
      'update speaker_turns set speaker_id = $2 where speaker_id = $1',
      [from.id, into.id],
    );
    await client.query('update speakers set is_merged_into = $2 where id = $1', [
      from.id,
      into.id,
    ]);
    await client.query('commit');

    return {
      from: fromKey,
      into: intoKey,
      segmentsMoved: segments.rowCount ?? 0,
      wordsMoved: words.rowCount ?? 0,
      turnsMoved: turns.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
