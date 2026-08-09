import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOffsetMs, parseRecognizeResponse, type RecognizeResponse } from '../parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = (name: string): RecognizeResponse =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as RecognizeResponse;

const opts = { offsetMs: 0, durationMs: 55_000 };

describe('parseOffsetMs', () => {
  it('parses the string duration form', () => {
    expect(parseOffsetMs('1.500s')).toBe(1500);
    expect(parseOffsetMs('0.120s')).toBe(120);
    expect(parseOffsetMs('12s')).toBe(12_000);
  });

  it('parses the protobuf-JSON object form identically', () => {
    // Sync uses the string form; batch output has historically differed, and adding this
    // branch now costs nothing while discovering it in Phase 2 would be expensive.
    expect(parseOffsetMs({ seconds: 1, nanos: 500_000_000 })).toBe(1500);
    expect(parseOffsetMs({ seconds: 0, nanos: 120_000_000 })).toBe(120);
    expect(parseOffsetMs({ seconds: 12 })).toBe(12_000);
  });

  it('returns null for absent or unparseable input, never 0', () => {
    // 0 and "unknown" are different facts: one is the start of the chunk.
    expect(parseOffsetMs(undefined)).toBeNull();
    expect(parseOffsetMs('abc')).toBeNull();
  });
});

describe('parseRecognizeResponse', () => {
  it('keeps every word rather than using them for bounds', () => {
    // The change the overview singles out. google.ts:207-221 read the first and last
    // offsets and threw the array away.
    const result = parseRecognizeResponse(load('recognize-my-full.json'), opts);
    const words = result.segments.flatMap((s) => s.words);
    expect(words).toHaveLength(7);
    expect(words[0]).toMatchObject({ startMs: 120, endMs: 410, text: 'အာဆီယံ' });
    expect(words[0]!.confidence).toBeCloseTo(0.9731);
  });

  it('derives segment bounds from the first and last word', () => {
    const [first] = parseRecognizeResponse(load('recognize-my-full.json'), opts).segments;
    expect(first).toMatchObject({ startMs: 120, endMs: 1500 });
  });

  it('applies offsetMs to every word and segment timestamp', () => {
    const result = parseRecognizeResponse(load('recognize-my-full.json'), {
      offsetMs: 60_000,
      durationMs: 55_000,
    });
    expect(result.segments[0]!.startMs).toBe(60_120);
    expect(result.segments[0]!.words[0]!.startMs).toBe(60_120);
    expect(result.segments.at(-1)!.endMs).toBe(62_950);
  });

  it('reports word confidence as null, not 0, when the provider gives none', () => {
    // Writing 0 would make every word from such a provider sort as maximally uncertain
    // and the low-confidence QA query return the entire transcript.
    const result = parseRecognizeResponse(load('recognize-no-word-confidence.json'), opts);
    for (const word of result.segments.flatMap((s) => s.words)) {
      expect(word.confidence).toBeNull();
    }
    // Timings are still real, so the quality is still full.
    expect(result.wordTimingQuality).toBe('full');
  });

  it('handles {seconds,nanos} offsets identically to the string form', () => {
    const result = parseRecognizeResponse(load('recognize-nanos-offsets.json'), opts);
    expect(result.segments[0]!.words.map((w) => [w.startMs, w.endMs])).toEqual([
      [120, 410],
      [1500, 2000],
    ]);
  });

  describe('wordTimingQuality', () => {
    it('is full when every segment has words', () => {
      expect(parseRecognizeResponse(load('recognize-my-full.json'), opts).wordTimingQuality).toBe(
        'full',
      );
    });

    it('is none when no segment has words, and warns', () => {
      const result = parseRecognizeResponse(load('recognize-no-words.json'), opts);
      expect(result.wordTimingQuality).toBe('none');
      expect(result.segments).toHaveLength(2);
      expect(result.segments.every((s) => s.words.length === 0)).toBe(true);
      expect(result.warnings.map((w) => w.code)).toContain('no_word_timings');
    });

    it('is partial when only some segments have words', () => {
      const result = parseRecognizeResponse(load('recognize-partial-words.json'), opts);
      expect(result.wordTimingQuality).toBe('partial');
      expect(result.warnings.map((w) => w.code)).toContain('no_word_timings');
    });
  });

  it('bounds a wordless segment by resultEndOffset and chains from the previous end', () => {
    const result = parseRecognizeResponse(load('recognize-no-words.json'), opts);
    expect(result.segments[0]).toMatchObject({ startMs: 0, endMs: 2400 });
    expect(result.segments[1]).toMatchObject({ startMs: 2400, endMs: 4100 });
  });

  it('falls back to the chunk end and warns when there is no timing at all', () => {
    const body: RecognizeResponse = {
      results: [{ alternatives: [{ transcript: 'no timing anywhere' }] }],
    };
    const result = parseRecognizeResponse(body, { offsetMs: 1000, durationMs: 5000 });
    expect(result.segments[0]).toMatchObject({ startMs: 1000, endMs: 6000 });
    expect(result.warnings.map((w) => w.code)).toContain('segment_without_timing');
  });

  it('produces no segments and no warning for an empty response', () => {
    const result = parseRecognizeResponse(load('recognize-empty.json'), opts);
    expect(result.segments).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.wordTimingQuality).toBe('none');
  });

  it('skips a segment whose transcript is empty', () => {
    const body: RecognizeResponse = {
      results: [{ alternatives: [{ transcript: '   ' }] }],
    };
    expect(parseRecognizeResponse(body, opts).segments).toEqual([]);
  });

  it('reports usage from the request, not the response', () => {
    const result = parseRecognizeResponse(load('recognize-my-full.json'), opts);
    expect(result.usage).toEqual({ audioMs: 55_000, requests: 1 });
  });
});
