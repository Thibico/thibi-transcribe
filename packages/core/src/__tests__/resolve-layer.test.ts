import { describe, expect, it } from 'vitest';
import { resolveLayer } from '../layers/resolve.js';
import type { SegmentText } from '../types.js';

const t = (layer: SegmentText['layer'], targetLang: string, text: string): SegmentText => ({
  segmentId: 's1',
  layer,
  targetLang,
  origin: layer === 'verbatim' ? 'asr' : 'llm',
  text,
});

const VERBATIM = t('verbatim', '', 'ASR output');
const CLEANED = t('cleaned', '', 'Cleaned output.');
const EN = t('translated', 'en', 'English translation');
const FR = t('translated', 'fr', 'Traduction française');

describe('resolveLayer', () => {
  it('returns the requested layer when it exists', () => {
    const got = resolveLayer([VERBATIM, CLEANED], { layer: 'cleaned' });
    expect(got).toMatchObject({ text: 'Cleaned output.', layer: 'cleaned', isFallback: false });
  });

  it('distinguishes translations by target language', () => {
    expect(resolveLayer([EN, FR], { layer: 'translated', targetLang: 'fr' })?.text).toBe(
      'Traduction française',
    );
    expect(resolveLayer([EN, FR], { layer: 'translated', targetLang: 'en' })?.text).toBe(
      'English translation',
    );
  });

  it('falls back through the chain in order', () => {
    const got = resolveLayer([VERBATIM, CLEANED], { layer: 'translated', targetLang: 'en' }, [
      { layer: 'cleaned' },
    ]);
    expect(got).toMatchObject({ text: 'Cleaned output.', layer: 'cleaned', isFallback: true });
  });

  /**
   * Verbatim is the terminal fallback and Phase 1 guarantees it exists — persist writes one
   * `(verbatim, '', asr)` row per segment precisely so this path never needs a special case
   * for "the ASR text actually lives on the segments table".
   */
  it('falls back to verbatim without being asked', () => {
    const got = resolveLayer([VERBATIM], { layer: 'translated', targetLang: 'en' });
    expect(got).toMatchObject({ text: 'ASR output', layer: 'verbatim', isFallback: true });
  });

  it('marks a fallback so a caller can say the export is not what was asked for', () => {
    expect(resolveLayer([VERBATIM], { layer: 'cleaned' })!.isFallback).toBe(true);
    expect(resolveLayer([VERBATIM], { layer: 'verbatim' })!.isFallback).toBe(false);
  });

  it('returns null when nothing at all exists', () => {
    expect(resolveLayer([], { layer: 'verbatim' })).toBeNull();
  });

  it('does not confuse a translation with the same-named base layer', () => {
    // ('translated','') must never satisfy a request for ('translated','en').
    const stray = t('translated', '', 'should be impossible');
    expect(resolveLayer([stray], { layer: 'translated', targetLang: 'en' })).toBeNull();
  });
});
