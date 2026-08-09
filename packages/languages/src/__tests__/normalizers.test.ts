import { describe, expect, it } from 'vitest';
import { applyNormalizers, normalizeText, normalizerContext } from '../normalizers/index.js';
import { resolveLanguage } from '../registry.js';

const my = resolveLanguage('my-MM')!;
const si = resolveLanguage('si-LK')!;
const ps = resolveLanguage('ps-AF')!;

describe('normalizers', () => {
  it('applies NFC before anything else compares strings', () => {
    // Decomposed e + combining acute vs precomposed é.
    expect(normalizeText('é', resolveLanguage('fr-FR')!)).toBe('é');
  });

  it('always strips ZWSP and the BOM', () => {
    expect(normalizeText('a​b﻿c', resolveLanguage('en-US')!)).toBe('abc');
  });

  it('strips ZWNJ and ZWJ in Myanmar, where they are layout noise', () => {
    expect(normalizeText('က‌ခ‍ဂ', my)).toBe('ကခဂ');
  });

  it('keeps ZWNJ and ZWJ in Sinhala, where they are semantic', () => {
    // Stripping these changes which conjunct the renderer produces — it changes the word.
    const out = normalizeText('ක‍ර', si);
    expect(out).toContain('‍');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a   b \n c  ', resolveLanguage('en-US')!)).toBe('a b c');
  });

  it('folds both Arabic-Indic digit sets to Latin when asked', () => {
    const ctx = { ...normalizerContext(ps), digitPolicy: 'latin' as const };
    // Arabic-Indic (U+0660) and Extended Arabic-Indic (U+06F0). A single-set table would
    // leave one of them untouched, which is the bug this shape exists to prevent.
    expect(applyNormalizers('٢٠٢٦ و ۲۰۲۶', ['digits'], ctx)).toBe('2026 و 2026');
  });

  it('emits the preferred native set in the other direction', () => {
    const ctx = { ...normalizerContext(ps), digitPolicy: 'native' as const };
    expect(applyNormalizers('2026', ['digits'], ctx)).toBe('٢٠٢٦');
  });

  it('leaves digits alone under the default preserve policy', () => {
    expect(normalizeText('٢٠٢٦', ps)).toBe('٢٠٢٦');
  });

  it('refuses to run zawgyi in the segment-text chain', () => {
    // Zawgyi conversion is not length-preserving. Running it here would desynchronise the
    // word timings that half the design depends on, so it fails loudly instead.
    expect(() => applyNormalizers('က', ['zawgyi'], normalizerContext(my))).toThrow(
      /not\s+length-preserving/,
    );
  });

  it('flags Burmese as needing zawgyi handling without putting it in the chain', () => {
    expect(my.text.zawgyiApplies).toBe(true);
    expect(my.text.normalizers).not.toContain('zawgyi');
  });
});
