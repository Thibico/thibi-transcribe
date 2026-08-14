import { describe, expect, it } from 'vitest';
import { parseSegmentsResponse } from '../llm/parse.js';

describe('parseSegmentsResponse', () => {
  it('reads the contract shape', () => {
    const out = parseSegmentsResponse('{"segments":[{"idx":0,"text":"Ga wannan."}]}');
    expect(out?.get(0)).toBe('Ga wannan.');
  });

  it('unwraps a code fence, which is the one deviation models actually make', () => {
    const out = parseSegmentsResponse('```json\n{"segments":[{"idx":0,"text":"x"}]}\n```');
    expect(out?.get(0)).toBe('x');
  });

  it('accepts a bare array', () => {
    expect(parseSegmentsResponse('[{"idx":2,"text":"y"}]')?.get(2)).toBe('y');
  });

  it('keys on idx and not on position', () => {
    const out = parseSegmentsResponse('{"segments":[{"idx":7,"text":"a"},{"idx":3,"text":"b"}]}');
    expect(out?.get(7)).toBe('a');
    expect(out?.get(3)).toBe('b');
  });

  it('keeps the first of a duplicated idx', () => {
    // There is no way to tell which of two answers for the same segment the model meant, and
    // taking the last one silently prefers whichever it wrote second.
    expect(parseSegmentsResponse('[{"idx":0,"text":"a"},{"idx":0,"text":"b"}]')?.get(0)).toBe('a');
  });

  it('returns null rather than the input when the reply is prose', () => {
    // The failure this guards: falling back to the input would score the segment identically
    // to the `control` arm, so a model returning prose for everything would come out level
    // with doing nothing instead of visibly failing.
    expect(parseSegmentsResponse('I cannot help with that.')).toBeNull();
    expect(parseSegmentsResponse('')).toBeNull();
    expect(parseSegmentsResponse('{"segments":[{"idx":0,"text":42}]}')).toBeNull();
    expect(parseSegmentsResponse('{"segments":[]}')).toBeNull();
  });
});
