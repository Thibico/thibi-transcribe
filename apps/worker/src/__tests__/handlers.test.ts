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
  NORMALIZE,
  RECIPE_VERSION,
  SidecarBusyError,
  createRun,
  insertChunks,
  materialisePlan,
  planRun,
  startRun,
  systemClock,
  writeChunkResult,
  type ChunkResult,
  type EngineContext,
  type PipelineSpec,
  type TranscribeResult,
} from '@thibi/engine';
import { createAsrChunk } from '../handlers/asr-chunk.js';
import { normalizeText } from '../handlers/normalize-text.js';
import type { HandlerDeps } from '../handlers/shared.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [worker] Postgres not reachable at ${BASE_URL} — skipping handler tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const SPEC: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'sync_chunked', local: false, overlapMs: 0 },
  editorial: [],
  peaks: false,
  exports: [],
};

/** Two adjacent chunks with no overlap, so the seam merge is off and the arithmetic is plain. */
const CHUNKS = [
  { idx: 0, offsetMs: 0, contentStartMs: 0, endMs: 30_000, overlapLeadMs: 0 },
  { idx: 1, offsetMs: 30_000, contentStartMs: 30_000, endMs: 60_000, overlapLeadMs: 0 },
];

function resultFor(idx: number, texts: string[]): ChunkResult {
  const base = idx * 30_000;
  return {
    idx,
    segments: texts.map((text, i) => ({
      startMs: base + i * 5_000,
      endMs: base + i * 5_000 + 4_000,
      text,
      confidence: 0.9,
      words: text.split(' ').map((w, j) => ({
        startMs: base + i * 5_000 + j * 500,
        endMs: base + i * 5_000 + j * 500 + 400,
        text: w,
        confidence: 0.8,
      })),
    })),
    wordTimingQuality: 'full',
    usage: { audioMs: 30_000, requests: 1 },
    warnings: [],
    providerId: 'google',
    model: 'chirp_2',
    costUsd: 0.01,
  };
}

describe.skipIf(!reachable)('handlers', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 900;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = {
      db: t.db,
      store: new MemoryObjectStore(),
      tmp: createTempDirPort(),
      /**
       * A no-op ffmpeg. The busy-sidecar test has to reach the provider call, which sits after
       * the chunk cut, and cutting for real would mean shipping audio and shelling out to
       * ffmpeg to assert something about error classification. The port exists precisely so a
       * test can decline to run the tool.
       */
      ffmpeg: {
        run: async () => ({ stdout: '', stderr: '' }),
        stream: () => {
          throw new Error('not used');
        },
      },
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

  /** A run with its DAG, its chunk rows, and nothing transcribed yet. */
  const plant = async (): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { jobId, assetId } = await createRun(ctx, {
      sha256: hex,
      storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.flac`,
      filename: 'interview.flac',
      bytes: 4_000_000,
      durationMs: 60_000,
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
    // What `media.normalize` leaves behind. Only the busy-sidecar test reaches for it — the
    // others short-circuit on the stored-artifact guard first — but a fixture that models a
    // half-real run is how a test starts asserting the fixture instead of the code.
    const normalizedKey = `derivatives/${assetId}/normalized.flac`;
    await ctx.store.put(normalizedKey, Buffer.from('FLAC-ish'), { contentType: 'audio/flac' });
    await t.db.$client.query(
      `insert into media_derivatives (asset_id, kind, storage_key, recipe_version, bytes)
       values ($1, $2, $3, $4, 8)`,
      [assetId, NORMALIZE.kind, normalizedKey, RECIPE_VERSION],
    );

    // What `plan.chunks` does, minus the ffmpeg: write the chunk rows and extend the DAG with
    // the shards that consume them. In the same transaction there; separately here, because
    // the two statements are what this fixture is standing in for rather than what it tests.
    await insertChunks(t.db, runId, CHUNKS);
    await materialisePlan(t.db, runId, planRun(SPEC, CHUNKS.length));
    return runId;
  };

  const stepFor = async (runId: string, kind: string, shard = -1): Promise<RunStepRow> => {
    const { rows } = await t.db.$client.query<RunStepRow>(
      `select * from run_steps where run_id = $1 and kind = $2 and shard = $3`,
      [runId, kind, shard],
    );
    return camel(rows[0]!);
  };

  /** `select *` returns snake_case; the handler signature speaks Drizzle's camelCase. */
  const camel = (row: Record<string, unknown>): RunStepRow => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase())] = v;
    }
    return out as unknown as RunStepRow;
  };

  const segmentsOf = async (
    runId: string,
  ): Promise<Array<{ idx: number; text: string; start_ms: number; placeholder_reason: string | null }>> =>
    (
      await t.db.$client.query<{
        idx: number;
        text: string;
        start_ms: number;
        placeholder_reason: string | null;
      }>(
        `select idx, text, start_ms, placeholder_reason from segments
          where run_id = $1 order by idx`,
        [runId],
      )
    ).rows;

  describe('normalize.text', () => {
    it('assembles the chunks into one contiguous transcript', async () => {
      const runId = await plant();
      await writeChunkResult(ctx, runId, resultFor(0, ['မင်္ဂလာပါ', 'ကျေးဇူးတင်ပါတယ်']));
      await writeChunkResult(ctx, runId, resultFor(1, ['နောက်တစ်ခု']));

      const result = await normalizeText(ctx, await stepFor(runId, 'normalize.text'), NEVER);
      expect(result.state).toBe('done');

      const segments = await segmentsOf(runId);
      expect(segments.map((s) => s.idx)).toEqual([0, 1, 2]);
      expect(segments.map((s) => s.start_ms)).toEqual([0, 5_000, 30_000]);
      expect(segments.every((s) => s.placeholder_reason === null)).toBe(true);

      const { rows } = await t.db.$client.query<{ n: string }>(
        `select count(*) as n from words where run_id = $1`,
        [runId],
      );
      expect(Number(rows[0]!.n)).toBe(3);
    });

    /**
     * The claim §9 exists for: a chunk that never came back must leave a hole-free timeline.
     *
     * Asserted on `start_ms` as well as on the reason, because the value of a placeholder is
     * that it occupies the missing interval. One inserted at the wrong offset keeps the row
     * count right and the timeline wrong, which is worse than no placeholder at all.
     */
    it('stands a placeholder in for a chunk that never came back', async () => {
      const runId = await plant();
      await writeChunkResult(ctx, runId, resultFor(0, ['မင်္ဂလာပါ']));
      // Chunk 1 wrote no artifact: five attempts, five failures, step `dead`.

      await normalizeText(ctx, await stepFor(runId, 'normalize.text'), NEVER);

      const segments = await segmentsOf(runId);
      expect(segments).toHaveLength(2);
      expect(segments[1]).toMatchObject({
        idx: 1,
        text: '',
        start_ms: 30_000,
        placeholder_reason: 'chunk_failed',
      });

      const chunks = await t.db.$client.query<{ idx: number; status: string }>(
        `select idx, status from run_chunks where run_id = $1 order by idx`,
        [runId],
      );
      expect(chunks.rows).toEqual([
        { idx: 0, status: 'done' },
        { idx: 1, status: 'failed' },
      ]);
    });

    /**
     * `reconcile` is the only writer of `runs.state`, and this is the handler most tempted to
     * be the second one: it is the step that produces the transcript, so "the run is done"
     * feels like its conclusion to draw. It is not — an optional step may still be running,
     * and a casualty makes the run `partial` rather than `done`.
     */
    it('writes the transcript without declaring the run finished', async () => {
      const runId = await plant();
      await writeChunkResult(ctx, runId, resultFor(0, ['မင်္ဂလာပါ']));
      await writeChunkResult(ctx, runId, resultFor(1, ['နောက်တစ်ခု']));

      await normalizeText(ctx, await stepFor(runId, 'normalize.text'), NEVER);

      const { rows } = await t.db.$client.query<{
        state: string;
        progress: number;
        word_timing_quality: string;
        cost_usd: number;
      }>(
        `select state, progress, word_timing_quality, cost_usd from runs where id = $1`,
        [runId],
      );
      expect(rows[0]?.state).toBe('pending');
      expect(rows[0]?.progress).toBe(0);
      // What it *is* responsible for: the facts only it knows.
      expect(rows[0]?.word_timing_quality).toBe('full');
      expect(rows[0]?.cost_usd).toBeCloseTo(0.02, 6);
    });
  });

  describe('asr.chunk', () => {
    /**
     * The assertion that matters most in this phase, in its cheap form.
     *
     * A worker can die between "the provider answered" and "the step was marked done"; the
     * recovery sweep hands the step to somebody else, and the money must not be spent twice.
     * The counter here is what makes the test meaningful — asserting only that the step
     * succeeded would pass just as well if it had re-sent the audio.
     */
    it('does not re-send a chunk whose result is already stored', async () => {
      const runId = await plant();
      await writeChunkResult(ctx, runId, resultFor(0, ['မင်္ဂလာပါ']));

      let calls = 0;
      const deps = neverCalling(() => calls++);
      const handler = createAsrChunk(deps);

      const step = await stepFor(runId, 'asr.chunk', 0);
      const result = await handler(ctx, step, NEVER);

      expect(result).toMatchObject({ state: 'done', costUsd: 0.01 });
      expect(calls).toBe(0);
    });

    /**
     * **A busy local sidecar was spending a retry, and would have killed a run.**
     *
     * `SidecarBusyError` is a `RateLimitedError`, so `isRetryable` said yes and `onStepError`
     * burned one of this step's five attempts on each 429. The sidecar holds one slot for both
     * faster-whisper and pyannote — its own comment names "a diarization of this same file" as
     * the likely holder — so a `--provider faster-whisper --diarize` run contends with itself,
     * twenty shards at a time, and after five refusals apiece they start landing `dead`. That
     * is the failure `no_slot` exists to prevent, reached from the other direction.
     */
    it('treats a busy local sidecar as no_slot rather than spending an attempt', async () => {
      const runId = await plant();
      const deps: HandlerDeps = {
        providerFor: async () => ({
          provider: {
            id: 'faster-whisper',
            label: 'faster-whisper',
            capabilities: () => ({ limits: {} }) as never,
            supportsLanguage: () => null,
            resolveModel: () => 'small',
            isConfigured: () => true,
            costModel: () => ({ usdPerMinute: 0, source: 'test' }),
            transcribe: async (): Promise<TranscribeResult> => {
              throw new SidecarBusyError(45);
            },
          } as never,
          config: {},
          model: 'small',
          modelReason: 'test',
        }),
        diarizerFor: () => null,
      maxBucketWaitMs: 30_000,
      };

      const step = await stepFor(runId, 'asr.chunk', 0);
      const result = await createAsrChunk(deps)(ctx, step, NEVER);

      expect(result.state).toBe('no_slot');
      if (result.state !== 'no_slot') return;
      // The provider's own Retry-After, honoured rather than guessed at.
      expect(result.retryAfter.getTime()).toBeGreaterThan(Date.now() + 40_000);

      // And the chunk row is handed back the way it was found, so a requeue does not read as
      // an attempt there either.
      const { rows } = await t.db.$client.query<{ status: string; attempts: number }>(
        `select status, attempts from run_chunks where run_id = $1 and idx = 0`,
        [runId],
      );
      expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    });
  });
});

/** A signal that never fires: these handlers are not the ones being tested for cancellation. */
const NEVER = new AbortController().signal;

/** A provider that records being asked to transcribe and refuses to. */
function neverCalling(onCall: () => void): HandlerDeps {
  return {
    providerFor: async () => ({
      provider: {
        id: 'google',
        label: 'Google',
        capabilities: () => ({ limits: {} }) as never,
        supportsLanguage: () => null,
        resolveModel: () => 'chirp_2',
        isConfigured: () => true,
        costModel: () => ({ usdPerMinute: 0.016, source: 'test' }),
        transcribe: async (): Promise<TranscribeResult> => {
          onCall();
          throw new Error('the provider must not have been called');
        },
      } as never,
      config: {},
      model: 'chirp_2',
      modelReason: 'test',
    }),
    diarizerFor: () => null,
    maxBucketWaitMs: 30_000,
  };
}
