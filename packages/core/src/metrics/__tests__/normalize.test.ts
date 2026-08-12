import { describe, expect, it } from 'vitest';
import { normalizeForScoring, type ScoreOptions, type ScoreProfile } from '../normalize.js';

/**
 * Profiles copied from `packages/languages/data/{languages,scripts}.json` rather than
 * imported: `@thibi/core` depends on nothing, which is the whole reason `ScoreProfile` is a
 * structural shape. `toScoreProfile` in `@thibi/languages` is what builds these for real,
 * and its own test asserts the projection.
 */
const base = (over: Partial<ScoreProfile>): ScoreProfile => ({
  script: 'Latn',
  wordSegmentation: 'spaces',
  zawgyiApplies: false,
  zeroWidth: { zwsp: 'strip', zwnj: 'keep', zwj: 'keep' },
  nativeDigits: [],
  stripWhitespace: false,
  letterlikePunct: [],
  ...over,
});

const MYMR = base({
  script: 'Mymr',
  wordSegmentation: 'none',
  zawgyiApplies: true,
  zeroWidth: { zwsp: 'strip', zwnj: 'strip', zwj: 'strip' },
  nativeDigits: ['၀၁၂၃၄၅၆၇၈၉'],
  stripWhitespace: true,
});
const KHMR = base({
  script: 'Khmr',
  wordSegmentation: 'none',
  nativeDigits: ['០១២៣៤៥៦៧៨៩'],
  stripWhitespace: true,
});
const LAOO = base({
  script: 'Laoo',
  wordSegmentation: 'none',
  nativeDigits: ['໐໑໒໓໔໕໖໗໘໙'],
  stripWhitespace: true,
});
const THAI = base({
  script: 'Thai',
  wordSegmentation: 'none',
  nativeDigits: ['๐๑๒๓๔๕๖๗๘๙'],
  stripWhitespace: true,
});
const ETHI = base({ script: 'Ethi' });
/** Two native digit sets: Arabic-Indic and Extended Arabic-Indic. */
const ARAB = base({ script: 'Arab', nativeDigits: ['٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹'] });
const LATN_YORUBA = base({ script: 'Latn' });
/** ZWJ is semantic in Sinhala — it forms the touching consonant conjuncts. */
const SINH = base({ script: 'Sinh', zeroWidth: { zwsp: 'strip', zwnj: 'keep', zwj: 'keep' } });
/** ZWNJ is semantic in Devanagari — it blocks a conjunct that would otherwise form. */
const DEVA = base({ script: 'Deva', nativeDigits: ['०१२३४५६७८९'] });

const ASR: ScoreOptions = { keepPunctuation: false, caseFold: true };
const CLEANUP: ScoreOptions = { keepPunctuation: true, caseFold: false };

/** Stand-in for the real detector+converter, which lives above this layer. */
const identityZawgyi = (s: string): string => s;
const asrMymr: ScoreOptions = { ...ASR, convertZawgyi: identityZawgyi };

describe('normalizeForScoring — snapshot per script', () => {
  it('mymr-unicode', () => {
    expect(
      normalizeForScoring('အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို ၂၀၂၆ ခုနှစ် မှာ ။', MYMR, asrMymr),
    ).toMatchInlineSnapshot(`"အာဆီယံရဲ့ဆုံးဖြတ်ချက်ကို2026ခုနှစ်မှာ"`);
  });

  it('mymr-zawgyi runs the injected converter and re-normalizes afterwards', () => {
    const calls: string[] = [];
    const convertZawgyi = (s: string): string => {
      calls.push(s);
      return 'မြန်မာ';
    };
    expect(normalizeForScoring('ျမန္မာ', MYMR, { ...ASR, convertZawgyi })).toBe('မြန်မာ');
    expect(calls).toHaveLength(1);
    // Rule 1 ran before the converter saw the string.
    expect(calls[0]).toBe('ျမန္မာ'.normalize('NFC'));
  });

  it('khmr', () => {
    expect(normalizeForScoring('ព្រះរាជាណាចក្រ កម្ពុជា ០៩។', KHMR, ASR)).toMatchInlineSnapshot(
      `"ព្រះរាជាណាចក្រកម្ពុជា09"`,
    );
  });

  it('laoo', () => {
    expect(normalizeForScoring('ສາທາລະນະລັດ ລາວ ໑໒໓.', LAOO, ASR)).toMatchInlineSnapshot(
      `"ສາທາລະນະລັດລາວ123"`,
    );
  });

  it('thai', () => {
    expect(normalizeForScoring('ไปโรงเรียน ทุกวัน ๒๕๖๗!', THAI, ASR)).toMatchInlineSnapshot(
      `"ไปโรงเรียนทุกวัน2567"`,
    );
  });

  it('ethi', () => {
    expect(
      normalizeForScoring('ኢትዮጵያ በአፍሪካ ቀንድ ውስጥ ትገኛለች፣ አዲስ አበባ ዋና ከተማዋ ናት።', ETHI, ASR),
    ).toMatchInlineSnapshot(`"ኢትዮጵያ በአፍሪካ ቀንድ ውስጥ ትገኛለች አዲስ አበባ ዋና ከተማዋ ናት"`);
  });

  it('arab-rtl', () => {
    expect(
      normalizeForScoring('د ملگرو ملتونو UN رپوټ ۱۲۳ او ٤٥٦؟', ARAB, ASR),
    ).toMatchInlineSnapshot(`"د ملگرو ملتونو un رپوټ 123 او 456"`);
  });

  it('latn-yoruba', () => {
    expect(
      normalizeForScoring('Ọ̀rọ̀ ẹlẹ́rìí náà, ó ṣe pàtàkì!', LATN_YORUBA, ASR),
    ).toMatchInlineSnapshot(`"ọ̀rọ̀ ẹlẹ́rìí náà ó ṣe pàtàkì"`);
  });

  it('sinh-zwj-preserved', () => {
    const withZwj = 'ශ්‍රී ලංකා';
    const out = normalizeForScoring(withZwj, SINH, ASR);
    expect(out).toContain('‍');
    expect(out).toMatchInlineSnapshot(`"ශ්‍රී ලංකා"`);
  });

  it('deva-zwnj-preserved', () => {
    const withZwnj = 'क्‌ष';
    const out = normalizeForScoring(withZwnj, DEVA, ASR);
    expect(out).toContain('‌');
  });
});

describe('rule 1 — NFC', () => {
  it('normalizes to NFC, and is idempotent', () => {
    const nfd = 'café'; // e + combining acute
    const once = normalizeForScoring(nfd, LATN_YORUBA, ASR);
    expect(once).toBe('café');
    expect(normalizeForScoring(once, LATN_YORUBA, ASR)).toBe(once);
  });

  it('makes two spellings of the same Burmese syllable compare equal', () => {
    const a = normalizeForScoring('ကီ', MYMR, asrMymr);
    const b = normalizeForScoring('ကီ'.normalize('NFD'), MYMR, asrMymr);
    expect(a).toBe(b);
  });
});

describe('rule 2 — Zawgyi', () => {
  /**
   * Loud, not lenient. A missing converter would otherwise report a correct Burmese
   * transcript at ~100% error, which reads as a provider failure — the single most expensive
   * wrong number this layer could produce, and one no other test would catch.
   */
  it('throws when the profile needs a converter and none was supplied', () => {
    expect(() => normalizeForScoring('မြန်မာ', MYMR, ASR)).toThrow(/zawgyiApplies/);
  });

  it('does not call the converter for a script that does not need it', () => {
    let called = false;
    normalizeForScoring('hello', LATN_YORUBA, {
      ...ASR,
      convertZawgyi: () => {
        called = true;
        return 'x';
      },
    });
    expect(called).toBe(false);
  });

  it('skips the converter on an empty string rather than asking it about nothing', () => {
    let called = false;
    expect(
      normalizeForScoring('', MYMR, {
        ...ASR,
        convertZawgyi: () => {
          called = true;
          return 'x';
        },
      }),
    ).toBe('');
    expect(called).toBe(false);
  });
});

describe('rule 3 — whitespace', () => {
  it('strips all whitespace for scriptio-continua scripts', () => {
    expect(normalizeForScoring('က ခ  ဂ', MYMR, asrMymr)).toBe('ကခဂ');
  });

  it('collapses runs and trims for everything else', () => {
    expect(normalizeForScoring('  the   cat \n sat  ', LATN_YORUBA, ASR)).toBe('the cat sat');
  });

  it('runs last, so removing punctuation cannot leave a double space', () => {
    expect(normalizeForScoring('the cat , the dog', LATN_YORUBA, ASR)).toBe('the cat the dog');
  });
});

describe('rule 4 — punctuation', () => {
  it('strips punctuation and symbols for the ASR metric', () => {
    expect(normalizeForScoring('“hello,” he said — 50% done!', LATN_YORUBA, ASR)).toBe(
      'hello he said 50 done',
    );
  });

  it('keeps punctuation for the cleanup metric, which is measuring it', () => {
    expect(normalizeForScoring('“Hello,” he said.', LATN_YORUBA, CLEANUP)).toBe('“Hello,” he said.');
  });

  it('keeps ။ and ። when the cleanup metric asks for punctuation', () => {
    expect(normalizeForScoring('မြန်မာ ။', MYMR, { ...CLEANUP, convertZawgyi: identityZawgyi })).toBe(
      'မြန်မာ။',
    );
    expect(normalizeForScoring('ናት።', ETHI, CLEANUP)).toBe('ናት።');
  });

  /**
   * Somali's glottal apostrophe and Hausa's compounding hyphen are letters, not punctuation.
   * Stripping them merges two words into one and inflates that language's WER at every
   * occurrence — which is what happens today, because the registry has no field to populate
   * `letterlikePunct` from (amendment 61). The mechanism works; the data does not exist yet.
   */
  it('retains letterlike punctuation when the profile names it', () => {
    const hausa = base({ letterlikePunct: ['-'] });
    expect(normalizeForScoring("mai-gida ya'a", hausa, ASR)).toBe('mai-gida yaa');
    const somali = base({ letterlikePunct: ["'"] });
    expect(normalizeForScoring("bu'ur, waa", somali, ASR)).toBe("bu'ur waa");
  });
});

describe('rule 5 — digits', () => {
  it('folds Burmese digits to ASCII', () => {
    expect(normalizeForScoring('၁၉၉၅', MYMR, asrMymr)).toBe('1995');
  });

  it('folds both Arabic-script digit sets, not just the first', () => {
    // The plan's single `nativeDigitBase` folds one and leaves the other wrong at every
    // digit; a provider may return either against the same reference.
    expect(normalizeForScoring('١٩٩٥ و ۱۹۹۵', ARAB, ASR)).toBe('1995 و 1995');
  });

  it('leaves ASCII digits alone', () => {
    expect(normalizeForScoring('1995', MYMR, asrMymr)).toBe('1995');
  });

  it('folds regardless of the script’s foldToLatin rendering policy', () => {
    // Every script in the registry has foldToLatin: false, which is a policy about what the
    // user sees. Scoring is symmetric and folds anyway, or rule 5 would never fire at all.
    expect(normalizeForScoring('๒๕๖๗', THAI, ASR)).toBe('2567');
  });
});

describe('rule 6 — zero-width and bidi', () => {
  it('always removes ZWSP and the byte-order mark', () => {
    expect(normalizeForScoring('a​b﻿c', SINH, ASR)).toBe('abc');
    expect(normalizeForScoring('a​b', LATN_YORUBA, ASR)).toBe('ab');
  });

  it('always removes bidi formatting characters, in every script', () => {
    for (const mark of ['‎', '‏', '؜', '‪', '‮', '⁦', '⁩']) {
      expect(normalizeForScoring(`a${mark}b`, ARAB, ASR)).toBe('ab');
    }
    // An RTL provider that brackets a Latin acronym in RLM and a reference that does not are
    // the same logical text; without this every mark would count as an insertion.
    expect(normalizeForScoring('‫د ملتونو‬ UN', ARAB, ASR)).toBe('د ملتونو un');
  });

  it('strips ZWNJ and ZWJ where the script says strip', () => {
    expect(normalizeForScoring('က‌ခ‍ဂ', MYMR, asrMymr)).toBe('ကခဂ');
  });

  it('keeps ZWNJ and ZWJ where they are semantic', () => {
    expect(normalizeForScoring('a‌b', DEVA, ASR)).toBe('a‌b');
    expect(normalizeForScoring('a‍b', SINH, ASR)).toBe('a‍b');
  });
});

describe('case folding', () => {
  it('folds for the ASR metric, because FLEURS column 3 is lowercased', () => {
    expect(normalizeForScoring('The Cat SAT', LATN_YORUBA, ASR)).toBe('the cat sat');
  });

  it('does NOT fold for the cleanup metric, which is scoring capitalisation', () => {
    expect(normalizeForScoring('The Cat SAT', LATN_YORUBA, CLEANUP)).toBe('The Cat SAT');
  });
});

describe('idempotence', () => {
  it('is a fixed point for every profile in this file', () => {
    const samples: Array<[ScoreProfile, string, ScoreOptions]> = [
      [MYMR, 'အာဆီယံ ရဲ့ ၂၀၂၆ ။', asrMymr],
      [KHMR, 'ព្រះរាជាណាចក្រ ០៩។', ASR],
      [THAI, 'ไปโรงเรียน ๒๕๖๗!', ASR],
      [ETHI, 'ኢትዮጵያ ናት።', ASR],
      [ARAB, 'د ملتونو‏ UN ۱۲۳؟', ASR],
      [LATN_YORUBA, '  Ọ̀rọ̀,  náà! ', ASR],
      [SINH, 'ශ්‍රී ලංකා.', ASR],
      [DEVA, 'क्‌ष २०२६।', ASR],
    ];
    for (const [profile, text, opts] of samples) {
      const once = normalizeForScoring(text, profile, opts);
      expect(normalizeForScoring(once, profile, opts)).toBe(once);
    }
  });
});
