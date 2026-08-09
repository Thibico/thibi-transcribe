export type Direction = 'ltr' | 'rtl';
export type Tier = 'verified' | 'beta' | 'experimental' | 'unsupported';
export type ZeroWidth = 'strip' | 'keep';

/**
 * `zawgyi` is declared here but is deliberately absent from every language's
 * `text.normalizers` chain. Zawgyi conversion is not length-preserving, so it must be
 * applied per *word* with segment text re-derived afterwards — doing it at segment level
 * desynchronises word alignment. Phase 1 wires it in at the right place; a plain
 * string -> string normalizer is the wrong shape for it. `text.zawgyiApplies` is the flag
 * that says a language needs it at all.
 */
export type NormalizerId = 'nfc' | 'collapse-ws' | 'zero-width' | 'digits' | 'zawgyi';

/** Script-level defaults. A language may override any of typography/zeroWidth/digits. */
export interface ScriptEntry {
  /** ISO 15924, e.g. 'Mymr'. */
  code: string;
  nameEn: string;
  direction: Direction;
  /** Needs shaping/reordering — drives the editor's rendering checks, not just fonts. */
  complex: boolean;
  /**
   * Inclusive codepoint ranges. Used by the eval harness's script-integrity check, which
   * is what catches the Groq romanization failure that CER only catches by accident.
   */
  unicodeRanges: Array<[number, number]>;
  /** Whether CER and the chunk-overlap LCS operate on graphemes or codepoints. */
  clusters: 'grapheme' | 'codepoint';
  typography: Typography;
  zeroWidth: { zwsp: ZeroWidth; zwnj: ZeroWidth; zwj: ZeroWidth };
  /**
   * `native` is ordered: the first set is what 'native' policy emits, and *every* set is
   * folded by 'latin' policy. Arabic script needs both — Arabic-Indic (U+0660) for Arabic
   * itself and Extended Arabic-Indic (U+06F0) for Persian, Pashto and Urdu — and a single
   * string would silently leave one of them unfolded.
   */
  digits: { native: string[]; foldToLatin: boolean };
}

export interface Typography {
  /** Family name as declared in apps/web/app/fonts.ts. */
  fontFamily: string | null;
  /** next/font/google subset id, e.g. 'myanmar'. null => no Google Font, use a local fallback. */
  googleFontSubset: string | null;
  cssStack: string;
  /** Not cosmetic: Mymr/Khmr/Sinh stack diacritics vertically and clip at 1.5. */
  lineHeight: number;
  minFontPx: number;
}

export interface TextRules {
  /** 'none' => scriptio continua: CER strips whitespace, WER is meaningless, LCS uses graphemes. */
  wordSegmentation: 'spaces' | 'none' | 'icu';
  /**
   * How words are rejoined into segment text after per-word transforms. ' ' even for Mymr
   * — Google emits syllable-spaced Burmese and we preserve provider output.
   */
  wordJoin: ' ' | '';
  /** Ordered chain applied to provider output to produce segments.text. text_raw keeps the bytes. */
  normalizers: NormalizerId[];
  zawgyiApplies: boolean;
  zeroWidthPolicy?: Partial<ScriptEntry['zeroWidth']>;
  digits?: 'latin' | 'native' | 'preserve';
  punctuation: { sentenceEnders: string[]; quotes: [string, string] };
  /** The tiering metric strips whitespace for these — spacing is arbitrary on both sides. */
  cerStripsWhitespace: boolean;
  /** false => the harness reports WER as null rather than a number that cannot be compared. */
  reportWer: boolean;
}

export interface SubtitleRules {
  cpsMax: number;
  charsPerLineMax: number;
  maxLines: number;
  lineBreak: 'space' | 'grapheme' | 'icu';
}

/**
 * The seeded tier, per §0.5 of the phase plan. Superseded by a `language_support` row the
 * moment one exists, which is what makes shipping a new tier a DB write rather than a
 * deploy.
 *
 * Note what the seed says out loud: the one `verified` language is verified by *human
 * judgement*, not by the harness. The harness can award `beta` and `experimental` on its
 * own; it can never award `verified`.
 */
export interface SeedSupport {
  tier: Tier;
  enabled: boolean;
  humanReviewed: boolean;
  notes: string | null;
}

export interface LanguageEntry {
  /** Canonical registry key = the Google BCP-47 tag. 'my-MM', 'pa-Guru-IN', 'cmn-Hans-CN'. */
  code: string;
  iso639_1: string | null;
  iso639_3: string;
  nameEn: string;
  /** null when no trustworthy source exists — the picker falls back to nameEn. Never guess. */
  endonym: string | null;
  altNames: string[];
  /** ScriptEntry.code. Inferred from FLEURS reference text, then human-reviewed. */
  script: string;
  /**
   * Other scripts this language is genuinely written in, and that provider output in
   * therefore must not be penalised for.
   *
   * Populated only where the reference corpus actually shows it, never from a hunch:
   * `sr-RS` is 93% Latin / 7% Cyrillic across the FLEURS dev set, with 11 of 199 rows
   * wholly Cyrillic. Without this field the eval harness's script-integrity check — whose
   * whole job is catching a provider that returns the wrong script, like Groq romanizing
   * Burmese — would report a correct Cyrillic Serbian transcript as a failure.
   */
  altScripts: string[];
  region: string | null;
  typography?: Partial<Typography>;
  text: TextRules;
  subtitle: SubtitleRules;
  /** FLEURS config id, e.g. 'my_mm'. null for the five non-FLEURS Google extras. */
  fleurs: { config: string | null };
  /** Advisory only — drives docs and default ordering, never behaviour. */
  waveHint: 'latin-exclusive' | 'asia-nonlatin' | 'rtl' | 'covered-by-openai' | 'skip' | null;
  seed: SeedSupport;
}

export type ProviderId = 'google' | 'openai' | 'groq' | 'faster-whisper';

export interface ProviderLanguageCapability {
  /** Did the API accept the code? Set only by the probe. */
  status: 'accepted' | 'rejected' | 'error' | 'unknown';
  /** Do we claim it works? A 200 sets this true; only an override or the eval harness sets false. */
  supported: boolean;
  /** How we know. 'probe-only' is the default and means "accepted, quality unmeasured". */
  verdict: 'probe-only' | 'measured-ok' | 'measured-failure' | 'suspected';
  reason?: string;
  evidence?: string;
  /** The code to actually send: 'my-MM' for Google, 'my' for Whisper endpoints. */
  providerCode: string;
  models?: string[];
  /**
   * null = unknown, not false. The 2 s probe clip is Burmese, so a code that returns an
   * empty transcript tells us nothing about whether it *would* return word offsets.
   * Recording that as `false` would manufacture a finding out of silence.
   */
  wordTimestamps: boolean | null;
  adaptation: 'none' | 'phrase-set' | 'prompt' | 'unknown';
  httpStatus?: number;
  errorMessage?: string;
  /** ISO date. */
  probedAt: string;
}

/** One `language_support` row, merged over the static entry at resolve time. */
export interface LanguageSupportOverride {
  code: string;
  tier?: Tier;
  enabled?: boolean;
  cer?: number | null;
  cerNoSpace?: number | null;
  cerBaseline?: number | null;
  cerRatio?: number | null;
  evalDate?: string | null;
  evalN?: number | null;
  humanReviewed?: boolean;
  notes?: string | null;
}

export interface ResolvedSupport {
  cer: number | null;
  cerNoSpace: number | null;
  cerBaseline: number | null;
  cerRatio: number | null;
  evalDate: string | null;
  evalN: number | null;
  humanReviewed: boolean;
  notes: string | null;
}

/** The shape every engine stage and every React component receives. */
export interface ResolvedLanguage extends Omit<LanguageEntry, 'typography' | 'seed'> {
  scriptEntry: ScriptEntry;
  direction: Direction;
  /** Script defaults merged with language overrides. */
  typography: Typography;
  tier: Tier;
  enabled: boolean;
  support: ResolvedSupport;
  providers: Partial<Record<ProviderId, ProviderLanguageCapability>>;
}

export interface LanguageFilter {
  tier?: Tier[];
  /** Languages this provider supports. */
  provider?: ProviderId;
  enabledOnly?: boolean;
  /** Supported by this provider and by no other. `exclusiveTo: 'google'` is the "44". */
  exclusiveTo?: ProviderId;
  script?: string;
}

export interface LanguageRegistry {
  get(code: string): ResolvedLanguage | null;
  list(filter?: LanguageFilter): ResolvedLanguage[];
  /** 'my' | 'mya' | 'MY-mm' | 'Burmese' | 'my-MM' -> 'my-MM'. Unknown -> null. Never throws. */
  normalizeCode(input: string): string | null;
  /** Re-merge DB overrides without rebuilding the static layer. */
  refresh(overrides: readonly LanguageSupportOverride[]): void;
  readonly generatedAt: string;
}

/** The shape of the committed, generated provider matrix. */
export interface ProviderMatrixFile {
  _meta: { schema: number; generatedBy: string };
  providers: Partial<
    Record<
      ProviderId,
      {
        model?: string;
        models?: string[];
        region?: string;
        probedAt: string;
        clipSha256: string;
        codesTried: number;
        accepted: number;
        rejected: number;
        unknown: number;
        errored: number;
      }
    >
  >;
  languages: Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>;
}

/** `data/matrix-overrides.json`: hand-judged corrections, merged last, never machine-written. */
export type MatrixOverrides = Partial<
  Record<ProviderId, Record<string, Partial<ProviderLanguageCapability>>>
>;
