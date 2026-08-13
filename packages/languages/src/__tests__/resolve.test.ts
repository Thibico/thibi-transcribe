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

/**
 * A language the harness has never measured, so its resolved tier is the seeded one however
 * the last sweep went. Using a measured code here — this file used `ha-NG` — makes an
 * override test fail the day somebody measures that language, which is what happened on
 * 2026-08-13.
 */
const UNMEASURED = 'af-ZA';

describe('language_support overrides', () => {
  it('beats the seeded tier', () => {
    expect(resolveLanguage(UNMEASURED)!.tier).toBe('experimental');
    const promoted = resolveLanguage(UNMEASURED, [{ code: UNMEASURED, tier: 'beta', cer: 0.15 }])!;
    expect(promoted.tier).toBe('beta');
    expect(promoted.support.cer).toBe(0.15);
    expect(promoted.tierSource).toBe('override');
  });

  it('beats a measurement too, and says which it was', () => {
    // The precedence that matters for risk 9: an admin who has validated a language on
    // their own material outranks the harness, and the UI can tell the two apart.
    const measured = resolveLanguage('yo-NG')!;
    expect(measured.tierSource).toBe('measured');
    const promoted = resolveLanguage('yo-NG', [{ code: 'yo-NG', tier: 'beta' }])!;
    expect(promoted.tier).toBe('beta');
    expect(promoted.tierSource).toBe('override');
  });

  it('can demote a language the harness measured', () => {
    expect(resolveLanguage('my-MM', [{ code: 'my-MM', tier: 'unsupported' }])!.tier).toBe(
      'unsupported',
    );
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
  });

  /**
   * `humanReviewed` means *a sign-off backs the tier this language currently has* — not
   * "somebody looked at this language once". `my-MM` is seeded `humanReviewed: true` from
   * operational use, and the moment the harness measured it that stopped being the thing
   * the field is answering: the measurement is a new claim and no sign-off names its run.
   * Keeping the seeded `true` here would contradict the tier beside it, which is
   * `beta`, `blocked by humanReview`.
   */
  it('reports no human review once a measurement has superseded the seeded one', () => {
    const my = resolveLanguage('my-MM')!;
    expect(my.tierSource).toBe('measured');
    expect(my.support.humanReviewed).toBe(false);
    // Whatever the latest sweep measured; the baseline is deliberately measured at a larger
    // n than the languages it calibrates, so pinning a literal here would break on every
    // change to `--baseline-n`.
    expect(my.support.evalN).toBeGreaterThanOrEqual(30);
    // The override layer can still assert it, which is the admin's call to make.
    expect(resolveLanguage('my-MM', [{ code: 'my-MM', humanReviewed: true }])!.support.humanReviewed).toBe(true);
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
    // Empty, and deliberately so: `my-MM` was the one seeded `verified` language until the
    // harness measured it, and a measurement with no sign-off against that run cannot carry
    // the claim. Promotion is a person's act — `results/human-review/<code>.json`, or an
    // admin's `language_support` row for their own instance.
    expect(registry.list({ tier: ['verified'] }).map((l) => l.code)).toEqual([]);
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
