import { randomUUID } from 'node:crypto';
import { createTestDb, postgresReachable, DEFAULT_TEST_DATABASE_URL, type TestDb } from '@thibi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineContext } from '../../context.js';
import { ingestBatch, type IngestBatchInput } from '../batch.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);

describe.skipIf(!reachable)('ingestBatch', () => {
  let test: TestDb;
  let ctx: EngineContext;

  beforeAll(async () => {
    test = await createTestDb(BASE_URL);
    ctx = {
      db: test.db,
      clock: { now: () => new Date(1_760_000_000_000), sleep: async () => {} },
      logger: {
        child: () => ctx.logger,
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      events: { emit: () => {} },
    } as unknown as EngineContext;

    // The rate Phase 2 seeds. Without it every estimate is unpriced, which is a different
    // test than the one below.
    await test.db.$client.query(
      `insert into rates (provider_id, model, unit, usd_per_unit, source)
       values ('google','chirp_2','minute',0.016,'default')
       on conflict do nothing`,
    );
  }, 60_000);

  afterAll(async () => {
    await test?.drop();
  });

  async function makeAsset(filename: string, durationMs: number | null): Promise<string> {
    const sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const r = await test.db.$client.query<{ id: string }>(
      `insert into media_assets (sha256, storage_key, filename, bytes, duration_ms, source)
       values ($1,$2,$3,1000,$4,'upload') returning id`,
      [sha, `media/${sha}/source.m4a`, filename, durationMs],
    );
    return r.rows[0]!.id;
  }

  const defaults = { languageCode: 'my', providerId: 'google', model: 'chirp_2' };

  it('estimates without creating anything when confirm is false', async () => {
    const a = await makeAsset('01-daw-khin.m4a', 4_324_000);
    const b = await makeAsset('02-u-thein.m4a', 2_891_000);
    const input: IngestBatchInput = {
      batchKey: randomUUID(),
      project: { name: 'Election 2026' },
      defaults,
      items: [{ assetId: a }, { assetId: b }],
      confirm: false,
    };

    const result = await ingestBatch(ctx, input);

    expect(result.jobs).toEqual([]);
    // No project either: confirm:false must not have side effects, or a user who closes the
    // dialog leaves an empty project behind.
    expect(result.projectId).toBeNull();
    const projects = await test.db.$client.query('select 1 from projects');
    expect(projects.rowCount).toBe(0);

    expect(result.estimate.totalDurationMs).toBe(7_215_000);
    // 120.25 minutes at $0.016.
    expect(result.estimate.totalUsd).toBeCloseTo(1.924, 3);
    expect(result.estimate.rateSource).toBe('default');
  });

  it('lists an unpriced asset rather than hiding it in the total', async () => {
    const known = await makeAsset('has-duration.m4a', 600_000);
    const unknown = await makeAsset('no-duration.m4a', null);

    const result = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'Unpriced' },
      defaults,
      items: [{ assetId: known }, { assetId: unknown }],
      confirm: false,
    });

    expect(result.estimate.unpriced).toHaveLength(1);
    expect(result.estimate.unpriced[0]!.filename).toBe('no-duration.m4a');
    expect(result.estimate.unpriced[0]!.unpricedReason).toBe('unknown_duration');
    // The total covers only what could be priced, and the caller can see what it excluded.
    expect(result.estimate.totalUsd).toBeCloseTo(0.16, 3);
  });

  it('reports no_rate separately from unknown_duration', async () => {
    const asset = await makeAsset('unpriced-provider.m4a', 60_000);
    const result = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'No rate' },
      defaults: { ...defaults, providerId: 'nonexistent' },
      items: [{ assetId: asset }],
      confirm: false,
    });
    // A missing rate must never read as $0.00 — resolveRate returns null and it stays null.
    expect(result.estimate.unpriced[0]!.unpricedReason).toBe('no_rate');
    expect(result.estimate.items[0]!.usd).toBeNull();
    expect(result.estimate.rateSource).toBe('none');
  });

  it('creates one job per asset under one project on confirm', async () => {
    const a = await makeAsset('a.m4a', 60_000);
    const b = await makeAsset('b.m4a', 60_000);
    const result = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'Confirmed' },
      defaults,
      items: [{ assetId: a, title: 'Custom title' }, { assetId: b }],
      confirm: true,
    });

    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every((j) => j.created)).toBe(true);
    expect(result.jobs[0]!.title).toBe('Custom title');
    // Falls back to the filename when no title is given.
    expect(result.jobs[1]!.title).toBe('b.m4a');
  });

  it('is idempotent: the same batchKey replayed creates no duplicates', async () => {
    const a = await makeAsset('replay-a.m4a', 60_000);
    const b = await makeAsset('replay-b.m4a', 60_000);
    const input: IngestBatchInput = {
      batchKey: randomUUID(),
      project: { name: 'Replayed' },
      defaults,
      items: [{ assetId: a }, { assetId: b }],
      confirm: true,
    };

    const first = await ingestBatch(ctx, input);
    // A dropped connection at the confirm step is the case this exists for. Without the
    // partial unique index, this is twenty duplicate jobs and twenty duplicate bills.
    const second = await ingestBatch(ctx, input);

    expect(first.jobs.every((j) => j.created)).toBe(true);
    expect(second.jobs.every((j) => j.created)).toBe(false);
    expect(second.jobs.map((j) => j.id).sort()).toEqual(first.jobs.map((j) => j.id).sort());

    const count = await test.db.$client.query<{ n: string }>(
      'select count(*)::text as n from jobs where source_batch_key = $1',
      [input.batchKey],
    );
    expect(count.rows[0]!.n).toBe('2');
  });

  it('applies per-row overrides over the shared defaults', async () => {
    const a = await makeAsset('shared.m4a', 60_000);
    const b = await makeAsset('override.m4a', 60_000);
    const result = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'Overrides' },
      defaults,
      items: [{ assetId: a }, { assetId: b, languageCode: 'shn' }],
      confirm: true,
    });

    const rows = await test.db.$client.query<{ language_code: string; asset_id: string }>(
      'select language_code, asset_id from jobs where id = any($1)',
      [result.jobs.map((j) => j.id)],
    );
    const byAsset = new Map(rows.rows.map((r) => [r.asset_id, r.language_code]));
    // One shared language with exceptions — the alternative is twenty individual pickers.
    expect(byAsset.get(a)).toBe('my');
    expect(byAsset.get(b)).toBe('shn');
  });

  it('reuses a project by slug rather than creating a second one', async () => {
    const a = await makeAsset('p1.m4a', 60_000);
    const b = await makeAsset('p2.m4a', 60_000);
    const first = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'Election 2026' },
      defaults,
      items: [{ assetId: a }],
      confirm: true,
    });
    const second = await ingestBatch(ctx, {
      batchKey: randomUUID(),
      project: { name: 'election 2026' },
      defaults,
      items: [{ assetId: b }],
      confirm: true,
    });
    // Typed twice with different casing is one project, not two that differ invisibly.
    expect(second.projectId).toBe(first.projectId);
  });

  it('refuses an unknown asset id', async () => {
    await expect(
      ingestBatch(ctx, {
        batchKey: randomUUID(),
        project: { name: 'Bad' },
        defaults,
        items: [{ assetId: randomUUID() }],
        confirm: true,
      }),
    ).rejects.toThrow(/No such asset/);
  });
});
