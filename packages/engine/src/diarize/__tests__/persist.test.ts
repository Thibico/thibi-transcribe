/**
 * `persist.ts` against a real Postgres.
 *
 * The pure halves of this phase — reconcile, identity, hungarian — already have tests that
 * need no database. What is only checkable here is everything the *seam* claims: that a
 * re-run reuses speaker rows rather than minting parallel ones, that a name survives, that
 * an unmatched prior speaker is kept rather than deleted, that `raw_key` lands beside
 * `speaker_id`, and that word rows get a speaker and not just segments. None of those are
 * visible from the types, and every one of them fails silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, DEFAULT_TEST_DATABASE_URL, postgresReachable, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { reconcile, type RSegment, type RWord } from '../reconcile.js';
import type { Turn } from '../types.js';
import {
  allocateSpeakerKeys,
  freshSpeakersFromTurns,
  loadReconcileInput,
  persistDiarization,
  persistDiarizationFailure,
} from '../persist.js';
import { listSpeakers, mergeSpeakers, renameSpeaker } from '../speakers.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [db] Postgres not reachable at ${BASE_URL} — skipping diarization persistence tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

describe('the pure halves, which need no database', () => {
  it('groups turns into one interval set per label, keeping overlaps', () => {
    const fresh = freshSpeakersFromTurns([
      { startMs: 0, endMs: 1000, speakerKey: 'SPEAKER_01' },
      { startMs: 800, endMs: 1600, speakerKey: 'SPEAKER_00' },
      { startMs: 1500, endMs: 1900, speakerKey: 'SPEAKER_00' },
    ]);
    expect(fresh.map((f) => f.key)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(fresh[0]!.intervals).toEqual([
      [800, 1600],
      [1500, 1900],
    ]);
  });

  it('numbers new speakers past whatever the job already used', () => {
    // Gaps are not reused: `speaker-03` must never mean two different people across two
    // runs of one job, because a human reads the key in an export.
    const keys = allocateSpeakerKeys(
      ['speaker-00', 'speaker-03'],
      [
        { key: 'SPEAKER_09', firstMs: 5000 },
        { key: 'SPEAKER_02', firstMs: 100 },
      ],
    );
    expect([...keys.entries()]).toEqual([
      ['SPEAKER_02', 'speaker-04'],
      ['SPEAKER_09', 'speaker-05'],
    ]);
  });

  it('orders a first run by who speaks first', () => {
    const keys = allocateSpeakerKeys(
      [],
      [
        { key: 'SPEAKER_01', firstMs: 0 },
        { key: 'SPEAKER_00', firstMs: 4000 },
      ],
    );
    expect(keys.get('SPEAKER_01')).toBe('speaker-00');
    expect(keys.get('SPEAKER_00')).toBe('speaker-01');
  });

  it('ignores keys that are not ours when numbering', () => {
    expect(allocateSpeakerKeys(['imported-x'], [{ key: 'A', firstMs: 0 }]).get('A')).toBe(
      'speaker-00',
    );
  });
});

describe.skipIf(!reachable)('persistDiarization', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let jobId: string;

  /** Alternating 5 s turns, two speakers, words wholly inside them. */
  const turnsFor = (keyA: string, keyB: string): Turn[] => [
    { startMs: 0, endMs: 5000, speakerKey: keyA },
    { startMs: 5000, endMs: 10_000, speakerKey: keyB },
    { startMs: 10_000, endMs: 15_000, speakerKey: keyA },
  ];

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = { db: t.db } as unknown as EngineContext;

    const asset = await t.db.$client.query<{ id: string }>(
      `insert into media_assets (sha256, storage_key, filename, bytes, duration_ms)
       values ($1, 'assets/aa/x/source.wav', 'interview.wav', 1, 15000) returning id`,
      ['c'.repeat(64)],
    );
    const job = await t.db.$client.query<{ id: string }>(
      `insert into jobs (asset_id, title, language_code) values ($1, 'interview', 'my-MM')
       returning id`,
      [asset.rows[0]!.id],
    );
    jobId = job.rows[0]!.id;
  }, 60_000);

  // 60 s, matching the `beforeAll` above. `drop database … with (force)` is slow when the
  // machine is busy and is not the thing under test. It must be set HERE rather than in
  // vitest.config.ts: root-level `test.hookTimeout` is silently ignored when `test.projects`
  // is used — verified 2026-08-11 by setting it to 1 ms and watching every suite still pass.
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  /** A run with three segments of four words each, on the same 15 s timeline as the turns. */
  async function makeRun(): Promise<{
    runId: string;
    segments: RSegment[];
    words: RWord[];
  }> {
    const run = await t.db.$client.query<{ id: string }>(
      `insert into runs (job_id, provider_id, model, language_code, mode, state, engine_version)
       values ($1, 'google', 'chirp_2', 'my-MM', 'sync_chunked', 'done', '0.1.0') returning id`,
      [jobId],
    );
    const runId = run.rows[0]!.id;

    const segments: RSegment[] = [];
    const words: RWord[] = [];
    for (let i = 0; i < 3; i++) {
      const startMs = i * 5000;
      const seg = await t.db.$client.query<{ id: string }>(
        `insert into segments (run_id, idx, start_ms, end_ms, text, text_raw, has_words)
         values ($1,$2,$3,$4,'x','x',true) returning id`,
        [runId, i, startMs, startMs + 5000],
      );
      const segmentId = seg.rows[0]!.id;
      segments.push({ id: segmentId, idx: i, startMs, endMs: startMs + 5000, hasWords: true });
      for (let j = 0; j < 4; j++) {
        const ws = startMs + j * 1000 + 100;
        const w = await t.db.$client.query<{ id: string }>(
          `insert into words (segment_id, run_id, idx, start_ms, end_ms, text)
           values ($1,$2,$3,$4,$5,'w') returning id`,
          [segmentId, runId, j, ws, ws + 400],
        );
        words.push({
          id: String(w.rows[0]!.id),
          segmentId,
          idx: j,
          startMs: ws,
          endMs: ws + 400,
          text: 'w',
        });
      }
    }
    return { runId, segments, words };
  }

  it('mints speakers, writes turns with raw_key, and attributes both segments and words', async () => {
    const { runId, segments, words } = await makeRun();
    const turns = turnsFor('SPEAKER_00', 'SPEAKER_01');
    const reconciled = reconcile(segments, words, turns);

    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'pyannote/speaker-diarization-3.1',
      taskId: 'task-1',
      turns,
      reconciled,
      audioDurationMs: 15_000,
      computeMs: 9000,
      realtimeFactor: 0.6,
    });

    expect(out.speakers.map((s) => s.key)).toEqual(['speaker-00', 'speaker-01']);
    expect(out.speakers.every((s) => s.isNew)).toBe(true);
    expect(out.turnsInserted).toBe(3);
    expect(out.segmentsUpdated).toBe(3);
    // Open question 6, answered "write both": every word row, not just the segment.
    expect(out.wordsUpdated).toBe(12);

    const dr = await t.db.$client.query<{
      speakers_found: number;
      realtime_factor: number;
      task_id: string;
      state: string;
    }>('select speakers_found, realtime_factor, task_id, state from diarization_runs where id = $1', [
      out.diarizationRunId,
    ]);
    expect(dr.rows[0]).toMatchObject({ speakers_found: 2, task_id: 'task-1', state: 'succeeded' });

    const kept = await t.db.$client.query<{ raw_key: string; speaker_id: string | null }>(
      'select raw_key, speaker_id from speaker_turns where diarization_run_id = $1 order by start_ms',
      [out.diarizationRunId],
    );
    expect(kept.rows.map((r) => r.raw_key)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    expect(kept.rows.every((r) => r.speaker_id !== null)).toBe(true);

    const attributed = await t.db.$client.query<{ n: string }>(
      'select count(*) as n from words where run_id = $1 and speaker_id is not null',
      [runId],
    );
    expect(Number(attributed.rows[0]!.n)).toBe(12);

    const segs = await t.db.$client.query<{
      speaker_purity: number;
      needs_speaker_review: boolean;
    }>('select speaker_purity, needs_speaker_review from segments where run_id = $1 order by idx', [
      runId,
    ]);
    expect(segs.rows.every((r) => r.speaker_purity === 1)).toBe(true);
    expect(segs.rows.every((r) => r.needs_speaker_review === false)).toBe(true);
  });

  it('carries a name across a re-diarization that permutes the labels', async () => {
    // The headline demo of the whole phase, minus the CLI: rename, re-transcribe, and the
    // name is still on the right person even though the diarizer renumbered them.
    await renameSpeaker(ctx, jobId, 'speaker-01', 'Daw Khin');

    const { runId, segments, words } = await makeRun();
    // Labels swapped, exactly as a second pyannote run would emit them.
    const turns = turnsFor('SPEAKER_01', 'SPEAKER_00');
    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'pyannote/speaker-diarization-3.1',
      turns,
      reconciled: reconcile(segments, words, turns),
    });

    expect(out.speakers).toHaveLength(2);
    expect(out.speakers.every((s) => !s.isNew), 'both rows must be reused, not re-minted').toBe(
      true,
    );
    const daw = out.speakers.find((s) => s.displayName === 'Daw Khin');
    expect(daw?.key).toBe('speaker-01');
    // She spoke the middle turn in run 1 and the first and third in run 2, so the label the
    // diarizer used for her flipped — which is the thing being carried across.
    expect(daw?.rawKey).toBe('SPEAKER_00');

    const total = await t.db.$client.query<{ n: string }>(
      'select count(*) as n from speakers where job_id = $1',
      [jobId],
    );
    expect(Number(total.rows[0]!.n), 'a re-run must not mint a parallel speaker set').toBe(2);
  });

  it('carries a name across a re-diarization of the SAME run', async () => {
    // The case the CLI actually produces, and the one the first version got wrong.
    // `thibi diarize run <runId>` re-diarizes in place; `thibi transcribe` mints a fresh
    // job every time, even for a byte-identical file. So this is the *only* path that
    // exercises identity matching in real use, and the test above — which builds a new run
    // each time — was green while the feature was broken through every door a user has.
    //
    // Found by running it end to end on 2026-08-12: "Daw Khin" survived on `speaker-01`
    // with 0 segments and 0 words while fresh `speaker-02` and `speaker-03` took all the
    // audio. A name orphaned in place is worse than one lost, because the speakers list
    // still shows it.
    await renameSpeaker(ctx, jobId, 'speaker-01', 'Daw Khin');

    const { runId, segments, words } = await makeRun();
    const first = turnsFor('SPEAKER_00', 'SPEAKER_01');
    await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'pyannote/speaker-diarization-3.1',
      turns: first,
      reconciled: reconcile(segments, words, first),
    });

    // Same run, diarized again, labels permuted the way a second pyannote pass emits them.
    const again = turnsFor('SPEAKER_01', 'SPEAKER_00');
    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'pyannote/speaker-diarization-3.1',
      turns: again,
      reconciled: reconcile(segments, words, again),
    });

    expect(out.speakers.every((s) => !s.isNew), 'no row may be re-minted').toBe(true);
    const total = await t.db.$client.query<{ n: string }>(
      'select count(*) as n from speakers where job_id = $1',
      [jobId],
    );
    expect(Number(total.rows[0]!.n), 'a re-diarization must not mint a parallel set').toBe(2);

    // And the name must still be carrying real audio, not sitting on an empty row.
    const attributed = await t.db.$client.query<{ n: string }>(
      `select count(*) as n from segments s
         join speakers sp on sp.id = s.speaker_id
        where sp.job_id = $1 and sp.display_name = 'Daw Khin'`,
      [jobId],
    );
    expect(Number(attributed.rows[0]!.n), '"Daw Khin" must still hold segments').toBeGreaterThan(0);
  });

  it('keeps an unmatched prior speaker rather than deleting it', async () => {
    const { runId, segments, words } = await makeRun();
    // One speaker this time. The other prior speaker matches nothing.
    const turns: Turn[] = [{ startMs: 0, endMs: 15_000, speakerKey: 'SPEAKER_00' }];
    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'm',
      turns,
      reconciled: reconcile(segments, words, turns),
    });

    expect(out.speakers).toHaveLength(1);
    expect(out.unmatchedPriorKeys.length).toBe(1);

    const rows = await t.db.$client.query<{ key: string; display_name: string | null }>(
      'select key, display_name from speakers where job_id = $1 order by key',
      [jobId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.key === 'speaker-01')?.display_name).toBe('Daw Khin');
  });

  it('mints a new speaker rather than hijacking a name when a stranger appears', async () => {
    const { runId, segments, words } = await makeRun();
    const turns: Turn[] = [
      { startMs: 0, endMs: 10_000, speakerKey: 'SPEAKER_00' },
      // 1.2 s, below the 2 s identity floor — coincidence, not identity.
      { startMs: 13_800, endMs: 15_000, speakerKey: 'SPEAKER_07' },
    ];
    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'm',
      turns,
      reconciled: reconcile(segments, words, turns),
    });
    const stranger = out.speakers.find((s) => s.rawKey === 'SPEAKER_07');
    expect(stranger?.isNew).toBe(true);
    expect(stranger?.displayName).toBeNull();
  });

  it('records a failed attempt, because a user who asked for speakers and got none needs a row', async () => {
    const { runId } = await makeRun();
    const id = await persistDiarizationFailure(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'pyannote/speaker-diarization-3.1',
      state: 'failed',
      error: { code: 'model_unavailable', message: 'the gate was not accepted', retryable: true },
    });
    const { rows } = await t.db.$client.query<{ state: string; error: { code: string } }>(
      'select state, error from diarization_runs where id = $1',
      [id],
    );
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.error.code).toBe('model_unavailable');
  });

  it('reads segments and words back in a shape the reconciler accepts', async () => {
    const { runId } = await makeRun();
    const loaded = await loadReconcileInput(ctx, runId);
    expect(loaded.segments).toHaveLength(3);
    expect(loaded.words).toHaveLength(12);
    // bigint ids stay strings the whole way. Turning them into JS numbers is lossy past
    // 2^53 and the loss would be silent.
    expect(typeof loaded.words[0]!.id).toBe('string');
  });

  it('merges two speakers into one without deleting either', async () => {
    const merged = await mergeSpeakers(ctx, jobId, 'speaker-02', 'speaker-00');
    expect(merged.into).toBe('speaker-00');

    const rows = await listSpeakers(ctx, jobId);
    const loser = rows.find((r) => r.key === 'speaker-02');
    expect(loser, 'the losing row is kept, so the merge is reversible').toBeDefined();
    expect(loser!.mergedInto).toBeTruthy();
    expect(loser!.segments).toBe(0);
  });

  it('does not let a merged-away speaker compete for identity again', async () => {
    // The reason merge is lineage rather than deletion: the next diarization would
    // otherwise match the same acoustic cluster back onto the row a human just retired.
    const { runId, segments, words } = await makeRun();
    const turns = turnsFor('SPEAKER_00', 'SPEAKER_01');
    const out = await persistDiarization(ctx, {
      runId,
      jobId,
      source: 'pyannote',
      model: 'm',
      turns,
      reconciled: reconcile(segments, words, turns),
    });
    expect(out.speakers.some((s) => s.key === 'speaker-02')).toBe(false);
  });
});
