import { describe, expect, it } from 'vitest';
import { LANGUAGES, SCRIPTS } from '../generated/registry.gen.js';
import { createRegistry } from '../registry.js';

const languages = Object.values(LANGUAGES);

describe('data integrity', () => {
  it('has at least the 116 seeded codes', () => {
    expect(languages.length).toBeGreaterThanOrEqual(116);
  });

  it('keys every entry by its own code', () => {
    for (const [key, language] of Object.entries(LANGUAGES)) expect(language.code).toBe(key);
  });

  it('resolves every script and altScript', () => {
    for (const language of languages) {
      expect(SCRIPTS[language.script], `${language.code} -> ${language.script}`).toBeDefined();
      for (const alt of language.altScripts) {
        expect(SCRIPTS[alt], `${language.code} altScript ${alt}`).toBeDefined();
      }
    }
  });

  /**
   * The phase plan named five languages with no FLEURS config. That was the count before
   * the nine extra locales — a second locale of a language FLEURS already covers has no
   * config of its own either. Fourteen is the correct number and this is the list.
   */
  it('has a null fleurs config for exactly the fourteen codes with no eval set', () => {
    const withoutFleurs = languages.filter((l) => l.fleurs.config === null).map((l) => l.code);
    expect([...withoutFleurs].sort()).toEqual([
      // Google locales FLEURS does not cover at all.
      'eu-ES', 'rup-BG', 'si-LK', 'sq-AL', 'su-ID',
      // Extra locales of languages FLEURS covers under a different region.
      'bn-BD', 'cmn-Hant-TW', 'en-AU', 'en-GB', 'en-IN', 'es-ES', 'es-US', 'fr-CA', 'pt-PT',
    ].sort());
  });

  it('never lists zawgyi in a normalizer chain', () => {
    // It is not length-preserving, so running it over segment text desynchronises word
    // alignment. `zawgyiApplies` is the flag; Phase 1 applies it per word.
    for (const language of languages) {
      expect(language.text.normalizers, language.code).not.toContain('zawgyi');
    }
    expect(languages.filter((l) => l.text.zawgyiApplies).map((l) => l.code)).toEqual(['my-MM']);
  });

  it('applies the scriptio-continua rules consistently', () => {
    for (const language of languages) {
      const continua = language.text.wordSegmentation === 'none';
      // Spacing is arbitrary on both sides, so CER must strip it — and a whitespace-
      // tokenized WER over an unspaced script is not comparable to anything.
      expect(language.text.cerStripsWhitespace, language.code).toBe(continua);
      expect(language.text.reportWer, language.code).toBe(!continua);
    }
  });

  it('gives every RTL language an RTL script and vice versa', () => {
    const registry = createRegistry();
    for (const language of languages) {
      const resolved = registry.get(language.code)!;
      expect(resolved.direction).toBe(SCRIPTS[language.script]!.direction);
    }
    expect(registry.list({ script: 'Arab' }).length).toBeGreaterThan(0);
  });

  it('has ascending, sorted, non-overlapping unicode ranges', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(script.unicodeRanges.length, script.code).toBeGreaterThan(0);
      let previousEnd = -1;
      for (const [lo, hi] of script.unicodeRanges) {
        expect(lo, `${script.code} range start`).toBeLessThanOrEqual(hi);
        expect(lo, `${script.code} ranges must be sorted`).toBeGreaterThan(previousEnd);
        previousEnd = hi;
      }
    }
  });

  it('has ranges that actually contain the script they claim', () => {
    const contains = (code: string, cp: number): boolean =>
      SCRIPTS[code]!.unicodeRanges.some(([lo, hi]) => cp >= lo && cp <= hi);
    // One known character per script under test, including the ones the integrity check
    // in the eval harness will lean on hardest.
    expect(contains('Mymr', 'မ'.codePointAt(0)!)).toBe(true);
    expect(contains('Latn', 'a'.codePointAt(0)!)).toBe(true);
    expect(contains('Mymr', 'a'.codePointAt(0)!)).toBe(false);
    expect(contains('Arab', 'پ'.codePointAt(0)!)).toBe(true);
    expect(contains('Ethi', 'አ'.codePointAt(0)!)).toBe(true);
    expect(contains('Jpan', 'ひ'.codePointAt(0)!)).toBe(true);
    expect(contains('Jpan', '漢'.codePointAt(0)!)).toBe(true);
  });

  it('has no duplicate (iso639_3, region) pair', () => {
    const seen = new Map<string, string>();
    for (const language of languages) {
      const key = `${language.iso639_3}|${language.region ?? ''}`;
      expect(seen.get(key), `${language.code} collides with ${seen.get(key)}`).toBeUndefined();
      seen.set(key, language.code);
    }
  });

  it('has ten characters in every native digit set', () => {
    for (const script of Object.values(SCRIPTS)) {
      for (const set of script.digits.native) {
        expect([...set].length, `${script.code} digit set`).toBe(10);
      }
    }
  });

  it('strips ZWSP in every script and keeps ZWNJ/ZWJ except in Myanmar', () => {
    // ZWNJ and ZWJ are semantic in Sinhala and Devanagari — stripping them changes what a
    // word means. In Myanmar they are layout noise.
    for (const script of Object.values(SCRIPTS)) {
      expect(script.zeroWidth.zwsp, script.code).toBe('strip');
    }
    expect(SCRIPTS['Mymr']!.zeroWidth.zwnj).toBe('strip');
    expect(SCRIPTS['Sinh']!.zeroWidth.zwnj).toBe('keep');
    expect(SCRIPTS['Deva']!.zeroWidth.zwnj).toBe('keep');
  });

  it('seeds exactly one verified language, by human judgement', () => {
    const verified = languages.filter((l) => l.seed.tier === 'verified');
    expect(verified.map((l) => l.code)).toEqual(['my-MM']);
    expect(verified[0]!.seed.humanReviewed).toBe(true);
    expect(verified[0]!.seed.notes).toMatch(/operational use/);
    // Everything else is unmeasured until Phase 5 says otherwise.
    for (const language of languages) {
      if (language.code !== 'my-MM') expect(language.seed.tier).toBe('experimental');
      expect(language.seed.enabled).toBe(true);
    }
  });

  it('never guesses an endonym', () => {
    // CLDR has nothing for Aromanian or Umbundu. A picker row showing only the English
    // name is better than a wrong endonym.
    const missing = languages.filter((l) => l.endonym === null).map((l) => l.code);
    expect(missing.sort()).toEqual(['rup-BG', 'umb-AO']);
  });
});
