import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  postgresReachable,
  DEFAULT_TEST_DATABASE_URL,
  type TestDb,
} from '../testing.js';
import { copyWords } from '../copy.js';
import { jobs, mediaAssets, runs, segments, segmentTexts, words } from '../schema/index.js';

/**
 * Constraint tests against a real Postgres.
 *
 * These are the assertions a mock cannot make. Partial unique indexes, CHECK constraints
 * and COPY escaping either work in the database or they do not, and every one of them here
 * guards a decision that would fail silently rather than loudly if it were wrong.
 */

const BASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const reachable = await postgresReachable(BASE_URL);
if (!reachable) {
  console.warn(
    `\n  [db] Postgres not reachable at ${BASE_URL} — skipping constraint tests.` +
      `\n  Start it with: docker compose -f infra/compose.dev.yml up -d\n`,
  );
}

/**
 * Assert that a statement was rejected by a specific database constraint.
 *
 * Drizzle wraps the driver error in a `DrizzleQueryError`, so the SQLSTATE lives on
 * `.cause`. Asserting the *constraint name* as well as the code is deliberate: `23505`
 * only says some unique index fired, and these tests exist to prove that the particular
 * partial index — the one whose WHERE clause is easy to get wrong — is the one that did.
 */
async function expectViolation(
  promise: Promise<unknown>,
  code: '23505' | '23514',
  constraint: string,
): Promise<void> {
  let raised: unknown;
  try {
    await promise;
  } catch (err) {
    raised = err;
  }
  expect(raised, 'expected the statement to be rejected, but it succeeded').toBeDefined();
  const cause = (raised as { cause?: { code?: string; constraint?: string } }).cause ?? raised;
  expect(cause).toMatchObject({ code, constraint });
}

describe.skipIf(!reachable)('schema constraints', () => {
  let t: TestDb;
  let runId: string;

  beforeAll(async () => {
    t = await createTestDb(BASE_URL);
    const [asset] = await t.db
      .insert(mediaAssets)
      .values({ sha256: 'a'.repeat(64), storageKey: 'assets/aa/x/source.m4a', filename: 'x.m4a', bytes: 1 })
      .returning();
    const [job] = await t.db
      .insert(jobs)
      .values({ assetId: asset!.id, title: 'x', languageCode: 'my-MM' })
      .returning();
    const [run] = await t.db
      .insert(runs)
      .values({
        jobId: job!.id,
        providerId: 'google',
        model: 'chirp_2',
        languageCode: 'my-MM',
        mode: 'sync_chunked',
        engineVersion: '0.1.0',
      })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    await t?.drop();
  });

  async function makeSegment(idx: number) {
    const [seg] = await t.db
      .insert(segments)
      .values({ runId, idx, startMs: idx * 1000, endMs: idx * 1000 + 900, text: 't', textRaw: 't' })
      .returning();
    return seg!;
  }

  it('rejects a second live segment at the same (run, idx)', async () => {
    const seg = await makeSegment(100);
    await expectViolation(
      t.db.insert(segments).values({
        runId,
        idx: 100,
        startMs: 0,
        endMs: 1,
        text: 'dup',
        textRaw: 'dup',
      }),
      '23505',
      'segments_run_idx_live',
    );

    // Superseding the first frees the slot: superseded rows are history, not conflicts.
    await t.db
      .update(segments)
      .set({ supersededAt: new Date() })
      .where(sql`${segments.id} = ${seg.id}`);
    await expect(
      t.db
        .insert(segments)
        .values({ runId, idx: 100, startMs: 0, endMs: 1, text: 'new', textRaw: 'new' }),
    ).resolves.toBeDefined();
  });

  it('rejects an inverted segment interval', async () => {
    await expectViolation(
      t.db
        .insert(segments)
        .values({ runId, idx: 200, startMs: 500, endMs: 100, text: 'x', textRaw: 'x' }),
      '23514',
      'segments_interval',
    );
  });

  /**
   * The NULL-uniqueness trap, asserted.
   *
   * `target_lang` is NOT NULL with a `''` default precisely because a partial unique index
   * over a NULLable column enforces nothing — `NULL <> NULL` in Postgres, so every row
   * would be distinct. This would never show up in a test that only inserts translations.
   */
  it('rejects a second live verbatim row for the same segment', async () => {
    const seg = await makeSegment(300);
    await t.db
      .insert(segmentTexts)
      .values({ segmentId: seg.id, runId, layer: 'verbatim', origin: 'asr', text: 'first' });

    await expectViolation(
      t.db
        .insert(segmentTexts)
        .values({ segmentId: seg.id, runId, layer: 'verbatim', origin: 'human', text: 'second' }),
      '23505',
      'segment_texts_live',
    );
  });

  it('allows one row per target language and supersession for edits', async () => {
    const seg = await makeSegment(301);
    await t.db.insert(segmentTexts).values([
      { segmentId: seg.id, runId, layer: 'translated', targetLang: 'en', origin: 'llm', text: 'en' },
      { segmentId: seg.id, runId, layer: 'translated', targetLang: 'fr', origin: 'llm', text: 'fr' },
    ]);
    // N target languages = N rows, never new columns.
    await expectViolation(
      t.db.insert(segmentTexts).values({
        segmentId: seg.id,
        runId,
        layer: 'translated',
        targetLang: 'en',
        origin: 'human',
        text: 'edited',
      }),
      '23505',
      'segment_texts_live',
    );
  });

  it('requires a translation to name its target, and forbids others from naming one', async () => {
    const seg = await makeSegment(302);
    await expectViolation(
      t.db
        .insert(segmentTexts)
        .values({ segmentId: seg.id, runId, layer: 'translated', origin: 'llm', text: 'x' }),
      '23514',
      'segment_texts_lang',
    );

    await expectViolation(
      t.db.insert(segmentTexts).values({
        segmentId: seg.id,
        runId,
        layer: 'cleaned',
        targetLang: 'en',
        origin: 'llm',
        text: 'x',
      }),
      '23514',
      'segment_texts_lang',
    );
  });

  it('rejects a chunk whose content start is outside its extracted range', async () => {
    await expectViolation(
      t.db.execute(sql`
        insert into run_chunks (run_id, idx, offset_ms, content_start_ms, end_ms)
        values (${runId}, 900, 5000, 1000, 9000)
      `),
      '23514',
      'run_chunks_interval',
    );
  });

  describe('copyWords', () => {
    it('bulk-inserts and round-trips text that would break naive escaping', async () => {
      const seg = await makeSegment(400);
      const client = await t.db.$client.connect();
      try {
        const inserted = await copyWords(client, [
          { segmentId: seg.id, runId, idx: 0, startMs: 0, endMs: 100, text: 'plain', confidence: 0.9 },
          // A literal tab, backslash and newline in provider output are not hypothetical,
          // and mis-escaping any of them shifts every subsequent column silently.
          { segmentId: seg.id, runId, idx: 1, startMs: 100, endMs: 200, text: 'a\tb\\c\nd', confidence: null },
          { segmentId: seg.id, runId, idx: 2, startMs: 200, endMs: 300, text: 'မင်္ဂလာပါ', confidence: 0.42 },
        ]);
        expect(inserted).toBe(3);
      } finally {
        client.release();
      }

      const rows = await t.db
        .select()
        .from(words)
        .where(sql`${words.segmentId} = ${seg.id}`)
        .orderBy(words.idx);
      expect(rows.map((r) => r.text)).toEqual(['plain', 'a\tb\\c\nd', 'မင်္ဂလာပါ']);
      // NULL, never 0 — an unknown confidence must not sort as maximally uncertain.
      expect(rows[1]!.confidence).toBeNull();
      expect(rows[0]!.confidence).toBeCloseTo(0.9);
    });

    // 90 s, not 30 s. This test measured 25.2 s and 28.9 s in full runs on 2026-08-10 — inside
    // the old limit, but only just, and it shares a Postgres with every other DB-backed suite.
    // Phase 8 added one more and that was enough to tip it over. The number is a guard against a
    // hang, not a performance assertion: a COPY that has genuinely regressed shows up as a
    // timing change in CI, whereas a limit set a few seconds above the observed cost fails for
    // whoever next adds a test, on a machine that is simply busier.
    it('inserts 30k rows and answers the low-confidence query from the partial index', { timeout: 90_000 }, async () => {
      const seg = await makeSegment(401);
      const rows = Array.from({ length: 30_000 }, (_, i) => ({
        segmentId: seg.id,
        runId,
        idx: i,
        startMs: i * 10,
        endMs: i * 10 + 9,
        text: `w${i}`,
        // ~1 in 100 uncertain, which is the shape the QA toolbar actually queries.
        confidence: i % 100 === 0 ? 0.2 : 0.95,
      }));

      const client = await t.db.$client.connect();
      try {
        expect(await copyWords(client, rows)).toBe(30_000);
      } finally {
        client.release();
      }

      await t.db.execute(sql`analyze words`);
      const plan = await t.db.execute(sql`
        explain (format text)
        select id from words where run_id = ${runId} and confidence < 0.5 order by start_ms
      `);
      const text = JSON.stringify(plan.rows);
      // "38 uncertain words" must not be a sequential scan of 10M rows.
      expect(text).toContain('words_low_conf');
    });
  });
});
