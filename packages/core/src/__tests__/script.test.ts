import { describe, expect, it } from 'vitest';
import { formatScriptIntegrity, scriptIntegrity, type ScriptRanges } from '../metrics/script.js';

/**
 * Ranges copied from `packages/languages/data/scripts.json` rather than imported: `@thibi/core`
 * depends on nothing, and that rule is the reason `scriptIntegrity` takes ranges structurally.
 */
const MYMR: ScriptRanges = { code: 'Mymr', unicodeRanges: [[0x1000, 0x109f], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f]] };
const LATN: ScriptRanges = { code: 'Latn', unicodeRanges: [[0x0041, 0x005a], [0x0061, 0x007a], [0x00c0, 0x024f]] };
const CYRL: ScriptRanges = { code: 'Cyrl', unicodeRanges: [[0x0400, 0x04ff], [0x0500, 0x052f]] };

/**
 * The three outputs behind the whole "accepting a language code proves nothing" rule, on the
 * same 12 s clip, 2026-07-30. Transcribed from `plans/phase-04-whisper-providers.md:225-228`
 * and `packages/languages/data/matrix-overrides.json`, which is where they survive in this
 * repo — the `research/language-support-whisper-vs-google.md` those cite is not in the tree.
 */
const GOOGLE_CORRECT = 'အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို နေပြည်တော် က တုံ့ပြန်ခဲ့ ပါ တယ်';
const GROQ_MANGLED = 'လာက္းကေက် ရိုရ်းသဲ့ထါတ် နို့ရ်းတို့အ်းတ်';
const GROQ_ROMANISED = 'ASEAN YAK SOMPHA CHHA KOO NEPI ROKKA TONGPYAN KE BHA REUU';

describe('scriptIntegrity', () => {
  it('scores correct Burmese at 1', () => {
    const result = scriptIntegrity(GOOGLE_CORRECT, [MYMR]);
    expect(result.fraction).toBe(1);
    expect(result.strays).toEqual([]);
  });

  /**
   * The load-bearing pair. Both are wrong; only one is wrong in a way this metric can see,
   * and the assertion says so out loud so nobody later reads a 1.00 as a pass.
   */
  it('does NOT catch Myanmar-script non-words — that is CER’s job', () => {
    expect(scriptIntegrity(GROQ_MANGLED, [MYMR]).fraction).toBe(1);
  });

  it('catches the romanised autodetect output', () => {
    const result = scriptIntegrity(GROQ_ROMANISED, [MYMR]);
    expect(result.fraction).toBe(0);
    expect(result.counted).toBeGreaterThan(40);
    expect(result.strays.length).toBeGreaterThan(0);
  });

  it('is a snapshot, so a change to the counting rule is a visible diff', () => {
    expect({
      correct: formatScriptIntegrity(scriptIntegrity(GOOGLE_CORRECT, [MYMR])),
      mangled: formatScriptIntegrity(scriptIntegrity(GROQ_MANGLED, [MYMR])),
      romanised: formatScriptIntegrity(scriptIntegrity(GROQ_ROMANISED, [MYMR])),
    }).toMatchInlineSnapshot(`
      {
        "correct": "1.00",
        "mangled": "1.00",
        "romanised": "0.00 (stray: A S E N Y K O M)",
      }
    `);
  });

  it('excludes digits, punctuation and whitespace from the denominator', () => {
    // Only the four Burmese letters count; `2026`, the comma and the spaces do not.
    const result = scriptIntegrity('မြန်မာ 2026, ။', [MYMR]);
    expect(result.counted).toBe(6);
    expect(result.fraction).toBe(1);
  });

  it('returns null rather than 1 when nothing is countable', () => {
    for (const text of ['', '   ', '2026 — 12:04.', '???']) {
      const result = scriptIntegrity(text, [MYMR]);
      expect(result.fraction).toBeNull();
      expect(result.counted).toBe(0);
    }
    expect(formatScriptIntegrity(scriptIntegrity('', [MYMR]))).toBe('— (nothing countable)');
  });

  /**
   * Serbian is 93% Latin / 7% Cyrillic across the FLEURS dev set. Without `altScripts` in the
   * accepted list, a correct Cyrillic transcript scores 0 and the harness reports a provider
   * failure that did not happen — the false positive that would get this metric switched off.
   */
  it('accepts every script the language is genuinely written in', () => {
    const cyrillic = 'Београд је главни град Србије';
    expect(scriptIntegrity(cyrillic, [LATN]).fraction).toBe(0);
    expect(scriptIntegrity(cyrillic, [LATN, CYRL]).fraction).toBe(1);
    expect(scriptIntegrity('Beograd je glavni grad Srbije', [LATN, CYRL]).fraction).toBe(1);
  });

  it('counts combining marks, which is most of what a Burmese cluster is', () => {
    // U+1000 U+103C U+1014 U+103A: one grapheme cluster, four countable code points.
    expect(scriptIntegrity('ကြန်', [MYMR]).counted).toBe(4);
  });

  it('scores a mixed transcript by fraction, not by a threshold', () => {
    const result = scriptIntegrity('မြန်မာ ASEAN', [MYMR]);
    expect(result.counted).toBe(11);
    expect(result.inScript).toBe(6);
    expect(result.fraction).toBeCloseTo(6 / 11, 10);
  });
});
