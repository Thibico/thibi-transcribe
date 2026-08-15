import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  postgresReachable,
  DEFAULT_TEST_DATABASE_URL,
  type TestDb,
} from '../testing.js';
import {
  diarizationRuns,
  jobs,
  mediaAssets,
  runs,
  segments,
  speakers,
  speakerTurns,
  words,
} from '../schema/index.js';

/**
 * The speaker tables against a real Postgres.
 *
 * Every assertion here guards a decision that would fail *silently* rather than loudly:
 * speakers scoped to the job rather than the run, a deleted speaker orphaning the
 * attribution rather than the transcript, and turns being allowed to overlap. None of
 * those are visible from the TypeScript types.
 */

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [db] Postgres not reachable at ${BASE_URL} — skipping speaker constraint tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

describe.skipIf(!reachable)('speaker schema', () => {
  let t: TestDb;
  let jobId: string;
  let runId: string;
  let secondRunId: string;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    const [asset] = await t.db
      .insert(mediaAssets)
      .values({
        sha256: 'b'.repeat(64),
        storageKey: 'assets/bb/y/source.m4a',
        filename: 'interview.m4a',
        bytes: 1,
      })
      .returning();
    const [job] = await t.db
      .insert(jobs)
      .values({ assetId: asset!.id, title: 'interview', languageCode: 'my-MM' })
      .returning();
    jobId = job!.id;

    const makeRun = async (): Promise<string> => {
      const [run] = await t.db
        .insert(runs)
        .values({
          jobId,
          providerId: 'google',
          model: 'chirp_2',
          languageCode: 'my-MM',
          mode: 'sync_chunked',
          engineVersion: '0.1.0',
        })
        .returning();
      return run!.id;
    };
    runId = await makeRun();
    secondRunId = await makeRun();
  }, 60_000);

  // 60 s, matching the `beforeAll` above. `drop database … with (force)` is slow when the
  // machine is busy and is not the thing under test. It must be set HERE rather than in
  // vitest.config.ts: root-level `test.hookTimeout` is silently ignored when `test.projects`
  // is used — verified 2026-08-11 by setting it to 1 ms and watching every suite still pass.
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it('scopes a speaker key to the job, not the run', async () => {
    // The decision the whole feature rests on. A re-transcription is a new `runs` row, and
    // "Speaker 01 is Daw Khin" has to survive it.
    const [named] = await t.db
      .insert(speakers)
      .values({ jobId, key: 'speaker-00', displayName: 'Daw Khin' })
      .returning();

    let raised: unknown;
    try {
      await t.db.insert(speakers).values({ jobId, key: 'speaker-00' });
    } catch (err) {
      raised = err;
    }
    const cause = (raised as { cause?: { code?: string; constraint?: string } })?.cause ?? raised;
    expect(cause).toMatchObject({ code: '23505', constraint: 'speakers_job_key' });

    // A second run of the same job reuses the row rather than minting a parallel one.
    await t.db
      .insert(diarizationRuns)
      .values({
        runId: secondRunId,
        jobId,
        source: 'pyannote',
        model: 'pyannote/speaker-diarization-3.1',
        state: 'succeeded',
      });
    const rows = await t.db.select().from(speakers).where(eq(speakers.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Daw Khin');
    expect(named!.id).toBe(rows[0]!.id);
  });

  it('orphans the attribution, never the transcript, when a speaker is deleted', async () => {
    const [speaker] = await t.db
      .insert(speakers)
      .values({ jobId, key: 'speaker-delete-me' })
      .returning();
    const [seg] = await t.db
      .insert(segments)
      .values({
        runId,
        idx: 500,
        startMs: 0,
        endMs: 1000,
        text: 'kept',
        textRaw: 'kept',
        hasWords: true,
        speakerId: speaker!.id,
        speakerPurity: 0.98,
      })
      .returning();
    await t.db.insert(words).values({
      segmentId: seg!.id,
      runId,
      idx: 0,
      startMs: 0,
      endMs: 900,
      text: 'kept',
      speakerId: speaker!.id,
    });

    await t.db.delete(speakers).where(eq(speakers.id, speaker!.id));

    const [afterSeg] = await t.db.select().from(segments).where(eq(segments.id, seg!.id));
    expect(afterSeg, 'the segment must survive').toBeDefined();
    expect(afterSeg!.text).toBe('kept');
    expect(afterSeg!.speakerId).toBeNull();
    const remainingWords = await t.db.select().from(words).where(eq(words.segmentId, seg!.id));
    expect(remainingWords).toHaveLength(1);
    expect(remainingWords[0]!.speakerId).toBeNull();
  });

  it('accepts overlapping turns, including two from the same speaker', async () => {
    // pyannote 3.1 emits overlapping speech. Anything that forbade this at the schema
    // level would reject a correct diarization.
    const [dr] = await t.db
      .insert(diarizationRuns)
      .values({
        runId,
        jobId,
        source: 'pyannote',
        model: 'pyannote/speaker-diarization-3.1',
        state: 'succeeded',
        speakersFound: 2,
        realtimeFactor: 0.58,
      })
      .returning();

    await expect(
      t.db.insert(speakerTurns).values([
        { diarizationRunId: dr!.id, rawKey: 'SPEAKER_00', startMs: 800, endMs: 1600 },
        { diarizationRunId: dr!.id, rawKey: 'SPEAKER_00', startMs: 1500, endMs: 1900 },
        { diarizationRunId: dr!.id, rawKey: 'SPEAKER_01', startMs: 1000, endMs: 1750 },
      ]),
    ).resolves.toBeDefined();
  });

  it('rejects an inverted turn interval', async () => {
    const [dr] = await t.db
      .insert(diarizationRuns)
      .values({ runId, jobId, source: 'pyannote', model: 'm', state: 'succeeded' })
      .returning();
    let raised: unknown;
    try {
      await t.db
        .insert(speakerTurns)
        .values({ diarizationRunId: dr!.id, rawKey: 'SPEAKER_00', startMs: 900, endMs: 100 });
    } catch (err) {
      raised = err;
    }
    const cause = (raised as { cause?: { code?: string; constraint?: string } })?.cause ?? raised;
    expect(cause).toMatchObject({ code: '23514', constraint: 'speaker_turns_interval' });
  });

  it('keeps a turn after its speaker mapping is removed, so a mis-mapping stays diagnosable', async () => {
    // `raw_key` is the reason this table is worth having: without it, "the transcript says
    // Daw Khin and she never said that" is uninvestigable, because the evidence would have
    // been overwritten by the conclusion.
    const [speaker] = await t.db.insert(speakers).values({ jobId, key: 'speaker-99' }).returning();
    const [dr] = await t.db
      .insert(diarizationRuns)
      .values({ runId, jobId, source: 'pyannote', model: 'm', state: 'succeeded' })
      .returning();
    const [turn] = await t.db
      .insert(speakerTurns)
      .values({
        diarizationRunId: dr!.id,
        speakerId: speaker!.id,
        rawKey: 'SPEAKER_07',
        startMs: 0,
        endMs: 4120,
      })
      .returning();

    await t.db.delete(speakers).where(eq(speakers.id, speaker!.id));

    const [after] = await t.db.select().from(speakerTurns).where(eq(speakerTurns.id, turn!.id));
    expect(after!.speakerId).toBeNull();
    expect(after!.rawKey).toBe('SPEAKER_07');
  });

  it('answers the review query from the partial index rather than a sequential scan', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      runId: secondRunId,
      idx: i,
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      text: 't',
      textRaw: 't',
      // The long-tail shape: a handful flagged among many. On a Chirp run with no words at
      // all it would be every row, which the index handles equally well.
      needsSpeakerReview: i % 250 === 0,
    }));
    await t.db.insert(segments).values(rows);
    await t.db.execute(sql`analyze segments`);

    const plan = await t.db.execute(
      sql`explain (format json) select id from segments
          where run_id = ${secondRunId}::uuid and needs_speaker_review order by idx`,
    );
    expect(JSON.stringify(plan)).toContain('segments_needs_speaker_review');

    const flagged = await t.db
      .select()
      .from(segments)
      .where(sql`${segments.runId} = ${secondRunId}::uuid and ${segments.needsSpeakerReview}`);
    expect(flagged).toHaveLength(8);
    // 30 s: this inserts 2,000 segment rows before it can plan anything, and the assertion
    // is about the query *plan*, not the clock. Set here for the same reason as the
    // teardown above — `test.testTimeout` in vitest.config.ts does not reach projects.
  }, 30_000);
});
