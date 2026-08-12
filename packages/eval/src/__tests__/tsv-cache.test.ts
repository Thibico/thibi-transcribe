import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTsv, NoEvalSetError } from '../fleurs/tsv.js';

/**
 * The cache is keyed by blob oid *in the filename*. This suite is the reason: it asserts
 * that a warm cache costs exactly one tree call and zero resolve calls, which is what keeps
 * a 107-language sweep inside HuggingFace's 3000-resolver-hits-per-5-minutes budget.
 */

const TSV = '1\ta.wav\traw one\tplain one\tg r a\t16000\tMALE\n';
const TSV_V2 = '1\ta.wav\traw two\tplain two\tg r a\t16000\tFEMALE\n';

interface Call {
  kind: 'tree' | 'resolve';
  url: string;
}

function stubFetch(oid: string, body: string, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/')) {
      calls.push({ kind: 'tree', url });
      return new Response(
        JSON.stringify([
          { type: 'file', oid, size: body.length, path: 'data/my_mm/dev.tsv' },
          { type: 'file', oid: 'aaa', size: 1, path: 'data/my_mm/audio/dev.tar.gz' },
        ]),
        { status: 200 },
      );
    }
    calls.push({ kind: 'resolve', url });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('loadTsv oid-keyed cache', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thibi-eval-tsv-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads once, then serves from disk with zero resolve calls', async () => {
    const calls: Call[] = [];
    const f = stubFetch('oid-v1', TSV, calls);

    const first = await loadTsv(dir, 'my_mm', 'dev', f);
    expect(first.oid).toBe('oid-v1');
    expect(first.rows[0]!.raw).toBe('raw one');
    expect(calls.filter((c) => c.kind === 'resolve')).toHaveLength(1);

    const second = await loadTsv(dir, 'my_mm', 'dev', f);
    expect(second.rows[0]!.raw).toBe('raw one');

    // The load-bearing assertion: revalidation is one tree call for the whole config, and
    // the TSV itself is never re-fetched while its oid is unchanged.
    expect(calls.filter((c) => c.kind === 'resolve')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'tree')).toHaveLength(2);
  });

  it('re-downloads when the oid changes, and leaves the old file on disk', async () => {
    const calls: Call[] = [];
    const updated = await loadTsv(dir, 'my_mm', 'dev', stubFetch('oid-v2', TSV_V2, calls));

    expect(updated.oid).toBe('oid-v2');
    expect(updated.rows[0]!.raw).toBe('raw two');
    expect(calls.filter((c) => c.kind === 'resolve')).toHaveLength(1);

    // Both generations remain: a changed oid is a plain cache miss, not an eviction, so a
    // stale file is garbage-collectable by pattern rather than lost mid-run.
    const files = await readdir(join(dir, 'fleurs', 'my_mm'));
    expect(files.sort()).toEqual(['dev.oid-v1.tsv', 'dev.oid-v2.tsv']);
  });

  it('raises NoEvalSetError for a config the tree does not have', async () => {
    const calls: Call[] = [];
    const f = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    await expect(loadTsv(dir, 'xx_xx', 'dev', f)).rejects.toBeInstanceOf(NoEvalSetError);
    expect(calls).toHaveLength(0);
  });

  it('raises NoEvalSetError when the tree exists but holds no such split', async () => {
    const f = (async (input: string | URL | Request) => {
      if (String(input).includes('/api/')) {
        return new Response(
          JSON.stringify([{ type: 'file', oid: 'x', size: 1, path: 'data/my_mm/test.tsv' }]),
          { status: 200 },
        );
      }
      throw new Error('must not resolve when the split is absent');
    }) as unknown as typeof fetch;
    await expect(loadTsv(dir, 'my_mm', 'dev', f)).rejects.toBeInstanceOf(NoEvalSetError);
  });
});
