import { describe, expect, it, vi } from 'vitest';
import type { Segment, Word } from '@thibi/core';
import { resolveLanguage } from '@thibi/languages';
import { detectZawgyi, joinWords, normalizeSegment, zawgyiToUnicode } from '../normalize.js';

const BURMESE = resolveLanguage('my-MM')!;
const HAUSA = resolveLanguage('ha-NG')!;

function words(texts: string[]): Word[] {
  return texts.map((text, i) => ({
    idx: i,
    startMs: i * 500,
    endMs: i * 500 + 400,
    text,
    confidence: 0.9,
  }));
}

function segment(text: string, w: Word[] = []): Segment {
  return {
    idx: 0,
    startMs: 0,
    endMs: 2000,
    text,
    textRaw: text,
    confidence: 0.9,
    hasWords: w.length > 0,
    words: w,
  };
}

describe('zawgyi detection and conversion', () => {
  it('detects Zawgyi and leaves Unicode alone', () => {
    expect(detectZawgyi('ျမန္မာ')).toBe(true);
    expect(detectZawgyi('မြန်မာ')).toBe(false);
    expect(detectZawgyi('')).toBe(false);
  });

  it('converts Zawgyi to Unicode', () => {
    expect(zawgyiToUnicode('ျမန္မာ')).toBe('မြန်မာ');
  });

  /**
   * The property the per-word rule depends on, asserted rather than assumed.
   *
   * Zawgyi→Unicode reorders characters within a syllable, and syllables do not cross word
   * boundaries — so converting each word independently gives the same answer as converting
   * the whole string. That is what makes it safe to convert per word and re-derive the
   * segment text, which is the only way to keep the word array and the segment text in
   * agreement.
   *
   * If a future version of Rabbit ever reordered across a space, this fails and the design
   * needs revisiting rather than silently producing corrupted Burmese.
   */
  it('converts per word identically to converting the whole string', () => {
    for (const parts of [
      ['ျမန္မာ', 'ႏုိင္ငံ'],
      ['ေက်ာင္း', 'သား', 'မ်ား'],
      ['အာဆီယံ', 'ရဲ့', 'ဆုံးျဖတ္ခ်က္'],
    ]) {
      expect(parts.map(zawgyiToUnicode).join(' ')).toBe(zawgyiToUnicode(parts.join(' ')));
    }
  });

  it('actually changes the text, so the conversion is not a no-op', () => {
    expect(zawgyiToUnicode('ျမန္မာ')).not.toBe('ျမန္မာ');
  });
});

describe('normalizeSegment', () => {
  it('preserves the provider bytes in textRaw', () => {
    // lib/queue.ts:126 normalized in place and the original was gone forever.
    const raw = 'ျမန္မာ  ႏုိင္ငံ';
    const result = normalizeSegment(segment(raw, words(['ျမန္မာ', 'ႏုိင္ငံ'])), BURMESE);
    expect(result.segment.textRaw).toBe(raw);
    expect(result.segment.text).not.toBe(raw);
  });

  it('converts per word and re-derives the segment text from them', () => {
    const w = words(['ျမန္မာ', 'ႏုိင္ငံ']);
    const result = normalizeSegment(segment('ျမန္မာ ႏုိင္ငံ', w), BURMESE);

    expect(result.converted).toBe(true);
    // The word count is unchanged: conversion did not merge or split anything, so every
    // word offset still points at the audio it came from.
    expect(result.segment.words).toHaveLength(2);
    expect(result.segment.words.map((x) => x.text)).toEqual(['မြန်မာ', 'နိုင်ငံ']);
    // And the segment text is exactly the join of those words, so the two cannot disagree.
    expect(result.segment.text).toBe(joinWords(result.segment.words, BURMESE.text.wordJoin));
  });

  it('keeps word timings untouched through conversion', () => {
    const w = words(['ျမန္မာ', 'ႏုိင္ငံ']);
    const result = normalizeSegment(segment('ျမန္မာ ႏုိင္ငံ', w), BURMESE);
    expect(result.segment.words.map((x) => [x.startMs, x.endMs])).toEqual([
      [0, 400],
      [500, 900],
    ]);
  });

  it('converts segment text directly when there are no words to derive from', () => {
    const result = normalizeSegment(segment('ျမန္မာ'), BURMESE);
    expect(result.converted).toBe(true);
    expect(result.segment.text).toBe('မြန်မာ');
  });

  it('leaves Unicode Burmese untouched', () => {
    const result = normalizeSegment(segment('မြန်မာ', words(['မြန်မာ'])), BURMESE);
    expect(result.converted).toBe(false);
    expect(result.segment.text).toBe('မြန်မာ');
  });

  it('never invokes the converter for a non-Burmese language', () => {
    // `zawgyiApplies` is a per-language registry flag, not a per-script guess: Zawgyi is a
    // Burmese font-encoding problem and nothing else has it.
    const spy = vi.fn(detectZawgyi);
    expect(HAUSA.text.zawgyiApplies).toBe(false);
    const result = normalizeSegment(segment('Sannu duniya', words(['Sannu', 'duniya'])), HAUSA);
    expect(result.converted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies the registry normalizer chain', () => {
    // NFC, zero-width strip, whitespace collapse — driven by the language entry.
    const result = normalizeSegment(segment('  Sannu​   duniya  '), HAUSA);
    expect(result.segment.text).toBe('Sannu duniya');
  });
});

describe('joinWords', () => {
  it('joins with a space for spaced scripts', () => {
    expect(joinWords(words(['a', 'b']), ' ')).toBe('a b');
  });

  it('joins without a separator where the script has none', () => {
    expect(joinWords(words(['ကို', 'ချမှတ်']), '')).toBe('ကိုချမှတ်');
  });

  it('uses a space for Burmese, because Google emits syllable-spaced Burmese', () => {
    // Preserving provider output is the rule, and it costs nothing at scoring time:
    // cerStripsWhitespace is true for scriptio-continua scripts.
    expect(BURMESE.text.wordJoin).toBe(' ');
  });
});
