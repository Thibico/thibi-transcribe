import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import type { EngineContext } from '../../context.js';
import {
  createRun,
  JobAssetMismatchError,
  JobNotFoundError,
  type CreateRunInput,
} from '../persist.js';

/**
 * `--job`, and the guard that makes it safe.
 *
 * `speakers` is scoped to `job_id`, so a name only carries forward within a job. Without
 * `--job`, re-transcribing a recording with a better provider produced a second job and a
 * fresh set of unnamed speakers, and the identity matcher never saw a prior at all
 * (overview amendment 46).
 *
 * The guard is the interesting half. A speaker name is a fact about a *recording*, so
 * attaching a different recording to a job would hand a human's names to a timeline they
 * never listened to — and the Hungarian matcher would place them by coincidental overlap
 * without complaining once. Two files and one pasted job id is an easy mistake to make and
 * an almost impossible one to notice afterwards.
 */

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [engine] Postgres not reachable at ${BASE_URL} — skipping createRun tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

describe.skipIf(!reachable)('createRun --job', () => {
  let t: TestDb;
  let ctx: EngineContext;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    ctx = { db: t.db, engineVersion: '0.1.0' } as unknown as EngineContext;
  }, 60_000);

  // 60 s, matching the `beforeAll` above. `drop database … with (force)` is slow when the
  // machine is busy and is not the thing under test. It must be set HERE rather than in
  // vitest.config.ts: root-level `test.hookTimeout` is silently ignored when `test.projects`
  // is used — verified 2026-08-11 by setting it to 1 ms and watching every suite still pass.
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const input = (sha: string, over: Partial<CreateRunInput> = {}): CreateRunInput => ({
    sha256: sha,
    storageKey: `assets/${sha.slice(0, 2)}/${sha}/source.flac`,
    filename: 'interview.flac',
    bytes: 1234,
    durationMs: 33_575,
    probeRaw: null,
    title: 'interview',
    languageCode: 'my-MM',
    providerId: 'google',
    model: 'chirp_2',
    mode: 'sync',
    ...over,
  });

  it('mints a new job when --job is absent, even for a byte-identical file', async () => {
    // The behaviour amendment 46 is about. Recorded as a test rather than a footnote,
    // because the plan's Verification section assumed the opposite and its demo passed
    // while proving nothing.
    const sha = 'a'.repeat(64);
    const first = await createRun(ctx, input(sha));
    const second = await createRun(ctx, input(sha));

    expect(second.assetId, 'the asset is content-addressed and deduped').toBe(first.assetId);
    expect(second.jobId, 'the job is not').not.toBe(first.jobId);
  });

  it('reuses the job, and mints a new run on it, when --job is given', async () => {
    const sha = 'b'.repeat(64);
    const first = await createRun(ctx, input(sha));
    const second = await createRun(ctx, input(sha, { jobId: first.jobId }));

    expect(second.jobId).toBe(first.jobId);
    expect(second.runId).not.toBe(first.runId);

    const runs = await t.db.$client.query<{ n: string }>(
      'select count(*) as n from runs where job_id = $1',
      [first.jobId],
    );
    expect(Number(runs.rows[0]!.n)).toBe(2);
  });

  it('refuses a job holding a different recording', async () => {
    const jobOfA = await createRun(ctx, input('c'.repeat(64)));
    await expect(
      createRun(ctx, input('d'.repeat(64), { jobId: jobOfA.jobId })),
    ).rejects.toThrow(JobAssetMismatchError);
  });

  it('says what to do about it', async () => {
    // The message is the feature: whoever hits this pasted the wrong id, and needs to know
    // that dropping the flag is the fix rather than that a constraint fired.
    const jobOfA = await createRun(ctx, input('e'.repeat(64)));
    await expect(
      createRun(ctx, input('f'.repeat(64), { jobId: jobOfA.jobId })),
    ).rejects.toThrow(/different recording[\s\S]*Drop --job/);
  });

  it('leaves nothing behind when it refuses', async () => {
    // The guard throws mid-transaction, after the new asset row has been inserted. A
    // rollback that did not cover it would leave an orphan asset per mistyped id.
    const jobOfA = await createRun(ctx, input('1'.repeat(64)));
    const sha = '2'.repeat(64);
    await expect(createRun(ctx, input(sha, { jobId: jobOfA.jobId }))).rejects.toThrow();

    const orphan = await t.db.$client.query<{ n: string }>(
      'select count(*) as n from media_assets where sha256 = $1',
      [sha],
    );
    expect(Number(orphan.rows[0]!.n), 'the rejected asset must not survive').toBe(0);
  });

  it('rejects an unknown job id', async () => {
    await expect(
      createRun(ctx, input('3'.repeat(64), { jobId: '00000000-0000-0000-0000-000000000000' })),
    ).rejects.toThrow(JobNotFoundError);
  });
});
