/**
 * One-shot bootstrap for `data/languages.json`.
 *
 * The 117-code Google list is not published in machine-readable form anywhere, so the
 * registry is *reconstructed* and then *reconciled* against a live probe:
 *
 *   102 FLEURS configs  (Google's language list is FLEURS; verified 2026-07-30)
 * +   5 non-FLEURS Google extras
 * +   9 extra locales
 * = 116, and `thibi probe languages --provider google` finds the 117th.
 *
 * Script assignment is inferred from each language's own FLEURS reference text by
 * Unicode-script majority, because the alternative — parsing the region subtag — gets
 * `sd-IN` (Sindhi, written in Arabic script despite the -IN tag) and `pa-Guru-IN` wrong.
 * The classifier is a labour saver, not an authority: its output is reviewed by a human
 * before commit, and the review is the deliverable.
 *
 *   pnpm --filter @thibi/languages exec tsx scripts/infer-scripts.ts [--out <path>]
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { parseFleursTsv } from '@thibi/core';

const require = createRequire(import.meta.url);

const HF_TREE = 'https://huggingface.co/api/datasets/google/fleurs/tree/main/data';
const HF_FILE = (cfg: string) =>
  `https://huggingface.co/datasets/google/fleurs/resolve/main/data/${cfg}/dev.tsv`;

/**
 * FLEURS config id -> Google BCP-47 tag. The default rule is `xx_yy -> xx-YY`; these are
 * the tags where that rule is wrong, and each one is a trap the old research already hit.
 */
const CONFIG_EXCEPTIONS: Record<string, string> = {
  es_419: 'es-419',
  cmn_hans_cn: 'cmn-Hans-CN',
  yue_hant_hk: 'yue-Hant-HK',
  // Punjabi is half a language without its script subtag: `pa-IN` does not exist.
  pa_in: 'pa-Guru-IN',
  ar_eg: 'ar-EG',
  hy_am: 'hy-AM',
};

/** Google locales with no FLEURS config. `experimental — no eval set` is a first-class case. */
const NON_FLEURS = ['eu-ES', 'si-LK', 'sq-AL', 'su-ID', 'rup-BG'];

/** Additional locales of languages FLEURS already covers under a different region. */
const EXTRA_LOCALES = [
  'en-AU',
  'en-GB',
  'en-IN',
  'es-ES',
  'es-US',
  'fr-CA',
  'pt-PT',
  'bn-BD',
  'cmn-Hant-TW',
];

const ISO_639_1_TO_3: Record<string, string> = {
  af: 'afr', am: 'amh', ar: 'ara', as: 'asm', az: 'aze', be: 'bel', bg: 'bul', bn: 'ben',
  bs: 'bos', ca: 'cat', cs: 'ces', cy: 'cym', da: 'dan', de: 'deu', el: 'ell', en: 'eng',
  es: 'spa', et: 'est', eu: 'eus', fa: 'fas', ff: 'ful', fi: 'fin', fr: 'fra', ga: 'gle',
  gl: 'glg', gu: 'guj', ha: 'hau', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', hy: 'hye',
  id: 'ind', ig: 'ibo', is: 'isl', it: 'ita', ja: 'jpn', jv: 'jav', ka: 'kat', kk: 'kaz',
  km: 'khm', kn: 'kan', ko: 'kor', ky: 'kir', lb: 'ltz', lg: 'lug', ln: 'lin', lo: 'lao',
  lt: 'lit', lv: 'lav', mi: 'mri', mk: 'mkd', ml: 'mal', mn: 'mon', mr: 'mar', ms: 'msa',
  mt: 'mlt', my: 'mya', nb: 'nob', ne: 'nep', nl: 'nld', ny: 'nya', oc: 'oci', om: 'orm',
  or: 'ori', pa: 'pan', pl: 'pol', ps: 'pus', pt: 'por', ro: 'ron', ru: 'rus', sd: 'snd',
  si: 'sin', sk: 'slk', sl: 'slv', sn: 'sna', so: 'som', sq: 'sqi', sr: 'srp', su: 'sun',
  sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', tg: 'tgk', th: 'tha', tr: 'tur', uk: 'ukr',
  ur: 'urd', uz: 'uzb', vi: 'vie', wo: 'wol', xh: 'xho', yo: 'yor', zu: 'zul',
};

/**
 * Unicode script property -> ISO 15924. `\p{Script=...}` is what does the classification;
 * hand-rolled codepoint ranges would be a second, worse copy of a table Node already has.
 */
const SCRIPT_PROBES: Array<[unicodeScript: string, iso15924: string]> = [
  ['Latin', 'Latn'], ['Cyrillic', 'Cyrl'], ['Greek', 'Grek'], ['Arabic', 'Arab'],
  ['Hebrew', 'Hebr'], ['Devanagari', 'Deva'], ['Bengali', 'Beng'], ['Gurmukhi', 'Guru'],
  ['Gujarati', 'Gujr'], ['Oriya', 'Orya'], ['Tamil', 'Taml'], ['Telugu', 'Telu'],
  ['Kannada', 'Knda'], ['Malayalam', 'Mlym'], ['Sinhala', 'Sinh'], ['Thai', 'Thai'],
  ['Lao', 'Laoo'], ['Myanmar', 'Mymr'], ['Khmer', 'Khmr'], ['Georgian', 'Geor'],
  ['Armenian', 'Armn'], ['Ethiopic', 'Ethi'], ['Han', 'Hani'], ['Hangul', 'Hang'],
  ['Hiragana', 'Jpan'], ['Katakana', 'Jpan'], ['Tibetan', 'Tibt'], ['Thaana', 'Thaa'],
  ['Nko', 'Nkoo'], ['Adlam', 'Adlm'],
];

const MATCHERS = SCRIPT_PROBES.map(
  ([unicodeScript, iso]) => [new RegExp(`\\p{Script=${unicodeScript}}`, 'u'), iso] as const,
);

/**
 * Digraphia is measured by whole *sentences*, not by character share.
 *
 * Character share does not separate the two things it needs to: Latin runs at 2-5% of a
 * Telugu, Lao, Nepali, Korean or Chinese corpus purely from acronyms, brand names and
 * digits, while genuine digraphia looks like Serbian — 11 of 199 FLEURS rows written
 * entirely in Cyrillic. A sentence that is majority-X is a deliberate choice of script;
 * a Latin acronym inside a Telugu sentence is not.
 */
const ALT_SCRIPT_ROW_SHARE = 0.02;

interface Classification {
  script: string;
  confidence: number;
  altScripts: string[];
  rowCounts: Record<string, number>;
}

/** Character census for one string, with the two composite-script corrections applied. */
function scriptCounts(sample: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ch of sample) {
    for (const [re, iso] of MATCHERS) {
      if (re.test(ch)) {
        counts[iso] = (counts[iso] ?? 0) + 1;
        break;
      }
    }
  }

  // Japanese is Han + Hiragana + Katakana in one text, and ISO 15924 'Jpan' is precisely
  // that composite. Counting Han separately ranks ja-JP as 63% Jpan / 37% Hani and makes a
  // correct classification look like a coin flip. Korean mixes a little Han the same way.
  if ((counts['Jpan'] ?? 0) > 0 && (counts['Hani'] ?? 0) > 0) {
    counts['Jpan'] = counts['Jpan']! + counts['Hani']!;
    delete counts['Hani'];
  }
  if ((counts['Hang'] ?? 0) > 0 && (counts['Hani'] ?? 0) > 0) {
    counts['Hang'] = counts['Hang']! + counts['Hani']!;
    delete counts['Hani'];
  }
  return counts;
}

function majorityScript(sample: string): string | null {
  const ranked = Object.entries(scriptCounts(sample)).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

function classify(sentences: readonly string[]): Classification {
  const rowCounts: Record<string, number> = {};
  let classified = 0;
  for (const sentence of sentences) {
    const script = majorityScript(sentence);
    if (!script) continue;
    rowCounts[script] = (rowCounts[script] ?? 0) + 1;
    classified++;
  }

  const ranked = Object.entries(rowCounts).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || classified === 0) {
    return { script: 'Zyyy', confidence: 0, altScripts: [], rowCounts };
  }
  return {
    script: top[0],
    confidence: top[1] / classified,
    altScripts: ranked
      .slice(1)
      .filter(([, n]) => n / classified >= ALT_SCRIPT_ROW_SHARE)
      .map(([s]) => s),
    rowCounts,
  };
}

/**
 * The 14 codes with no FLEURS config, assigned by hand because there is no reference text
 * to classify. Each is a judgement, so each carries its reason.
 */
const HAND_ASSIGNED: Record<string, string> = {
  'bn-BD': 'Beng',
  'cmn-Hant-TW': 'Hani', // Traditional Han; the script subtag already says so.
  'en-AU': 'Latn',
  'en-GB': 'Latn',
  'en-IN': 'Latn',
  'es-ES': 'Latn',
  'es-US': 'Latn',
  'eu-ES': 'Latn',
  'fr-CA': 'Latn',
  'pt-PT': 'Latn',
  'rup-BG': 'Latn', // Modern Aromanian is written in Latin; the Greek-script tradition is historical.
  'si-LK': 'Sinh',
  'sq-AL': 'Latn',
  'su-ID': 'Latn', // Sundanese is written in Latin in practice; Aksara Sunda is revivalist and rare.
};

// ---------------------------------------------------------------------------------------

const CLDR = 'cldr-localenames-full/main';

function cldrNames(locale: string): Record<string, string> | null {
  try {
    const data = require(`${CLDR}/${locale}/languages.json`) as {
      main: Record<string, { localeDisplayNames: { languages: Record<string, string> } }>;
    };
    return data.main[locale]?.localeDisplayNames.languages ?? null;
  } catch {
    return null;
  }
}

const EN_NAMES = cldrNames('en') ?? {};

/** CLDR has no `cmn`; it files Mandarin under `zh`. Everything else it knows about. */
const NAME_FALLBACK: Record<string, string> = { cmn: 'Mandarin Chinese', yue: 'Cantonese' };
const ENDONYM_FALLBACK: Record<string, string> = { cmn: '普通话', yue: '粵語' };

/** Region suffixes for the locales where one language ships under several tags. */
const REGION_NAMES: Record<string, string> = {
  AU: 'Australia', GB: 'United Kingdom', IN: 'India', ES: 'Spain', US: 'United States',
  CA: 'Canada', PT: 'Portugal', BD: 'Bangladesh', TW: 'Taiwan', BR: 'Brazil',
  CN: 'China', FR: 'France', '419': 'Latin America',
};

function primary(code: string): string {
  return code.split('-')[0]!;
}

function regionOf(code: string): string | null {
  const parts = code.split('-');
  return parts.length > 1 ? parts[parts.length - 1]! : null;
}

function nameFor(code: string, disambiguate: boolean): string {
  const p = primary(code);
  const base = EN_NAMES[p] ?? NAME_FALLBACK[p] ?? p;
  const region = regionOf(code);
  if (!disambiguate || !region) return base;
  return `${base} (${REGION_NAMES[region] ?? region})`;
}

function endonymFor(code: string): string | null {
  const p = primary(code);
  const names = cldrNames(p);
  const own = names?.[p];
  if (own) return own;
  return ENDONYM_FALLBACK[p] ?? null;
}

// ---------------------------------------------------------------------------------------
// Per-language rules
// ---------------------------------------------------------------------------------------

/**
 * Scripts written without spaces between words. Get this wrong and every CER computed for
 * the language is garbage: spacing is arbitrary on both sides, so it must be stripped
 * before scoring, and WER — which is whitespace-tokenized — becomes meaningless.
 */
const SCRIPTIO_CONTINUA = new Set(['Mymr', 'Khmr', 'Thai', 'Laoo', 'Jpan', 'Hani']);

/**
 * The 44 Google handles that no OpenAI model accepts, from the 2026-07-30 probe. Advisory
 * only — `waveHint` drives docs and default ordering, never behaviour. The authoritative
 * version of this set is recomputed from the committed provider matrix by
 * `thibi lang list --exclusive-to google`, and a test asserts the two agree.
 */
const EXCLUSIVE_TO_GOOGLE = new Set([
  'sq-AL', 'am-ET', 'rup-BG', 'as-IN', 'ast-ES', 'eu-ES', 'my-MM', 'ceb-PH', 'ff-SN', 'lg-UG',
  'ha-NG', 'ig-NG', 'ga-IE', 'jv-ID', 'kea-CV', 'kam-KE', 'km-KH', 'ky-KG', 'lo-LA', 'ln-CD',
  'luo-KE', 'lb-LU', 'mt-MT', 'mn-MN', 'nso-ZA', 'ny-MW', 'oc-FR', 'or-IN', 'om-ET', 'ps-AF',
  'pa-Guru-IN', 'sn-ZW', 'sd-IN', 'si-LK', 'so-SO', 'ckb-IQ', 'su-ID', 'tg-TJ', 'umb-AO',
  'uz-UZ', 'wo-SN', 'xh-ZA', 'yo-NG', 'zu-ZA',
]);

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa']);
const CJK_SCRIPTS = new Set(['Hani', 'Jpan', 'Hang']);

const SENTENCE_ENDERS: Record<string, string[]> = {
  Mymr: ['။', '၊'],
  Khmr: ['។', '៕', '?', '!'],
  Ethi: ['።', '፣', '፧'],
  Armn: ['։', '՞', '՜'],
  Grek: ['.', '·', ';'],
  Hani: ['。', '！', '？'],
  Jpan: ['。', '！', '？'],
  // A superset is safe for a *detection* list: Arabic uses '.', Urdu and Pashto '۔'.
  Arab: ['.', '۔', '؟', '!'],
  Hebr: ['.', '?', '!'],
  // Thai and Lao mark clause boundaries with a space and have no sentence terminator.
  Thai: [],
  Laoo: [],
};

const DEFAULT_ENDERS = ['.', '!', '?'];

/** Only the well-established conventions. Everything else takes the untuned default. */
const QUOTES: Record<string, [string, string]> = {
  'fr-FR': ['«', '»'], 'fr-CA': ['«', '»'], 'de-DE': ['„', '“'],
  'ru-RU': ['«', '»'], 'uk-UA': ['«', '»'], 'be-BY': ['«', '»'], 'bg-BG': ['«', '»'],
  'sr-RS': ['„', '“'], 'mk-MK': ['„', '“'], 'kk-KZ': ['«', '»'], 'ky-KG': ['«', '»'],
  'mn-MN': ['«', '»'], 'tg-TJ': ['«', '»'],
  'ja-JP': ['「', '」'], 'cmn-Hans-CN': ['「', '」'], 'cmn-Hant-TW': ['「', '」'],
  'yue-Hant-HK': ['「', '」'],
};

const ALT_NAMES: Record<string, string[]> = {
  'cmn-Hans-CN': ['zh', 'zh-CN', 'zh-Hans', 'Chinese', 'Mandarin', 'Simplified Chinese'],
  'cmn-Hant-TW': ['zh-TW', 'zh-Hant', 'Traditional Chinese'],
  'yue-Hant-HK': ['zh-HK', 'Yue'],
  'fil-PH': ['tl', 'tgl', 'Tagalog'],
  'nb-NO': ['no', 'nor', 'Norwegian'],
  // Legacy ISO codes that predate the current ones and still turn up in imported data.
  'he-IL': ['iw'],
  'id-ID': ['in'],
  'my-MM': ['Myanmar'],
  'pa-Guru-IN': ['pa-IN', 'Panjabi'],
  'ckb-IQ': ['Sorani', 'Sorani Kurdish', 'Kurdish (Sorani)'],
  'ff-SN': ['Fulah', 'Fulfulde', 'Pulaar'],
  'ny-MW': ['Chichewa', 'Chewa'],
  'or-IN': ['Oriya'],
  'nso-ZA': ['Sepedi', 'Pedi'],
  'jv-ID': ['Javanese'],
};

function waveHintFor(code: string, script: string): string | null {
  if (CJK_SCRIPTS.has(script)) return 'skip';
  if (!EXCLUSIVE_TO_GOOGLE.has(code)) return 'covered-by-openai';
  if (RTL_SCRIPTS.has(script)) return 'rtl';
  return script === 'Latn' ? 'latin-exclusive' : 'asia-nonlatin';
}

function textRules(code: string, script: string) {
  const continua = SCRIPTIO_CONTINUA.has(script);
  return {
    wordSegmentation: continua ? 'none' : 'spaces',
    // ' ' for Myanmar is measured, not assumed: Google emits syllable-spaced Burmese and
    // we preserve provider output. The other scriptio-continua scripts get '' because we
    // have no such measurement and inserting spaces would be inventing orthography.
    wordJoin: !continua || script === 'Mymr' ? ' ' : '',
    normalizers: ['nfc', 'zero-width', 'collapse-ws'],
    // Zawgyi is a Burmese font-encoding problem, not a script-wide one.
    zawgyiApplies: code === 'my-MM',
    punctuation: {
      sentenceEnders: SENTENCE_ENDERS[script] ?? DEFAULT_ENDERS,
      quotes: QUOTES[code] ?? ['“', '”'],
    },
    cerStripsWhitespace: continua,
    reportWer: !continua,
  };
}

function subtitleRules(script: string) {
  const continua = SCRIPTIO_CONTINUA.has(script);
  return {
    cpsMax: continua ? 12 : 17,
    charsPerLineMax: continua ? 24 : 42,
    maxLines: 2,
    // ICU knows word boundaries for Thai, Lao and Khmer. It does not for Myanmar, which
    // falls back to grapheme clusters — CPS counts graphemes, not code points, because
    // မင်္ဂလာပါခင်ဗျာ is 15 code points and 11 graphemes.
    lineBreak: ['Thai', 'Laoo', 'Khmr'].includes(script)
      ? 'icu'
      : ['Mymr', 'Jpan', 'Hani'].includes(script)
        ? 'grapheme'
        : 'space',
  };
}

async function fetchSentences(cfg: string): Promise<string[]> {
  // 128 KB is a few hundred rows — enough that a 2%-of-rows digraphia signal is more than
  // a handful of sentences, and still one ranged request rather than a whole-file download
  // for each of 102 languages. FLEURS repeats each sentence across speakers, so the row
  // count overstates distinct sentences; the ratio is what matters, not the absolute.
  const res = await fetch(HF_FILE(cfg), { headers: { Range: 'bytes=0-131072' } });
  if (!res.ok && res.status !== 206) throw new Error(`${cfg}: HTTP ${res.status}`);
  const rows = parseFleursTsv(await res.text());
  // The ranged read almost certainly cut the final row in half; drop it.
  return rows
    .slice(0, -1)
    .map((r) => r.rawTranscription)
    .filter((s) => s.length > 0);
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx === -1 ? 'data/languages.json' : process.argv[outIdx + 1]!;

  const tree = (await (await fetch(HF_TREE)).json()) as Array<{ type: string; path: string }>;
  const configs = tree
    .filter((e) => e.type === 'directory')
    .map((e) => e.path.replace(/^data\//, ''))
    .sort();
  console.error(`FLEURS configs: ${configs.length}`);

  const codeOf = (cfg: string): string => {
    const mapped = CONFIG_EXCEPTIONS[cfg];
    if (mapped) return mapped;
    const [lang, region] = cfg.split('_');
    return `${lang}-${region!.toUpperCase()}`;
  };

  // Which primary subtags appear more than once -> those names get a region suffix.
  const allCodes = [...configs.map(codeOf), ...NON_FLEURS, ...EXTRA_LOCALES];
  const primaryCounts = new Map<string, number>();
  for (const c of allCodes) primaryCounts.set(primary(c), (primaryCounts.get(primary(c)) ?? 0) + 1);

  const inferred = new Map<string, Classification>();
  const CONCURRENCY = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= configs.length) return;
        const cfg = configs[i]!;
        try {
          const result = classify(await fetchSentences(cfg));
          inferred.set(codeOf(cfg), result);
          const flag = result.confidence < 0.9 ? '  <-- REVIEW' : '';
          const alt = result.altScripts.length ? ` +${result.altScripts.join(',')}` : '';
          console.error(
            `${codeOf(cfg).padEnd(12)} ${result.script}${alt.padEnd(8)} ` +
              `${(result.confidence * 100).toFixed(1)}%${flag}`,
          );
        } catch (err) {
          console.error(`${cfg}: FAILED ${(err as Error).message}  <-- REVIEW`);
        }
      }
    }),
  );

  const unresolved: string[] = [];
  const lowConfidence: string[] = [];
  const digraphic: string[] = [];

  const languages = Object.fromEntries(
    allCodes.sort().map((code) => {
      const cfg = configs.find((c) => codeOf(c) === code) ?? null;
      const guess = inferred.get(code);
      const script = guess?.script ?? HAND_ASSIGNED[code] ?? null;
      if (!script) unresolved.push(code);
      if (guess && guess.confidence < 0.9) lowConfidence.push(`${code} ${guess.confidence.toFixed(3)}`);
      if (guess?.altScripts.length) digraphic.push(`${code} ${script}+${guess.altScripts.join(',')}`);

      return [
        code,
        {
          code,
          iso639_1: primary(code).length === 2 ? primary(code) : null,
          iso639_3: ISO_639_1_TO_3[primary(code)] ?? primary(code),
          nameEn: nameFor(code, (primaryCounts.get(primary(code)) ?? 0) > 1),
          endonym: endonymFor(code),
          altNames: ALT_NAMES[code] ?? [],
          script: script ?? 'Zyyy',
          altScripts: guess?.altScripts ?? [],
          region: regionOf(code),
          text: textRules(code, script ?? 'Zyyy'),
          subtitle: subtitleRules(script ?? 'Zyyy'),
          fleurs: { config: cfg },
          waveHint: waveHintFor(code, script ?? 'Zyyy'),
          seed:
            code === 'my-MM'
              ? {
                  tier: 'verified',
                  enabled: true,
                  humanReviewed: true,
                  notes:
                    'Verified by operational use since 2026, not by the harness. CER to be ' +
                    'measured in Phase 5. The harness can award beta and experimental on its ' +
                    'own; it can never award verified.',
                }
              : { tier: 'experimental', enabled: true, humanReviewed: false, notes: null },
        },
      ];
    }),
  );

  const file = {
    _meta: {
      seededFrom:
        '102 FLEURS configs (huggingface.co/api/datasets/google/fleurs) + 5 non-FLEURS ' +
        'Google locales + 9 extra locales = 116. Scripts inferred from each language\'s own ' +
        'FLEURS reference text by sentence-majority Unicode script, then human-reviewed; ' +
        'the 14 codes with no FLEURS config are hand-assigned in scripts/infer-scripts.ts. ' +
        'Names and endonyms from CLDR; endonym is null where CLDR has nothing rather than ' +
        'guessed.',
      seededAt: new Date().toISOString().slice(0, 10),
      reconciledWithProbe: null,
      provenance: {
        subtitle:
          'default, untuned — cpsMax/charsPerLineMax are guesses to be measured in Phase 7 ' +
          'and must not be read as measurements.',
        punctuation: 'default, untuned except for the well-established quote conventions.',
        waveHint: 'advisory only; drives docs and default ordering, never behaviour.',
      },
    },
    languages,
  };

  writeFileSync(out, JSON.stringify(file, null, 2) + '\n');

  console.error(`\nwrote ${Object.keys(languages).length} languages to ${out}`);
  console.error(`hand-assigned (no FLEURS reference): ${Object.keys(HAND_ASSIGNED).length}`);
  console.error(`digraphic (altScripts from measured whole-sentence share): ${digraphic.join(', ') || 'none'}`);
  console.error(`low confidence, needs a human: ${lowConfidence.join(', ') || 'none'}`);
  if (unresolved.length) {
    console.error(`UNRESOLVED — add to HAND_ASSIGNED: ${unresolved.join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
