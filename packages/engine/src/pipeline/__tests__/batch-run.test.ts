import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { BatchOp, BatchStatus, TranscriptionProvider } from '../../providers/types.js';
import type { EngineContext } from '../../context.js';
import {
  claimStagingPrefix,
  clearStagingPrefix,
  isCancelRequested,
  loadOperation,
  parseBilledSeconds,
  persistOperation,
  recordBatchProgress,
  recordUsage,
  requestCancel,
} from '../batch-persist.js';
import { pollToCompletion } from '../batch-run.js';
import { resumeBatchRun } from '../operation-reconcile.js';

/**
 * The batch bookkeeping, against a real Postgres.
 *
 * These are the assertions a mock cannot make. The ordering guarantee this phase exists for
 * — the operation name is durable before anything polls — is a property of what is committed
 * and when, and the only way to test it is to look in the database between the two steps.
 */

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping batch persistence tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const op: BatchOp = {
  provider: 'google',
  region: 'asia-southeast1',
  name: 'projects/p/locations/asia-southeast1/operations/v2-abc',
  inputUri: 'gs://bucket/thibi-staging/RUN/audio.flac',
  outputPrefix: 'gs://bucket/thibi-staging/RUN/out',
  submittedAtMs: 1_760_000_000_000,
  dynamicBatching: true,
};

describe.skipIf(!reachable)('batch persistence', () => {
  let test: TestDb;
  let ctx: EngineContext;

  beforeAll(async () => {
    test = await createTestDb(BASE_URL);
    ctx = {
      db: test.db,
      clock: { now: () => new Date(1_760_000_300_000), sleep: async () => {} },
      logger: { child: () => ctx.logger, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      events: { emit: () => {} },
    } as unknown as EngineContext;
  }, 60_000);

  afterAll(async () => {
    await test?.drop();
  });

  /** A minimal asset → job → run chain, since `runs` is the table under test. */
  async function makeRun(mode = 'batch'): Promise<string> {
    const client = test.db.$client;
    const sha = Math.random().toString(16).slice(2).padEnd(64, '0');
    const asset = await client.query<{ id: string }>(
      `insert into media_assets (sha256, storage_key, filename, bytes, source)
       values ($1,$2,'a.flac',1,'upload') returning id`,
      [sha, `assets/${sha}`],
    );
    const job = await client.query<{ id: string }>(
      `insert into jobs (asset_id, title, language_code, status)
       values ($1,'t','my','running') returning id`,
      [asset.rows[0]!.id],
    );
    const run = await client.query<{ id: string }>(
      `insert into runs (job_id, provider_id, model, language_code, mode, state, engine_version)
       values ($1,'google','chirp_2','my',$2,'running','test') returning id`,
      [job.rows[0]!.id, mode],
    );
    return run.rows[0]!.id;
  }

  const readRun = async (runId: string) =>
    (
      await test.db.$client.query<{
        mode: string;
        operation_name: string | null;
        staging_prefix: string | null;
        pipeline: Record<string, unknown>;
      }>('select mode, operation_name, staging_prefix, pipeline from runs where id = $1', [runId])
    ).rows[0]!;

  it('declares mode=batch and claims the prefix before the upload', async () => {
    /**
     * `mode` is written here rather than alongside the operation name, which is a
     * correction to the phase plan. A run that crashes between the upload and the submit
     * would otherwise be indistinguishable from a sync run, so nothing would ever go
     * looking for its orphaned audio or its orphaned operation.
     */
    const runId = await makeRun('sync_chunked');
    await claimStagingPrefix(ctx, runId, `thibi-staging/${runId}/`);

    const row = await readRun(runId);
    expect(row.mode).toBe('batch');
    expect(row.staging_prefix).toBe(`thibi-staging/${runId}/`);
    // And crucially, still no operation name: nothing has been submitted yet.
    expect(row.operation_name).toBeNull();
  });

  it('writes the operation name and the whole BatchOp in one statement', async () => {
    const runId = await makeRun();
    await persistOperation(ctx, runId, op);

    const row = await readRun(runId);
    expect(row.operation_name).toBe(op.name);
    // The whole op, not just the name: a resume rebuilds the poll without re-deriving
    // `region` and `inputUri` from three other columns and hoping they still agree.
    expect(row.pipeline['batch']).toMatchObject({
      name: op.name,
      region: 'asia-southeast1',
      inputUri: op.inputUri,
      dynamicBatching: true,
    });
  });

  it('merges into pipeline rather than replacing it', async () => {
    // The bug that ate the batch record on the first live run: `persistResult` did
    // `pipeline = $4`, deleting everything written earlier in the run.
    const runId = await makeRun();
    await persistOperation(ctx, runId, op);
    await test.db.$client.query(
      `update runs set pipeline = pipeline || $2::jsonb where id = $1`,
      [runId, JSON.stringify({ planReason: 'requested explicitly', warnings: [] })],
    );

    const row = await readRun(runId);
    expect(row.pipeline['planReason']).toBe('requested explicitly');
    expect(row.pipeline['batch']).toBeDefined();
  });

  it('records latency and the billed duration without clobbering the op', async () => {
    const runId = await makeRun();
    await persistOperation(ctx, runId, op);
    await recordBatchProgress(ctx, runId, {
      doneAtMs: 1_760_000_258_000,
      latencyMs: 258_000,
      totalBilledDuration: '1200s',
      polls: 13,
    });

    const batch = (await readRun(runId)).pipeline['batch'] as Record<string, unknown>;
    expect(batch['name']).toBe(op.name);
    // Risk 2 asks for submittedAt → done on *every* batch run from day one, so Phase 9 and
    // Phase 11 can quote a real p50/p90 instead of showing a spinner.
    expect(batch['latencyMs']).toBe(258_000);
    expect(batch['totalBilledDuration']).toBe('1200s');
  });

  it('round-trips the operation through the database and back into a pollable BatchOp', async () => {
    const runId = await makeRun();
    await persistOperation(ctx, runId, op);

    const loaded = await loadOperation(ctx, runId);
    // Byte-for-byte the same struct a worker in Phase 9 would poll with.
    expect(loaded?.op).toEqual(op);
  });

  it('clears the staging prefix only after the sweep', async () => {
    const runId = await makeRun();
    await claimStagingPrefix(ctx, runId, `thibi-staging/${runId}/`);
    expect((await readRun(runId)).staging_prefix).not.toBeNull();
    await clearStagingPrefix(ctx, runId);
    expect((await readRun(runId)).staging_prefix).toBeNull();
  });

  it('surfaces a cancellation request', async () => {
    const runId = await makeRun();
    expect(await isCancelRequested(ctx, runId)).toBe(false);
    await requestCancel(ctx, runId);
    expect(await isCancelRequested(ctx, runId)).toBe(true);
  });

  describe('recordUsage', () => {
    beforeAll(async () => {
      const { seedRates } = await import('@thibi/db');
      await seedRates(test.db);
    });

    it("prefers Google's reported duration over our own probe", async () => {
      // The point of the row is to be checkable against a bill. When the two disagree, the
      // provider's number is the one that shows up on the invoice.
      const runId = await makeRun();
      const written = await recordUsage(ctx, {
        runId,
        providerId: 'google',
        model: 'chirp_2',
        mode: 'batch',
        status: { totalBilledDuration: '1200s' },
        audioMs: 999_999_999,
      });

      expect(written).toMatchObject({ minutes: 20, usdPerUnit: 0.003, reportedByProvider: true });
      expect(written?.usd).toBeCloseTo(0.06, 6);
    });

    it('bills sync and sync_chunked at the same, higher SKU', async () => {
      // Chunking is our implementation detail; Google bills the audio either way, which is
      // exactly why chunked sync costs 5.33x more than batch for identical input.
      const runId = await makeRun();
      const written = await recordUsage(ctx, {
        runId,
        providerId: 'google',
        model: 'chirp_2',
        mode: 'sync_chunked',
        audioMs: 1_200_000,
      });
      expect(written).toMatchObject({ minutes: 20, usdPerUnit: 0.016, reportedByProvider: false });
      expect(written!.usd / 0.06).toBeCloseTo(5.333, 2);
    });

    it('returns null rather than $0.00 when no rate is configured', async () => {
      // Quoting zero for two hours of transcription is worse than admitting ignorance,
      // because somebody will believe it.
      const runId = await makeRun();
      const written = await recordUsage(ctx, {
        runId,
        providerId: 'nonexistent',
        model: 'x',
        mode: 'batch',
        audioMs: 1_200_000,
      });
      expect(written).toBeNull();
    });
  });

  describe('resumeBatchRun', () => {
    it('resumes from the stored operation without listing anything', async () => {
      const runId = await makeRun();
      await persistOperation(ctx, runId, op);
      const outcome = await resumeBatchRun(ctx, {
        runId,
        // A deps object whose fetch would throw: the common path must not reach the network.
        deps: {
          region: 'asia-southeast1',
          projectId: 'p',
          getToken: async () => 't',
          clock: ctx.clock,
          fetchImpl: (() => {
            throw new Error('resume listed operations when it should not have');
          }) as unknown as typeof fetch,
        },
      });
      expect(outcome).toMatchObject({ kind: 'resume', recovered: false });
    });

    it('refuses to resume a sync run', async () => {
      const runId = await makeRun('sync_chunked');
      const outcome = await resumeBatchRun(ctx, {
        runId,
        deps: { region: 'r', projectId: 'p', getToken: async () => 't', clock: ctx.clock },
      });
      expect(outcome).toMatchObject({ kind: 'not-batch', mode: 'sync_chunked' });
    });

    it('reports a finished run as nothing to do', async () => {
      const runId = await makeRun();
      await persistOperation(ctx, runId, op);
      await test.db.$client.query(`update runs set state='done' where id=$1`, [runId]);
      const outcome = await resumeBatchRun(ctx, {
        runId,
        deps: { region: 'r', projectId: 'p', getToken: async () => 't', clock: ctx.clock },
      });
      expect(outcome).toMatchObject({ kind: 'already-finished', state: 'done' });
    });

    it('returns not-found for an unknown run', async () => {
      const outcome = await resumeBatchRun(ctx, {
        runId: '00000000-0000-0000-0000-000000000000',
        deps: { region: 'r', projectId: 'p', getToken: async () => 't', clock: ctx.clock },
      });
      expect(outcome).toEqual({ kind: 'not-found' });
    });
  });

  describe('pollToCompletion', () => {
    /** A provider whose poll returns a scripted sequence. */
    function scripted(statuses: BatchStatus[]): { provider: TranscriptionProvider; polls: () => number } {
      let i = 0;
      const provider = {
        id: 'google',
        pollBatch: async () => statuses[Math.min(i++, statuses.length - 1)]!,
        submitBatch: async () => op,
        fetchBatchResult: async () => {
          throw new Error('not used');
        },
      } as unknown as TranscriptionProvider;
      return { provider, polls: () => i };
    }

    it('writes the operation name BEFORE the first poll', async () => {
      /**
       * The ordering the whole phase exists for, asserted from inside the poll itself: at
       * the moment the first poll happens, the database must already know the operation
       * name. A lost name means a second submission and a second bill for audio Google has
       * already processed.
       */
      const runId = await makeRun();
      let nameAtFirstPoll: string | null | undefined;

      const provider = {
        id: 'google',
        pollBatch: async (): Promise<BatchStatus> => {
          if (nameAtFirstPoll === undefined) nameAtFirstPoll = (await readRun(runId)).operation_name;
          return { state: 'succeeded', outputUri: 'gs://b/out/x.json' };
        },
      } as unknown as TranscriptionProvider;

      await claimStagingPrefix(ctx, runId, `thibi-staging/${runId}/`);
      await persistOperation(ctx, runId, op);
      await pollToCompletion(ctx, { runId, provider, providerConfig: {} }, op);

      expect(nameAtFirstPoll).toBe(op.name);
    });

    it('keeps polling while the operation is running and stops when it is not', async () => {
      const runId = await makeRun();
      const { provider, polls } = scripted([
        { state: 'running', progressPercent: 26 },
        { state: 'running', progressPercent: 52 },
        { state: 'succeeded', outputUri: 'gs://b/out/x.json' },
      ]);
      const seen: number[] = [];
      const status = await pollToCompletion(
        ctx,
        {
          runId,
          provider,
          providerConfig: {},
          onPoll: (s) => {
            if (s.progressPercent !== undefined) seen.push(s.progressPercent);
          },
        },
        op,
      );
      expect(status.state).toBe('succeeded');
      expect(polls()).toBe(3);
      expect(seen).toEqual([26, 52]);
    });

    it('returns a failure rather than polling forever', async () => {
      const runId = await makeRun();
      const { provider } = scripted([
        { state: 'failed', error: { message: 'boom', scope: 'file' }, retryable: true },
      ]);
      const status = await pollToCompletion(ctx, { runId, provider, providerConfig: {} }, op);
      expect(status.state).toBe('failed');
    });

    it('aborts on a cancellation request before issuing the next poll', async () => {
      // Checked *before* each poll rather than after, so a cancel arriving during a
      // five-minute sleep is honoured on waking rather than one poll later.
      const runId = await makeRun();
      await requestCancel(ctx, runId);
      const { provider, polls } = scripted([{ state: 'running' }]);
      await expect(
        pollToCompletion(ctx, { runId, provider, providerConfig: {} }, op),
      ).rejects.toThrow(/Aborted/);
      expect(polls()).toBe(0);
    });
  });
});

describe('parseBilledSeconds', () => {
  it('parses the protobuf duration-as-string form', () => {
    // The same trap `parseOffsetMs` handles for word offsets.
    expect(parseBilledSeconds('1200s')).toBe(1200);
    expect(parseBilledSeconds('7203.5s')).toBe(7203.5);
    expect(parseBilledSeconds('0s')).toBe(0);
  });

  it('returns null for absent or unparseable input', () => {
    expect(parseBilledSeconds(undefined)).toBeNull();
    expect(parseBilledSeconds('later')).toBeNull();
  });
});
