// @thibi/languages — the language registry.
//
// Three layers: version-controlled JSON -> a compiled, deeply frozen TS object -> DB
// overrides merged at resolve time. This package never touches Postgres; `language_support`
// rows arrive as an argument to createRegistry(). That is what keeps the dependency
// direction one-way and lets a React client component import the registry directly.

export {
  createRegistry,
  listLanguages,
  normalizeCode,
  resolveLanguage,
} from './registry.js';

export {
  applyNormalizers,
  collapseWs,
  digits,
  nfc,
  normalizeText,
  normalizerContext,
  zeroWidth,
  type Normalizer,
  type NormalizerContext,
} from './normalizers/index.js';

export {
  chooseProvider,
  providerRows,
  type ChooseOptions,
  type ProviderChoice,
  type ProviderRow,
} from './choose.js';

export {
  GENERATED_AT,
  LANGUAGES,
  PROVIDER_MATRIX,
  SCRIPTS,
} from './generated/registry.gen.js';

export {
  hasMeasurement,
  measuredTier,
  MEASURED_TIERS,
  TIERS_GENERATED_AT,
  TIERS_RUN_ID,
  type MeasuredTier,
} from './tiers.js';

export type {
  Direction,
  LanguageEntry,
  LanguageFilter,
  LanguageRegistry,
  LanguageSupportOverride,
  MatrixOverrides,
  NormalizerId,
  ProviderId,
  ProviderLanguageCapability,
  ProviderMatrixFile,
  ResolvedLanguage,
  ResolvedSupport,
  ScriptEntry,
  SeedSupport,
  SubtitleRules,
  TextRules,
  Tier,
  TierSource,
  Typography,
  ZeroWidth,
} from './types.js';
