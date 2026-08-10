import { describe, expect, it } from 'vitest';
import { createRegistry, resolveLanguage } from '../registry.js';
import { SCRIPTS } from '../generated/registry.gen.js';

describe('resolveLanguage', () => {
  it('merges script defaults under language overrides', () => {
    const my = resolveLanguage('my-MM')!;
    // Not cosmetic: Myanmar stacks diacritics vertically and clips at 1.5.
    expect(my.typography.lineHeight).toBe(1.9);
    expect(my.typography).toEqual({ ...SCRIPTS['Mymr']!.typography });
  });

  it('gives Burmese the scriptio-continua text rules', () => {
    const my = resolveLanguage('my')!;
    expect(my.text.wordSegmentation).toBe('none');
    expect(my.text.cerStripsWhitespace).toBe(true);
    // A whitespace-tokenized WER over Burmese is not a number anyone can compare.
    expect(my.text.reportWer).toBe(false);
    expect(my.direction).toBe('ltr');
    expect(my.scriptEntry.clusters).toBe('grapheme');
    expect(my.text.zawgyiApplies).toBe(true);
  });

  it('gives Pashto right-to-left and codepoint clusters', () => {
    const ps = resolveLanguage('ps-AF')!;
    expect(ps.direction).toBe('rtl');
    expect(ps.scriptEntry.complex).toBe(true);
    expect(ps.scriptEntry.clusters).toBe('codepoint');
    expect(ps.typography.fontFamily).toBe('Noto Naskh Arabic');
  });

  // The trap: Sindhi is written in Arabic script despite the -IN region tag. A region-based
  // guess gets Devanagari and every rendering and CER decision downstream is wrong.
  it('resolves sd-IN to Arabic script, not Devanagari', () => {
    expect(resolveLanguage('sd-IN')!.script).toBe('Arab');
    expect(resolveLanguage('sd-IN')!.direction).toBe('rtl');
  });

  it('records Serbian digraphia rather than picking a side', () => {
    const sr = resolveLanguage('sr-RS')!;
    expect(sr.script).toBe('Latn');
    expect(sr.altScripts).toContain('Cyrl');
  });

  it('returns null for an unknown code instead of throwing', () => {
    expect(resolveLanguage('xx-YY')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
  });
});

describe('language_support overrides', () => {
  it('beats the seeded tier', () => {
    expect(resolveLanguage('ha-NG')!.tier).toBe('experimental');
    const promoted = resolveLanguage('ha-NG', [{ code: 'ha-NG', tier: 'beta', cer: 0.15 }])!;
    expect(promoted.tier).toBe('beta');
    expect(promoted.support.cer).toBe(0.15);
  });

  it('can demote the one seeded verified language', () => {
    expect(resolveLanguage('my-MM')!.tier).toBe('verified');
    expect(resolveLanguage('my-MM', [{ code: 'my-MM', tier: 'beta' }])!.tier).toBe('beta');
  });

  it('is ignored, not thrown, when it names a code the registry does not have', () => {
    const registry = createRegistry([{ code: 'xx-YY', tier: 'verified' }]);
    expect(() => registry.get('my-MM')).not.toThrow();
    expect(registry.get('xx-YY')).toBeNull();
  });

  it('accepts an override keyed by any alias of the code', () => {
    expect(resolveLanguage('my-MM', [{ code: 'Burmese', tier: 'beta' }])!.tier).toBe('beta');
  });

  it('keeps the seeded notes when the override does not supply any', () => {
    const my = resolveLanguage('my-MM', [{ code: 'my-MM', cer: 0.02 }])!;
    expect(my.support.notes).toContain('operational use');
    expect(my.support.humanReviewed).toBe(true);
  });
});

describe('list', () => {
  it('returns every language sorted by code', () => {
    const all = createRegistry().list();
    expect(all.length).toBeGreaterThanOrEqual(116);
    expect(all.map((l) => l.code)).toEqual([...all.map((l) => l.code)].sort());
  });

  it('filters by tier, script and enabled', () => {
    const registry = createRegistry();
    expect(registry.list({ tier: ['verified'] }).map((l) => l.code)).toEqual(['my-MM']);
    expect(registry.list({ script: 'Arab' }).map((l) => l.code)).toContain('ps-AF');
    expect(registry.list({ script: 'Arab' }).every((l) => l.direction === 'rtl')).toBe(true);
    expect(registry.list({ enabledOnly: true }).length).toBe(registry.list().length);
  });

  it('honours a disabling override', () => {
    const registry = createRegistry([{ code: 'ha-NG', enabled: false }]);
    expect(registry.list({ enabledOnly: true }).map((l) => l.code)).not.toContain('ha-NG');
    expect(registry.list().map((l) => l.code)).toContain('ha-NG');
  });
});
