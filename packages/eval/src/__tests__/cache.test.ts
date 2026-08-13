import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clipHashOf,
  paramsHashOf,
  responseKey,
  ResponseCache,
  textHashOf,
} from '../cache.js';

const base = {
  provider: 'google',
  model: 'chirp_2',
  lang: 'my-MM',
  clipHash: 'sha256:aaa',
  paramsHash: 'bbb',
};

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('leaves array order alone, because order is meaning there', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined values rather than emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(3)).toBe('3');
  });
});

describe('responseKey', () => {
  it('changes when any component changes', () => {
    const key = responseKey(base);
    for (const field of ['provider', 'model', 'lang', 'clipHash', 'paramsHash'] as const) {
      expect(responseKey({ ...base, [field]: 'different' })).not.toBe(key);
    }
  });

  it('is stable across runs for identical input', () => {
    expect(responseKey(base)).toBe(responseKey({ ...base }));
  });
});

describe('paramsHashOf', () => {
  /**
   * The single assertion the CI gate leans on: a bumped prompt has to be a genuine cache
   * miss, or the gate passes on numbers the previous prompt produced.
   */
  it('changes when promptVersion changes', () => {
    const a = paramsHashOf({ promptId: 'cleanup', promptVersion: 1, temperature: 0 });
    const b = paramsHashOf({ promptId: 'cleanup', promptVersion: 2, temperature: 0 });
    expect(a).not.toBe(b);
  });

  it('is stable across key-order permutations of the same params', () => {
    const a = paramsHashOf({ temperature: 0, promptId: 'x', promptVersion: 1 });
    const b = paramsHashOf({ promptVersion: 1, promptId: 'x', temperature: 0 });
    expect(a).toBe(b);
  });

  it('distinguishes nested differences', () => {
    expect(paramsHashOf({ a: { b: 1 } })).not.toBe(paramsHashOf({ a: { b: 2 } }));
  });
});

describe('content hashes', () => {
  it('hashes clip bytes, so a re-download is still a hit', () => {
    expect(clipHashOf(Buffer.from('abc'))).toBe(clipHashOf(Buffer.from('abc')));
    expect(clipHashOf(Buffer.from('abc'))).not.toBe(clipHashOf(Buffer.from('abd')));
    expect(clipHashOf(Buffer.from('abc')).startsWith('sha256:')).toBe(true);
  });

  it('hashes text exactly, including whitespace', () => {
    expect(textHashOf('a b')).not.toBe(textHashOf('a  b'));
  });
});

describe('ResponseCache', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thibi-respcache-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const now = new Date('2026-08-13T00:00:00Z');

  it('round-trips a value', async () => {
    const cache = new ResponseCache(dir);
    await cache.set('key-one', { text: 'hello' }, now);
    expect(await cache.get<{ text: string }>('key-one')).toEqual({ text: 'hello' });
  });

  it('returns null for a key it has never seen', async () => {
    expect(await new ResponseCache(dir).get('absent')).toBeNull();
  });

  /**
   * `--no-cache` forces fresh responses; it does not throw them away. A run that refetched
   * and then discarded would make the *next* run expensive too, which nobody passing the
   * flag is asking for.
   */
  it('bypasses reads but still writes when read is disabled', async () => {
    const writing = new ResponseCache(dir, { read: false });
    await writing.set('key-two', { text: 'stored anyway' }, now);
    expect(await writing.get('key-two')).toBeNull();
    expect(await new ResponseCache(dir).get<{ text: string }>('key-two')).toEqual({
      text: 'stored anyway',
    });
  });

  it('survives a corrupt entry rather than failing the run', async () => {
    const cache = new ResponseCache(dir);
    await cache.set('key-three', { text: 'x' }, now);
    // A truncated write from a killed process must read as a miss, not an exception.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'resp', 'ke', 'key-three.json'), '{ not json', 'utf8');
    expect(await cache.get('key-three')).toBeNull();
  });
});
