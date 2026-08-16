import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDb,
  postgresReachable,
  DEFAULT_TEST_DATABASE_URL,
  type RunStepRow,
  type TestDb,
} from '@thibi/db';
import { MemoryObjectStore, createTempDirPort } from '@thibi/storage';
import { createRegistry } from '@thibi/languages';
import {
  DiarizerBusyError,
  NORMALIZE,
  RECIPE_VERSION,
  createRun,
  diarizeStepKey,
  insertChunks,
  loadDiarizeHandle,
  materialisePlan,
  planRun,
  readDiarizationResult,
  startRun,
  systemClock,
  writeChunkResult,
  type ChunkResult,
  type DiarizationResult,
  type DiarizationSource,
  type DiarizeHandle,
  type DiarizeRequest,
  type DiarizeStatus,
  type EngineContext,
  type PipelineSpec,
} from '@thibi/engine';
import { createDiarize } from '../handlers/diarize.js';
import { createDiarizePoll } from '../handlers/diarize-poll.js';
import { reconcileSpeakers } from '../handlers/reconcile-speakers.js';
import { normalizeText } from '../handlers/normalize-text.js';
import type { HandlerDeps } from '../handlers/shared.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [worker] Postgres not reachable at ${BASE_URL} — skipping diarize handler tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const SPEC: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'sync_chunked', local: false, overlapMs: 0 },
  diarize: { providerId: 'pyannote', required: false },
  editorial: [],
  peaks: false,
  exports: [],
};

const CHUNKS = [{ idx: 0, offsetMs: 0, contentStartMs: 0, endMs: 20_000, overlapLeadMs: 0 }];

const NEVER = new AbortController().signal;

/**
 * Two speakers alternating cleanly, which is the case where attribution is unambiguous.
 *
 * Deliberately not a hard reconciliation case: what these tests are about is whether the three
 * steps hand the right things to each other across process boundaries. The reconciler's own
 * correctness has 22 tests of its own in `diarize/__tests__/reconcile.test.ts`, against
 * overlapping turns and words that straddle a boundary.
 */
const TURNS = [
  { startMs: 0, endMs: 5_000, speakerKey: 'SPEAKER_00' },
  { startMs: 5_000, endMs: 10_000, speakerKey: 'SPEAKER_01' },
];

interface FakeDiarizer {
  deps: HandlerDeps;
  source: DiarizationSource;
  submits: DiarizeRequest[];
  polls: number;
  fetches: number;
  cancels: number;
  /** Reassign between calls to drive the state machine. */
  status: DiarizeStatus;
  /** Throw this on the next submit, once. Models a 429 from a busy sidecar. */
  submitThrows: Error | null;
}

function fakeDiarizer(status: DiarizeStatus = { state: 'running', progress: 0.4 }): FakeDiarizer {
  const state = {
    submits: [] as DiarizeRequest[],
    polls: 0,
    fetches: 0,
    cancels: 0,
    status,
    submitThrows: null as Error | null,
  };

  const result: DiarizationResult = {
    turns: TURNS,
    numSpeakers: 2,
    model: 'pyannote/speaker-diarization-3.1',
    params: { minSpeakers: null },
    audioDurationMs: 20_000,
    computeMs: 1_800,
    realtimeFactor: 0.09,
    raw: { recorded: true },
  };

  const source: DiarizationSource = {
    id: 'pyannote',
    label: 'pyannote (fake)',
    capabilities: () => ({
      mode: 'async-task',
      needsAudioUrl: true,
      overlapAware: true,
      speakerCountHint: 'range',
      costModel: { unit: 'audio_minute', usdPerUnit: 0 },
    }),
    submit: async (_ctx, req): Promise<DiarizeHandle> => {
      if (state.submitThrows) {
        const err = state.submitThrows;
        state.submitThrows = null;
        throw err;
      }
      state.submits.push(req);
      return {
        sourceId: 'pyannote',
        // Derived from the request's idempotency key, as the real sidecar's uuid5 is: two
        // submits for the same run must name the same task, or the guarantee is not a
        // guarantee.
        taskId: `task-for-${req.stepId}`,
        submittedAtMs: Date.now(),
        meta: {},
      };
    },
    poll: async (): Promise<DiarizeStatus> => {
      state.polls++;
      return state.status;
    },
    fetch: async (): Promise<DiarizationResult> => {
      state.fetches++;
      return result;
    },
    cancel: async (): Promise<void> => {
      state.cancels++;
    },
  };

  return {
    ...state,
    get submits() {
      return state.submits;
    },
    get polls() {
      return state.polls;
    },
    get fetches() {
      return state.fetches;
    },
    get cancels() {
      return state.cancels;
    },
    get status() {
      return state.status;
    },
    set status(next: DiarizeStatus) {
      state.status = next;
    },
    set submitThrows(next: Error | null) {
      state.submitThrows = next;
    },
    source,
    deps: {
      providerFor: async () => {
        throw new Error('the diarize path must not build an ASR provider');
      },
      diarizerFor: () => source,
    },
  } as unknown as FakeDiarizer;
}

describe.skipIf(!reachable)('diarize handlers', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 500;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = {
      db: t.db,
      store: new MemoryObjectStore(),
      tmp: createTempDirPort(),
      languages: createRegistry(),
      clock: systemClock(),
      engineVersion: '0.1.0',
      concurrency: { asrChunks: 2, ffmpeg: 2 },
      events: { emit: () => {} },
      logger: {
        child: () => ctx.logger,
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    } as unknown as EngineContext;
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  /** A planned run with a normalized derivative, so `diarizeAudioForRun` finds its audio. */
  const plant = async (): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { jobId, assetId } = await createRun(ctx, {
      sha256: hex,
      storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.wav`,
      filename: 'interview.wav',
      bytes: 2_000_000,
      durationMs: 20_000,
      probeRaw: null,
      title: 'interview',
      languageCode: 'my-MM',
      providerId: 'google',
      model: 'chirp_2',
      mode: 'sync_chunked',
    });
    const { runId } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: SPEC,
    });

    const key = `derivatives/${assetId}/normalized.flac`;
    await ctx.store.put(key, Buffer.from('FLAC-ish'), { contentType: 'audio/flac' });
    await t.db.$client.query(
      `insert into media_derivatives (asset_id, kind, storage_key, recipe_version, bytes)
       values ($1, $2, $3, $4, 8)`,
      [assetId, NORMALIZE.kind, key, RECIPE_VERSION],
    );

    await insertChunks(t.db, runId, CHUNKS);
    await materialisePlan(t.db, runId, planRun(SPEC, CHUNKS.length));
    return runId;
  };

  const stepFor = async (runId: string, kind: string): Promise<RunStepRow> => {
    const { rows } = await t.db.$client.query<RunStepRow>(
      `select * from run_steps where run_id = $1 and kind = $2 and shard = -1`,
      [runId, kind],
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rows[0]!)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase())] = v;
    }
    return out as unknown as RunStepRow;
  };

  /** A transcript for the reconciler to attribute: two words, one per speaker's turn. */
  const transcribe = async (runId: string): Promise<void> => {
    const result: ChunkResult = {
      idx: 0,
      segments: [
        {
          startMs: 0,
          endMs: 4_000,
          text: 'မင်္ဂလာပါ',
          confidence: 0.9,
          words: [{ startMs: 1_000, endMs: 2_000, text: 'မင်္ဂလာပါ', confidence: 0.9 }],
        },
        {
          startMs: 6_000,
          endMs: 9_000,
          text: 'ကျေးဇူးတင်ပါတယ်',
          confidence: 0.9,
          words: [{ startMs: 6_500, endMs: 7_500, text: 'ကျေးဇူးတင်ပါတယ်', confidence: 0.9 }],
        },
      ],
      wordTimingQuality: 'full',
      usage: { audioMs: 20_000, requests: 1 },
      warnings: [],
      providerId: 'google',
      model: 'chirp_2',
      costUsd: 0.005,
    };
    await writeChunkResult(ctx, runId, result);
    await normalizeText(ctx, await stepFor(runId, 'normalize.text'), NEVER);
  };

  describe('diarize', () => {
    it('submits under the run-derived key and persists the handle before finishing', async () => {
      const runId = await plant();
      const fake = fakeDiarizer();

      const result = await createDiarize(fake.deps)(ctx, await stepFor(runId, 'diarize'), NEVER);

      expect(result.state, 'done, not awaiting_external — diarize.poll owns the wait').toBe('done');
      expect(fake.submits).toHaveLength(1);
      // The idempotency key has to be reconstructible by a process that never saw the response.
      expect(fake.submits[0]!.stepId).toBe(diarizeStepKey(runId));
      expect(fake.submits[0]!.audio.durationMs).toBe(20_000);

      const handle = await loadDiarizeHandle(ctx, runId);
      expect(handle?.taskId).toBe(`task-for-${diarizeStepKey(runId)}`);
    });

    /**
     * The same claim `asr.batch.submit` makes, against a resource that is scarce rather than
     * billed: one GPU. A worker that died between the sidecar accepting the task and the step
     * being marked done must not start a second job on the only card.
     */
    it('does not resubmit a task whose handle is already stored', async () => {
      const runId = await plant();
      const fake = fakeDiarizer();
      const handler = createDiarize(fake.deps);
      const step = await stepFor(runId, 'diarize');

      await handler(ctx, step, NEVER);
      const again = await handler(ctx, step, NEVER);

      expect(again).toMatchObject({ state: 'done', output: { reused: true } });
      expect(fake.submits, 'the second attempt must not reach the sidecar').toHaveLength(1);
    });

    /**
     * **A busy diarizer is scheduling, not failure**, and this is the assertion that says so.
     * `diarize` has two attempts. If a 429 spent one, two overlapping jobs would fail a run
     * with nothing whatever wrong with it.
     */
    it('treats a busy sidecar as no_slot, which costs no retry budget', async () => {
      const runId = await plant();
      const fake = fakeDiarizer();
      fake.submitThrows = new DiarizerBusyError(30);

      const result = await createDiarize(fake.deps)(ctx, await stepFor(runId, 'diarize'), NEVER);

      expect(result.state).toBe('no_slot');
      if (result.state !== 'no_slot') return;
      expect(result.retryAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
      expect(await loadDiarizeHandle(ctx, runId), 'nothing was submitted').toBeNull();
    });

    /**
     * No sidecar is a deployment choice, not a fault. All three kinds are `optional`, and a
     * `skipped` step satisfies its dependents — so the run finishes on its transcript alone.
     */
    it('skips when the box has no diarizer', async () => {
      const runId = await plant();
      const deps: HandlerDeps = {
        providerFor: async () => {
          throw new Error('unused');
        },
        diarizerFor: () => null,
      };

      const result = await createDiarize(deps)(ctx, await stepFor(runId, 'diarize'), NEVER);
      expect(result).toMatchObject({ state: 'skipped', output: { reason: 'no-diarizer' } });
    });
  });

  describe('diarize.poll', () => {
    const submitted = async (fake: FakeDiarizer): Promise<string> => {
      const runId = await plant();
      await createDiarize(fake.deps)(ctx, await stepFor(runId, 'diarize'), NEVER);
      return runId;
    };

    it('parks in awaiting_external and carries the sidecar’s progress', async () => {
      const fake = fakeDiarizer({ state: 'running', progress: 0.4 });
      const runId = await submitted(fake);

      const result = await createDiarizePoll(fake.deps)(
        ctx,
        await stepFor(runId, 'diarize.poll'),
        NEVER,
      );

      expect(result.state).toBe('awaiting_external');
      if (result.state !== 'awaiting_external') return;
      expect(result.externalRef).toContain('task-for-');
      expect(result.pollAfter!.getTime()).toBeGreaterThan(Date.now());
      expect(result.output).toMatchObject({ polls: 1, progress: 0.4, state: 'running' });
    });

    it('fetches the turns on success and parks them where the reconciler will look', async () => {
      const fake = fakeDiarizer({ state: 'succeeded' });
      const runId = await submitted(fake);

      const result = await createDiarizePoll(fake.deps)(
        ctx,
        await stepFor(runId, 'diarize.poll'),
        NEVER,
      );

      expect(result).toMatchObject({ state: 'done', output: { turns: 2, numSpeakers: 2 } });
      expect(fake.fetches).toBe(1);

      // Object storage, not `speaker_turns`: those rows are written by `persistDiarization` in
      // the same transaction that attributes segments, and a turn set without its attribution
      // is a half-finished diarization the editor would render as silent speakers.
      const stored = await readDiarizationResult(ctx, runId);
      expect(stored?.turns).toHaveLength(2);

      const { rows } = await t.db.$client.query<{ diarize: { latencyMs: number; polls: number } }>(
        `select pipeline->'diarize' as diarize from runs where id = $1`,
        [runId],
      );
      expect(rows[0]!.diarize).toMatchObject({ polls: 1, numSpeakers: 2 });
      expect(rows[0]!.diarize.latencyMs).toBeTypeOf('number');
    });

    /**
     * `lost` means the container ran this and was killed, so a resubmit costs the slot again.
     * Once, and then the run is told the sidecar is probably crash-looping — the alternative
     * is a task that evaporates forever while occupying the only GPU.
     */
    it('resubmits a lost task exactly once, then gives up', async () => {
      const fake = fakeDiarizer({ state: 'lost' });
      const runId = await submitted(fake);
      const handler = createDiarizePoll(fake.deps);

      const first = await handler(ctx, await stepFor(runId, 'diarize.poll'), NEVER);
      expect(first).toMatchObject({ state: 'awaiting_external', output: { lostResubmits: 1 } });
      expect(fake.submits, 'the original plus one resubmit').toHaveLength(2);

      await expect(handler(ctx, await stepFor(runId, 'diarize.poll'), NEVER)).rejects.toThrow(
        /crash-looping/i,
      );
      expect(fake.submits, 'and no third submit').toHaveLength(2);
    });

    it('records a failed diarization rather than only throwing', async () => {
      const fake = fakeDiarizer({
        state: 'failed',
        error: { code: 'oom', message: 'the model ran out of memory', retryable: false },
      });
      const runId = await submitted(fake);

      await expect(
        createDiarizePoll(fake.deps)(ctx, await stepFor(runId, 'diarize.poll'), NEVER),
      ).rejects.toThrow(/ran out of memory/i);

      // The row exists so `thibi speakers` can say why there are none, rather than the run
      // simply having no speakers and no explanation.
      const { rows } = await t.db.$client.query<{ state: string; error: { code: string } }>(
        `select state, error from diarization_runs where run_id = $1`,
        [runId],
      );
      expect(rows[0]).toMatchObject({ state: 'failed', error: { code: 'oom' } });
    });
  });

  describe('reconcile.speakers', () => {
    it('attributes words to durable speakers once both branches have landed', async () => {
      const fake = fakeDiarizer({ state: 'succeeded' });
      const runId = await plant();
      await createDiarize(fake.deps)(ctx, await stepFor(runId, 'diarize'), NEVER);
      await createDiarizePoll(fake.deps)(ctx, await stepFor(runId, 'diarize.poll'), NEVER);
      await transcribe(runId);

      const result = await reconcileSpeakers(
        ctx,
        await stepFor(runId, 'reconcile.speakers'),
        NEVER,
      );

      expect(result).toMatchObject({ state: 'done', output: { speakers: 2, turnsInserted: 2 } });

      // Our durable labels, not the diarizer's anonymous ones — `SPEAKER_00` is meaningless
      // across runs and a human's rename has to survive a re-diarization.
      const speakers = await t.db.$client.query<{ key: string }>(
        `select s.key from speakers s
           join jobs j on j.id = s.job_id
           join runs r on r.job_id = j.id
          where r.id = $1 order by s.key`,
        [runId],
      );
      expect(speakers.rows.map((s) => s.key)).toEqual(['speaker-00', 'speaker-01']);

      // The two words fall in different turns, so they must land on different speakers.
      const attributed = await t.db.$client.query<{ n: string }>(
        `select count(distinct speaker_id) as n from segments
          where run_id = $1 and speaker_id is not null`,
        [runId],
      );
      expect(Number(attributed.rows[0]!.n)).toBe(2);
    });

    /**
     * The absence has to be handled here rather than assumed away: a `skipped` dependency
     * satisfies its dependents exactly as a `done` one does, so this step is promoted even on
     * a box that never diarized anything.
     */
    it('skips when there is no diarization to attribute', async () => {
      const runId = await plant();
      await transcribe(runId);

      const result = await reconcileSpeakers(
        ctx,
        await stepFor(runId, 'reconcile.speakers'),
        NEVER,
      );
      expect(result).toMatchObject({ state: 'skipped', output: { reason: 'no-diarization' } });
    });

    it('skips when the transcript has not landed yet', async () => {
      const fake = fakeDiarizer({ state: 'succeeded' });
      const runId = await plant();
      await createDiarize(fake.deps)(ctx, await stepFor(runId, 'diarize'), NEVER);
      await createDiarizePoll(fake.deps)(ctx, await stepFor(runId, 'diarize.poll'), NEVER);
      // No `normalize.text`: on a chunked run this step and that one are siblings, so the
      // race is reachable rather than hypothetical.

      const result = await reconcileSpeakers(
        ctx,
        await stepFor(runId, 'reconcile.speakers'),
        NEVER,
      );
      expect(result).toMatchObject({ state: 'skipped', output: { reason: 'no-segments' } });
    });
  });
});
