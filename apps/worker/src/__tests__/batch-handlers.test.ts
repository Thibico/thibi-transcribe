import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDb,
  postgresReachable,
  seedRates,
  DEFAULT_TEST_DATABASE_URL,
  type RunStepRow,
  type TestDb,
} from '@thibi/db';
import { MemoryObjectStore, createTempDirPort } from '@thibi/storage';
import { createRegistry } from '@thibi/languages';
import {
  FakeStagingStore,
  NORMALIZE,
  RECIPE_VERSION,
  createRun,
  insertChunks,
  loadOperation,
  materialisePlan,
  planRun,
  readChunkResult,
  startRun,
  systemClock,
  type BatchOp,
  type BatchRequest,
  type BatchStatus,
  type EngineContext,
  type PipelineSpec,
  type TranscribeResult,
} from '@thibi/engine';
import { createAsrBatchSubmit } from '../handlers/asr-batch-submit.js';
import { createAsrFetch } from '../handlers/asr-fetch.js';
import { createAsrPoll } from '../handlers/asr-poll.js';
import { stagingCleanup } from '../handlers/staging-cleanup.js';
import { normalizeText } from '../handlers/normalize-text.js';
import type { HandlerDeps } from '../handlers/shared.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [worker] Postgres not reachable at ${BASE_URL} — skipping batch handler tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

/** The region the fake staging bucket reports, so `ensureStageable` finds them co-located. */
const REGION = 'fake-region-1';

const SPEC: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'batch', local: false, overlapMs: 0 },
  editorial: [],
  peaks: false,
  exports: [],
};

/** One whole-file chunk, which is what `plan.chunks` writes on the batch path. */
const CHUNKS = [{ idx: 0, offsetMs: 0, contentStartMs: 0, endMs: 600_000, overlapLeadMs: 0 }];

const NEVER = new AbortController().signal;

/**
 * A recording provider with a working batch surface.
 *
 * Counting is the point of it: every claim in this file is about how many times Google was
 * asked to do something, and a test that asserted only on the resulting state would pass just
 * as well against a handler that submitted the same audio twice.
 */
interface FakeProvider {
  deps: HandlerDeps;
  submits: BatchRequest[];
  polls: BatchOp[];
  fetches: number;
  /** What the next poll returns. Reassign between calls to drive the state machine. */
  status: BatchStatus;
  result: TranscribeResult;
}

function fakeProvider(status: BatchStatus = { state: 'running', progressPercent: 26 }): FakeProvider {
  const state: FakeProvider = {
    submits: [],
    polls: [],
    fetches: 0,
    status,
    result: {
      segments: [
        {
          startMs: 0,
          endMs: 4_000,
          text: 'မင်္ဂလာပါ',
          confidence: 0.9,
          words: [{ startMs: 0, endMs: 900, text: 'မင်္ဂလာပါ', confidence: 0.9 }],
        },
      ],
      wordTimingQuality: 'full',
      usage: { audioMs: 600_000, requests: 1 },
      raw: { responses: 'recorded' },
      warnings: [],
    },
    deps: { providerFor: async () => ({}) as never },
  };

  state.deps = {
    providerFor: async () => ({
      provider: {
        id: 'google',
        label: 'Google',
        capabilities: () => ({ limits: {} }) as never,
        supportsLanguage: () => ({ providerCode: 'my-MM' }) as never,
        resolveModel: () => 'chirp_2',
        isConfigured: () => true,
        costModel: () => ({ usdPerMinute: 0.016, source: 'test' }),
        transcribe: async (): Promise<TranscribeResult> => {
          throw new Error('the sync path must not be reached on a batch run');
        },
        submitBatch: async (_cfg: unknown, req: BatchRequest): Promise<BatchOp> => {
          state.submits.push(req);
          return {
            provider: 'google',
            region: REGION,
            name: `projects/p/locations/${REGION}/operations/${state.submits.length}`,
            inputUri: req.audioUri,
            outputPrefix: req.outputUri,
            submittedAtMs: Date.now(),
            dynamicBatching: true,
          };
        },
        pollBatch: async (_cfg: unknown, op: BatchOp): Promise<BatchStatus> => {
          state.polls.push(op);
          return state.status;
        },
        fetchBatchResult: async (): Promise<TranscribeResult> => {
          state.fetches++;
          return state.result;
        },
      } as never,
      // `region` is read off the config by `regionOf`, never named in a handler.
      config: { region: REGION },
      model: 'chirp_2',
      modelReason: 'test',
    }),
  };

  return state;
}

describe.skipIf(!reachable)('batch handlers', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let staging: FakeStagingStore;
  let sha = 700;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    // Without a rate, `recordUsage` returns null and writes nothing — "we do not know what
    // this cost" rather than $0.00. Seeded here so the billed-duration assertion below is a
    // real one rather than an assertion about an absent row.
    await seedRates(t.db);
    staging = new FakeStagingStore({ location: REGION });
    ctx = {
      db: t.db,
      store: new MemoryObjectStore(),
      tmp: createTempDirPort(),
      staging,
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

  /**
   * A batch run planned as far as `plan.chunks` has taken it, with a normalized derivative in
   * the object store so `asr.batch.submit` has something to stage.
   */
  const plant = async (): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { jobId, assetId } = await createRun(ctx, {
      sha256: hex,
      storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.wav`,
      filename: 'interview.wav',
      bytes: 40_000_000,
      durationMs: 600_000,
      probeRaw: null,
      title: 'interview',
      languageCode: 'my-MM',
      providerId: 'google',
      model: 'chirp_2',
      mode: 'batch',
    });
    const { runId } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: SPEC,
    });

    // What `media.normalize` leaves behind: the derivative row and its bytes.
    const normalizedKey = `derivatives/${assetId}/normalized.flac`;
    await ctx.store.put(normalizedKey, Buffer.from('FLAC-ish bytes'), {
      contentType: 'audio/flac',
    });
    await t.db.$client.query(
      `insert into media_derivatives (asset_id, kind, storage_key, recipe_version, bytes)
       values ($1, $2, $3, $4, 14)`,
      [assetId, NORMALIZE.kind, normalizedKey, RECIPE_VERSION],
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
    return camel(rows[0]!);
  };

  const camel = (row: Record<string, unknown>): RunStepRow => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase())] = v;
    }
    return out as unknown as RunStepRow;
  };

  describe('asr.batch.submit', () => {
    it('stages the audio, submits once, and persists the operation before finishing', async () => {
      const runId = await plant();
      const fake = fakeProvider();

      const result = await createAsrBatchSubmit(fake.deps)(
        ctx,
        await stepFor(runId, 'asr.batch.submit'),
        NEVER,
      );

      expect(result.state, 'done, not awaiting_external — asr.poll owns the wait').toBe('done');
      expect(fake.submits).toHaveLength(1);
      // Mapped through the provider matrix rather than passed as the registry code.
      expect(fake.submits[0]!.languageCode).toBe('my-MM');
      expect(fake.submits[0]!.durationMs).toBe(600_000);
      expect([...staging.objects.keys()].some((k) => k.includes(runId))).toBe(true);

      // Durable before the step row, which is what makes the guard below meaningful.
      const stored = await loadOperation(ctx, runId);
      expect(stored?.op?.name).toContain('operations/1');
      expect(stored?.op?.region, 'a poll URL cannot be rebuilt without it').toBe(REGION);
      expect(stored?.stagingPrefix).not.toBeNull();
    });

    /**
     * **The claim this phase exists for, in its cheapest form.**
     *
     * A worker can die between `batchRecognize` returning a name and the step being marked
     * done. The recovery sweep hands the step to somebody else — `runStep` claims
     * `state in ('ready','awaiting_external')` — and the second worker must not spend two more
     * hours of Google's money on audio Google is already transcribing. The counter is the
     * assertion; the state would look identical either way.
     */
    it('does not re-submit an operation that is already persisted', async () => {
      const runId = await plant();
      const fake = fakeProvider();
      const handler = createAsrBatchSubmit(fake.deps);
      const step = await stepFor(runId, 'asr.batch.submit');

      await handler(ctx, step, NEVER);
      // The crash: nothing marked the step done, so it is handed back to a worker unchanged.
      const again = await handler(ctx, step, NEVER);

      expect(again).toMatchObject({ state: 'done', output: { reused: true } });
      expect(fake.submits, 'the second attempt must not reach the provider').toHaveLength(1);
    });
  });

  describe('asr.poll', () => {
    const submitted = async (fake: FakeProvider): Promise<string> => {
      const runId = await plant();
      await createAsrBatchSubmit(fake.deps)(
        ctx,
        await stepFor(runId, 'asr.batch.submit'),
        NEVER,
      );
      return runId;
    };

    it('parks in awaiting_external with a poll_after and a progress fraction', async () => {
      const fake = fakeProvider({ state: 'running', progressPercent: 26 });
      const runId = await submitted(fake);

      const result = await createAsrPoll(fake.deps)(ctx, await stepFor(runId, 'asr.poll'), NEVER);

      expect(result.state).toBe('awaiting_external');
      if (result.state !== 'awaiting_external') return;
      expect(result.externalRef).toContain('operations/1');
      expect(result.pollAfter!.getTime()).toBeGreaterThan(Date.now());
      // A percentage divided to a fraction. The plan's sketch passed it through undivided,
      // which would have put the timeline at 2600%.
      expect(result.output).toMatchObject({ polls: 1, progress: 0.26 });
    });

    it('counts polls in output and never in attempt', async () => {
      const fake = fakeProvider({ state: 'running', progressPercent: 52 });
      const runId = await submitted(fake);
      const handler = createAsrPoll(fake.deps);

      const step = await stepFor(runId, 'asr.poll');
      const first = await handler(ctx, step, NEVER);
      expect(first.state).toBe('awaiting_external');
      if (first.state !== 'awaiting_external') return;

      // What `applyStepResult` would have written back, fed into the next claim.
      const second = await handler(ctx, { ...step, output: first.output ?? null }, NEVER);
      expect(second.state).toBe('awaiting_external');
      if (second.state !== 'awaiting_external') return;

      expect(second.output).toMatchObject({ polls: 2 });
      expect(fake.polls).toHaveLength(2);
      // `max_attempts: 8` means eight *failed* poll requests. A run showing 47 polls is
      // informative; one showing attempt 47/8 is a bug report.
      expect((await stepFor(runId, 'asr.poll')).attempt).toBe(0);
    });

    it('finishes and records the latency and billed duration on the run', async () => {
      const fake = fakeProvider({
        state: 'succeeded',
        outputUri: 'gs://fake-staging/thibi-staging/x/out',
        totalBilledDuration: '600s',
        doneAtMs: Date.now(),
      });
      const runId = await submitted(fake);

      const result = await createAsrPoll(fake.deps)(ctx, await stepFor(runId, 'asr.poll'), NEVER);
      expect(result.state).toBe('done');

      const { rows } = await t.db.$client.query<{ batch: Record<string, unknown> }>(
        `select pipeline->'batch' as batch from runs where id = $1`,
        [runId],
      );
      expect(rows[0]!.batch).toMatchObject({
        totalBilledDuration: '600s',
        polls: 1,
      });
      expect(rows[0]!.batch['latencyMs']).toBeTypeOf('number');
      // The spec the planner wrote is still beside it: every writer of this column merges.
      const { rows: spec } = await t.db.$client.query<{ mode: string }>(
        `select pipeline->'asr'->>'mode' as mode from runs where id = $1`,
        [runId],
      );
      expect(spec[0]!.mode).toBe('batch');
    });

    /**
     * `done: true` with a per-file error is not success — spike S3 measured it at 1 run in 5.
     * The handler must branch on `state`, which is where `classifyOperation` has already
     * collapsed both failure shapes.
     */
    it('fails the step when the operation reports a per-file error', async () => {
      const fake = fakeProvider({
        state: 'failed',
        error: { message: 'unable to decode', scope: 'file', code: 13 },
        retryable: true,
      });
      const runId = await submitted(fake);

      await expect(
        createAsrPoll(fake.deps)(ctx, await stepFor(runId, 'asr.poll'), NEVER),
      ).rejects.toThrow(/the file failed: unable to decode/i);
    });

    it('refuses to poll an operation that is past its deadline', async () => {
      const fake = fakeProvider();
      const runId = await submitted(fake);
      // Backdate the submission by seven hours, which is how a restart-proof deadline is
      // exceeded: it is anchored on submittedAtMs, so a restart cannot extend it.
      await t.db.$client.query(
        `update runs set pipeline = jsonb_set(pipeline, '{batch,submittedAtMs}',
                to_jsonb((extract(epoch from now()) * 1000 - 7 * 3600 * 1000)::bigint))
         where id = $1`,
        [runId],
      );

      await expect(
        createAsrPoll(fake.deps)(ctx, await stepFor(runId, 'asr.poll'), NEVER),
      ).rejects.toThrow(/giving up on it/i);
      expect(fake.polls, 'the deadline is checked before the request').toHaveLength(0);
    });
  });

  describe('asr.fetch', () => {
    const polled = async (fake: FakeProvider): Promise<string> => {
      const runId = await plant();
      await createAsrBatchSubmit(fake.deps)(ctx, await stepFor(runId, 'asr.batch.submit'), NEVER);
      fake.status = {
        state: 'succeeded',
        outputUri: 'gs://fake-staging/out',
        totalBilledDuration: '600s',
      };
      await createAsrPoll(fake.deps)(ctx, await stepFor(runId, 'asr.poll'), NEVER);
      return runId;
    };

    /**
     * The design claim: a batch run leaves the *same artifact* a chunked run leaves, so one
     * persistence path serves both shapes and the batch path gets the Zawgyi normalization,
     * the `text_raw` audit trail and the `usage_records` row without a second copy of them.
     */
    it('writes a chunk-result artifact that normalize.text assembles unchanged', async () => {
      const fake = fakeProvider();
      const runId = await polled(fake);

      await createAsrFetch(fake.deps)(ctx, await stepFor(runId, 'asr.fetch'), NEVER);

      const artifact = await readChunkResult(ctx, runId, 0);
      expect(artifact?.segments).toHaveLength(1);
      expect(artifact?.costUsd).toBeCloseTo(0.16, 6);

      await normalizeText(ctx, await stepFor(runId, 'normalize.text'), NEVER);

      const { rows } = await t.db.$client.query<{ idx: number; text: string }>(
        `select idx, text from segments where run_id = $1 order by idx`,
        [runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toBe('မင်္ဂလာပါ');

      // Costed from Google's billed duration rather than from our probe, because that is the
      // number that appears on the invoice.
      const usage = await t.db.$client.query<{ reported: { totalBilledDuration?: string } }>(
        `select reported from usage_records where run_id = $1`,
        [runId],
      );
      expect(usage.rows[0]?.reported).toMatchObject({ totalBilledDuration: '600s' });
    });

    it('does not re-read an operation whose result is already stored', async () => {
      const fake = fakeProvider();
      const runId = await polled(fake);
      const handler = createAsrFetch(fake.deps);

      const step = await stepFor(runId, 'asr.fetch');
      await handler(ctx, step, NEVER);
      const again = await handler(ctx, step, NEVER);

      expect(again).toMatchObject({ state: 'done', output: { reused: true } });
      expect(fake.fetches).toBe(1);
    });
  });

  describe('staging.cleanup', () => {
    it('sweeps the staged audio and clears the column that claimed it', async () => {
      const fake = fakeProvider();
      const runId = await plant();
      await createAsrBatchSubmit(fake.deps)(ctx, await stepFor(runId, 'asr.batch.submit'), NEVER);

      const result = await stagingCleanup(ctx, await stepFor(runId, 'staging.cleanup'), NEVER);

      expect(result.state).toBe('done');
      expect(staging.deletedPrefixes.some((p) => p.includes(runId))).toBe(true);
      const { rows } = await t.db.$client.query<{ staging_prefix: string | null }>(
        `select staging_prefix from runs where id = $1`,
        [runId],
      );
      expect(rows[0]!.staging_prefix, 'the column must never lie about what is still there')
        .toBeNull();
    });
  });
});
