import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import { createRun } from '../../pipeline/persist.js';
import { JobNotStartableError, startRun } from '../start.js';
import { loadRunContext, readPipelineSpec } from '../run-context.js';
import type { PipelineSpec } from '../plan.js';

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping startRun tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

const CHUNKED: PipelineSpec = {
  asr: { providerId: 'google', model: 'chirp_2', mode: 'sync_chunked', local: false, overlapMs: 1200 },
  editorial: [],
  peaks: false,
  exports: [],
};

describe.skipIf(!reachable)('startRun', () => {
  let t: TestDb;
  let ctx: EngineContext;
  let sha = 500;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = { db: t.db, engineVersion: '0.1.0' } as unknown as EngineContext;
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  /** A job with an asset, the way `thibi ingest` leaves one. */
  const plantJob = async (): Promise<string> => {
    const hex = String(sha++).padStart(64, '0');
    const { jobId } = await createRun(ctx, {
      sha256: hex,
      storageKey: `assets/${hex.slice(0, 2)}/${hex}/source.flac`,
      filename: 'interview.flac',
      bytes: 4_000_000,
      durationMs: 600_000,
      probeRaw: null,
      title: 'interview',
      languageCode: 'my-MM',
      providerId: 'google',
      model: 'chirp_2',
      mode: 'sync_chunked',
    });
    return jobId;
  };

  const steps = async (runId: string): Promise<Array<{ kind: string; shard: number; state: string }>> =>
    (
      await t.db.$client.query<{ kind: string; shard: number; state: string }>(
        `select kind, shard, state from run_steps where run_id = $1 order by ordinal, shard`,
        [runId],
      )
    ).rows;

  it('plans up to plan.chunks and no further, because nothing knows the chunk count yet', async () => {
    const jobId = await plantJob();
    const { runId, steps: planned } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: CHUNKED,
    });

    const kinds = (await steps(runId)).map((s) => s.kind);
    expect(kinds).toEqual(['media.probe', 'media.normalize', 'plan.chunks']);
    expect(planned).toBe(3);

    /**
     * Not one `asr.chunk` shard, and — the assertion that matters — no `normalize.text` either.
     *
     * A wildcard over a kind with no shards resolves to an empty array, so `normalize.text`
     * planned in this pass would have no dependencies at all, and a step with no dependencies is
     * a root. The reconciler promoted it on the first tick and a worker wrote an empty
     * transcript before a chunk had been cut, on the first real file this code ever saw.
     */
    expect(kinds).not.toContain('asr.chunk');
    expect(kinds).not.toContain('normalize.text');
  });

  it('writes the spec where every handler reads it', async () => {
    const jobId = await plantJob();
    const { runId } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: CHUNKED,
    });

    const loaded = await loadRunContext(ctx, runId);
    expect(loaded.spec).toEqual(CHUNKED);
    expect(loaded.mode).toBe('sync_chunked');
    expect(loaded.asset.durationMs).toBe(600_000);
    // The asset was probed at ingest, so `media.probe` will not download it again.
    expect(loaded.asset.probed).toBe(false);
  });

  it('leaves the run pending: promotion belongs to reconcile, not to whoever pressed start', async () => {
    const jobId = await plantJob();
    const { runId } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: CHUNKED,
    });

    const { rows } = await t.db.$client.query<{ state: string; progress: number }>(
      `select state, progress from runs where id = $1`,
      [runId],
    );
    expect(rows[0]).toEqual({ state: 'pending', progress: 0 });
    expect((await steps(runId)).every((s) => s.state === 'pending')).toBe(true);
  });

  it('points the job at the run, and says the job is running rather than pending', async () => {
    const jobId = await plantJob();
    const { runId } = await startRun(ctx, {
      jobId,
      providerId: 'google',
      model: 'chirp_2',
      spec: CHUNKED,
    });

    const { rows } = await t.db.$client.query<{ status: string; primary_run_id: string }>(
      `select status, primary_run_id from jobs where id = $1`,
      [jobId],
    );
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.primary_run_id).toBe(runId);
  });

  it('refuses a job that does not exist, with a sentence rather than a foreign-key error', async () => {
    await expect(
      startRun(ctx, {
        jobId: '00000000-0000-0000-0000-000000000000',
        providerId: 'google',
        model: 'chirp_2',
        spec: CHUNKED,
      }),
    ).rejects.toBeInstanceOf(JobNotStartableError);
  });

  /**
   * A run the CLI created has no spec and must not acquire a plausible one.
   *
   * This is the same class of bug as the empty-DAG guard in `reconcile`: the worker's tick
   * touches *every* live run, CLI-created ones included, and inventing a pipeline for one of
   * them is how a worker starts executing steps for a run that already finished in another
   * process.
   */
  it('reads no spec off a run that never had one', async () => {
    expect(readPipelineSpec({})).toBeNull();
    expect(readPipelineSpec({ planReason: 'chunked', warnings: [] })).toBeNull();
  });
});
