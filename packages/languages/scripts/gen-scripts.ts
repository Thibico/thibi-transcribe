/**
 * One-shot generator for `data/scripts.json`.
 *
 * Everything here except `unicodeRanges` is a human judgement and lives in the table
 * below, which is the reviewable artefact. `unicodeRanges` is derived from the runtime's
 * own Unicode data by scanning every codepoint against `\p{Script=...}`, because a
 * hand-typed range table is a second, worse copy of something ICU already knows exactly —
 * and the eval harness's script-integrity check is only as trustworthy as those ranges.
 *
 * The output is a plain JSON file that may be hand-edited afterwards; re-running this
 * regenerates it from scratch, so edit the table here rather than the JSON.
 *
 *   pnpm --filter @thibi/languages exec tsx scripts/gen-scripts.ts
 */
import { writeFileSync } from 'node:fs';

interface HandTable {
  /** Unicode script long name, for `\p{Script=...}`. */
  unicodeScript: string;
  nameEn: string;
  direction: 'ltr' | 'rtl';
  /** Needs shaping or reordering — drives the editor's rendering checks, not just fonts. */
  complex: boolean;
  clusters: 'grapheme' | 'codepoint';
  fontFamily: string | null;
  googleFontSubset: string | null;
  cssStack: string;
  /**
   * Not cosmetic. Myanmar, Khmer and Sinhala stack diacritics vertically and clip at 1.5 —
   * which is already why the existing app hardcodes 1.9 for Myanmar.
   */
  lineHeight: number;
  minFontPx: number;
  /** ZWSP is always stripped. These two are semantic in Sinhala and Devanagari. */
  zwnj: 'strip' | 'keep';
  zwj: 'strip' | 'keep';
  /** Ordered: [0] is emitted by 'native' policy, all are folded by 'latin' policy. */
  nativeDigits: string[];
  foldToLatin: boolean;
}

const SANS = 'system-ui, sans-serif';

const TABLE: Record<string, HandTable> = {
  Latn: { unicodeScript: 'Latin', nameEn: 'Latin', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: 'latin', cssStack: SANS,
    lineHeight: 1.5, minFontPx: 14, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Cyrl: { unicodeScript: 'Cyrillic', nameEn: 'Cyrillic', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: 'cyrillic', cssStack: SANS,
    lineHeight: 1.5, minFontPx: 14, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Grek: { unicodeScript: 'Greek', nameEn: 'Greek', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: 'greek', cssStack: SANS,
    lineHeight: 1.5, minFontPx: 14, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Armn: { unicodeScript: 'Armenian', nameEn: 'Armenian', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: 'Noto Sans Armenian', googleFontSubset: 'armenian', cssStack: `'Noto Sans Armenian', ${SANS}`,
    lineHeight: 1.6, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Geor: { unicodeScript: 'Georgian', nameEn: 'Georgian', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: 'Noto Sans Georgian', googleFontSubset: 'georgian', cssStack: `'Noto Sans Georgian', ${SANS}`,
    lineHeight: 1.6, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Ethi: { unicodeScript: 'Ethiopic', nameEn: 'Ethiopic', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: 'Noto Sans Ethiopic', googleFontSubset: 'ethiopic', cssStack: `'Noto Sans Ethiopic', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },

  // RTL. Arabic joins cursively and needs shaping; Hebrew does not, but both need `dir`.
  Arab: { unicodeScript: 'Arabic', nameEn: 'Arabic', direction: 'rtl', complex: true, clusters: 'codepoint',
    fontFamily: 'Noto Naskh Arabic', googleFontSubset: 'arabic', cssStack: `'Noto Naskh Arabic', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep',
    nativeDigits: ['٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹'], foldToLatin: false },
  Hebr: { unicodeScript: 'Hebrew', nameEn: 'Hebrew', direction: 'rtl', complex: false, clusters: 'codepoint',
    fontFamily: 'Noto Sans Hebrew', googleFontSubset: 'hebrew', cssStack: `'Noto Sans Hebrew', ${SANS}`,
    lineHeight: 1.6, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Thaa: { unicodeScript: 'Thaana', nameEn: 'Thaana', direction: 'rtl', complex: true, clusters: 'codepoint',
    fontFamily: 'Noto Sans Thaana', googleFontSubset: 'thaana', cssStack: `'Noto Sans Thaana', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },

  // Indic. ZWNJ and ZWJ are semantic — they select conjunct versus half-form rendering —
  // so they are kept everywhere except Myanmar, where they are layout noise.
  Deva: { unicodeScript: 'Devanagari', nameEn: 'Devanagari', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Devanagari', googleFontSubset: 'devanagari', cssStack: `'Noto Sans Devanagari', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['०१२३४५६७८९'], foldToLatin: false },
  Beng: { unicodeScript: 'Bengali', nameEn: 'Bengali', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Bengali', googleFontSubset: 'bengali', cssStack: `'Noto Sans Bengali', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['০১২৩৪৫৬৭৮৯'], foldToLatin: false },
  Guru: { unicodeScript: 'Gurmukhi', nameEn: 'Gurmukhi', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Gurmukhi', googleFontSubset: 'gurmukhi', cssStack: `'Noto Sans Gurmukhi', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['੦੧੨੩੪੫੬੭੮੯'], foldToLatin: false },
  Gujr: { unicodeScript: 'Gujarati', nameEn: 'Gujarati', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Gujarati', googleFontSubset: 'gujarati', cssStack: `'Noto Sans Gujarati', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['૦૧૨૩૪૫૬૭૮૯'], foldToLatin: false },
  Orya: { unicodeScript: 'Oriya', nameEn: 'Odia', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Oriya', googleFontSubset: 'oriya', cssStack: `'Noto Sans Oriya', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['୦୧୨୩୪୫୬୭୮୯'], foldToLatin: false },
  Taml: { unicodeScript: 'Tamil', nameEn: 'Tamil', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Tamil', googleFontSubset: 'tamil', cssStack: `'Noto Sans Tamil', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['௦௧௨௩௪௫௬௭௮௯'], foldToLatin: false },
  Telu: { unicodeScript: 'Telugu', nameEn: 'Telugu', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Telugu', googleFontSubset: 'telugu', cssStack: `'Noto Sans Telugu', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['౦౧౨౩౪౫౬౭౮౯'], foldToLatin: false },
  Knda: { unicodeScript: 'Kannada', nameEn: 'Kannada', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Kannada', googleFontSubset: 'kannada', cssStack: `'Noto Sans Kannada', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['೦೧೨೩೪೫೬೭೮೯'], foldToLatin: false },
  Mlym: { unicodeScript: 'Malayalam', nameEn: 'Malayalam', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Malayalam', googleFontSubset: 'malayalam', cssStack: `'Noto Sans Malayalam', ${SANS}`,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['൦൧൨൩൪൫൬൭൮൯'], foldToLatin: false },
  Sinh: { unicodeScript: 'Sinhala', nameEn: 'Sinhala', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Sinhala', googleFontSubset: 'sinhala', cssStack: `'Noto Sans Sinhala', ${SANS}`,
    lineHeight: 1.9, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },

  // Scriptio continua. CER strips whitespace for these; WER is meaningless.
  Thai: { unicodeScript: 'Thai', nameEn: 'Thai', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Thai', googleFontSubset: 'thai', cssStack: `'Noto Sans Thai', ${SANS}`,
    lineHeight: 1.8, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['๐๑๒๓๔๕๖๗๘๙'], foldToLatin: false },
  Laoo: { unicodeScript: 'Lao', nameEn: 'Lao', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Lao', googleFontSubset: 'lao', cssStack: `'Noto Sans Lao', ${SANS}`,
    lineHeight: 1.8, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['໐໑໒໓໔໕໖໗໘໙'], foldToLatin: false },
  Mymr: { unicodeScript: 'Myanmar', nameEn: 'Myanmar', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Myanmar', googleFontSubset: 'myanmar', cssStack: `'Noto Sans Myanmar', ${SANS}`,
    // 1.9 is the value the existing app already uses, for exactly this reason.
    lineHeight: 1.9, minFontPx: 15, zwnj: 'strip', zwj: 'strip',
    nativeDigits: ['၀၁၂၃၄၅၆၇၈၉'], foldToLatin: false },
  Khmr: { unicodeScript: 'Khmer', nameEn: 'Khmer', direction: 'ltr', complex: true, clusters: 'grapheme',
    fontFamily: 'Noto Sans Khmer', googleFontSubset: 'khmer', cssStack: `'Noto Sans Khmer', ${SANS}`,
    lineHeight: 1.9, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: ['០១២៣៤៥៦៧៨៩'], foldToLatin: false },

  // CJK is cut from v1's UI work, but the languages are in Google's list and must resolve.
  Hani: { unicodeScript: 'Han', nameEn: 'Han', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: null, cssStack: SANS,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Jpan: { unicodeScript: 'Japanese', nameEn: 'Japanese', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: null, cssStack: SANS,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
  Hang: { unicodeScript: 'Korean', nameEn: 'Hangul', direction: 'ltr', complex: false, clusters: 'grapheme',
    fontFamily: null, googleFontSubset: null, cssStack: SANS,
    lineHeight: 1.7, minFontPx: 15, zwnj: 'keep', zwj: 'keep', nativeDigits: [], foldToLatin: false },
};

/**
 * ISO 15924 'Jpan' and 'Kore' are composites with no single `\p{Script=}` equivalent —
 * `Script=Japanese` is not a thing. Enumerate their components instead.
 */
const COMPONENTS: Record<string, string[]> = {
  Jpan: ['Han', 'Hiragana', 'Katakana'],
  Hang: ['Hangul', 'Han'],
};

const MAX_CODEPOINT = 0x10ffff;

function rangesFor(iso: string, unicodeScript: string): Array<[number, number]> {
  const names = COMPONENTS[iso] ?? [unicodeScript];
  const matchers = names.map((n) => new RegExp(`\\p{Script=${n}}`, 'u'));

  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  for (let cp = 0; cp <= MAX_CODEPOINT; cp++) {
    // Surrogates are never script characters and String.fromCodePoint on them is noise.
    const isMatch =
      cp >= 0xd800 && cp <= 0xdfff ? false : matchers.some((re) => re.test(String.fromCodePoint(cp)));
    if (isMatch && start === null) start = cp;
    if (!isMatch && start !== null) {
      ranges.push([start, cp - 1]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, MAX_CODEPOINT]);
  return ranges;
}

const scripts = Object.fromEntries(
  Object.entries(TABLE)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([iso, t]) => {
      const ranges = rangesFor(iso, t.unicodeScript);
      const total = ranges.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0);
      console.error(`${iso.padEnd(6)} ${String(ranges.length).padStart(3)} ranges, ${total} codepoints`);
      return [
        iso,
        {
          code: iso,
          nameEn: t.nameEn,
          direction: t.direction,
          complex: t.complex,
          unicodeRanges: ranges,
          clusters: t.clusters,
          typography: {
            fontFamily: t.fontFamily,
            googleFontSubset: t.googleFontSubset,
            cssStack: t.cssStack,
            lineHeight: t.lineHeight,
            minFontPx: t.minFontPx,
          },
          // ZWSP is noise in every script; ZWNJ and ZWJ are per-script judgements.
          zeroWidth: { zwsp: 'strip', zwnj: t.zwnj, zwj: t.zwj },
          digits: { native: t.nativeDigits, foldToLatin: t.foldToLatin },
        },
      ];
    }),
);

const out = {
  _meta: {
    note:
      'Judgements (direction, complex, clusters, typography, zero-width, digits) are ' +
      'hand-maintained in scripts/gen-scripts.ts. unicodeRanges are derived from the ' +
      "runtime's Unicode data. Re-run `tsx scripts/gen-scripts.ts` after editing the table.",
    icuVersion: process.versions.icu,
    generatedAt: new Date().toISOString().slice(0, 10),
  },
  scripts,
};

writeFileSync('data/scripts.json', JSON.stringify(out, null, 2) + '\n');
console.error(`\nwrote data/scripts.json — ${Object.keys(scripts).length} scripts`);
