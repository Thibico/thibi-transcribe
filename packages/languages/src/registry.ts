import { GENERATED_AT, LANGUAGES, PROVIDER_MATRIX, SCRIPTS } from './generated/registry.gen.js';
import { hasMeasurement, measuredTier } from './tiers.js';
import type {
  LanguageEntry,
  LanguageFilter,
  LanguageRegistry,
  LanguageSupportOverride,
  ProviderId,
  ResolvedLanguage,
  ScriptEntry,
  Tier,
} from './types.js';

/**
 * Three layers, deliberately:
 *
 *   1. `data/*.json`      code-adjacent facts, version controlled
 *   2. `registry.gen.ts`  compiled, deeply frozen, committed, importable from a client component
 *   2b. `tiers.gen.ts`    what the eval harness measured, compiled from `results/tiers.json`
 *   3. `language_support` tier/CER/enabled, set per instance by an admin
 *
 * This package never touches Postgres. Layer 3 arrives as an argument to `createRegistry`.
 * That is what keeps the dependency direction one-way and the registry importable from
 * React — and it is the seam that makes shipping a new tier a DB write, not a deploy.
 */

// ---------------------------------------------------------------------------------------
// Alias table
// ---------------------------------------------------------------------------------------

/**
 * `normalizeCode` must not be a regex. `pa-Guru-IN` and `cmn-Hans-CN` put a script subtag
 * in the middle of the tag, and naive `lang-REGION` splitting produces `pa-IN`, which does
 * not exist. Everything resolvable is enumerated here instead, derived from the data.
 */
function primarySubtag(code: string): string {
  return code.split('-')[0] ?? code;
}

function aliasKey(input: string): string {
  return input.trim().toLowerCase().replaceAll('_', '-');
}

function buildAliases(): ReadonlyMap<string, string> {
  const claims = new Map<string, Set<string>>();
  const claim = (alias: string | null | undefined, code: string): void => {
    if (!alias) return;
    const key = aliasKey(alias);
    if (!key) return;
    let set = claims.get(key);
    if (!set) claims.set(key, (set = new Set()));
    set.add(code);
  };

  for (const entry of Object.values(LANGUAGES)) {
    claim(entry.iso639_1, entry.code);
    claim(entry.iso639_3, entry.code);
    claim(entry.nameEn, entry.code);
    claim(primarySubtag(entry.code), entry.code);
    for (const alt of entry.altNames) claim(alt, entry.code);
  }

  const aliases = new Map<string, string>();
  for (const [key, codes] of claims) {
    if (codes.size === 1) {
      aliases.set(key, [...codes][0]!);
      continue;
    }
    // `en` is claimed by en-US, en-GB, en-AU and en-IN; `pt` by pt-BR and pt-PT. The FLEURS
    // locale is the canonical one for a bare subtag — it is the variant the registry was
    // seeded from and the one the eval harness measures. If two candidates both have a
    // FLEURS config the alias is genuinely ambiguous and is dropped rather than guessed.
    const canonical = [...codes].filter((c) => LANGUAGES[c]?.fleurs.config !== null);
    if (canonical.length === 1) aliases.set(key, canonical[0]!);
  }

  // Exact registry keys always win, whatever any alias claimed.
  for (const code of Object.keys(LANGUAGES)) aliases.set(aliasKey(code), code);

  return aliases;
}

const ALIASES = buildAliases();

/**
 * Never throws, never returns a code that is not in the registry. Unknown input — including
 * a path, an empty string or a tag Intl rejects — is `null`.
 */
export function normalizeCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const direct = ALIASES.get(aliasKey(input));
  if (direct) return direct;

  // Last resort for odd casing or subtag ordering that the lowercase key missed.
  // getCanonicalLocales throws RangeError on a malformed tag, which is a valid "no".
  try {
    const [canonical] = Intl.getCanonicalLocales(input.trim());
    if (canonical) return ALIASES.get(aliasKey(canonical)) ?? null;
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------

const EMPTY_SUPPORT = {
  cer: null,
  cerNoSpace: null,
  cerBaseline: null,
  cerRatio: null,
  evalDate: null,
  evalN: null,
} as const;

function resolveEntry(
  entry: LanguageEntry,
  script: ScriptEntry,
  override: LanguageSupportOverride | undefined,
): ResolvedLanguage {
  const { typography: languageTypography, seed, ...rest } = entry;

  /**
   * Layer 2b: what the harness measured, compiled in from `results/tiers.json`.
   *
   * Only a language the harness has *actually measured* has a row here. The
   * all-experimental fallback in `tiers.ts` answers "what has been measured" and must not
   * reach this line: applied as a tier it would demote `my-MM` — verified by operational
   * use, never by the harness — on every checkout where nobody had run an eval.
   */
  const measured = hasMeasurement(entry.code) ? measuredTier(entry.code) : null;
  const baseline = measured?.cerNospace !== null && measured?.ratio
    ? measured.cerNospace / measured.ratio
    : null;

  return {
    ...rest,
    scriptEntry: script,
    direction: script.direction,
    // Merge order is script defaults -> language overrides. A language never has to restate
    // a whole Typography block to nudge one field.
    typography: { ...script.typography, ...languageTypography },
    tier: override?.tier ?? measured?.tier ?? seed.tier,
    /**
     * Risk 9: an admin promoting a language in the database is intended — a newsroom that
     * has validated Hausa on its own material should be able to say so — but the UI has to
     * show *how* a tier was arrived at, or the whole measurement discipline leaks through
     * the one row nobody remembers was hand-set.
     */
    tierSource: override?.tier !== undefined ? 'override' : measured ? 'measured' : 'seed',
    enabled: override?.enabled ?? seed.enabled,
    support: {
      ...EMPTY_SUPPORT,
      cer: override?.cer ?? measured?.cer ?? null,
      cerNoSpace: override?.cerNoSpace ?? measured?.cerNospace ?? null,
      cerBaseline: override?.cerBaseline ?? baseline,
      cerRatio: override?.cerRatio ?? measured?.ratio ?? null,
      evalDate: override?.evalDate ?? measured?.evalDate ?? null,
      evalN: override?.evalN ?? measured?.n ?? null,
      humanReviewed: override?.humanReviewed ?? measured?.humanReviewed ?? seed.humanReviewed,
      notes: override?.notes ?? seed.notes,
    },
    providers: PROVIDER_MATRIX[entry.code] ?? {},
  };
}

function isSupportedBy(language: ResolvedLanguage, provider: ProviderId): boolean {
  return language.providers[provider]?.supported === true;
}

function matches(language: ResolvedLanguage, filter: LanguageFilter): boolean {
  if (filter.tier && !filter.tier.includes(language.tier)) return false;
  if (filter.enabledOnly && !language.enabled) return false;
  if (filter.script && language.script !== filter.script) return false;
  if (filter.provider && !isSupportedBy(language, filter.provider)) return false;
  if (filter.notSupportedBy && isSupportedBy(language, filter.notSupportedBy)) return false;
  if (filter.exclusiveTo) {
    if (!isSupportedBy(language, filter.exclusiveTo)) return false;
    const others = (Object.keys(language.providers) as ProviderId[]).filter(
      (p) => p !== filter.exclusiveTo,
    );
    if (others.some((p) => isSupportedBy(language, p))) return false;
  }
  return true;
}

/**
 * Build a registry over the static data with a set of `language_support` rows merged in.
 *
 * Deliberately not a module-global singleton: the CLI builds one from the DB, the worker
 * refreshes its own on NOTIFY (Phase 9), and a test builds one from a fixture array. Two
 * registries with different overrides must not be able to see each other's state.
 */
export function createRegistry(
  overrides: readonly LanguageSupportOverride[] = [],
): LanguageRegistry {
  let byCode = new Map<string, LanguageSupportOverride>();
  let cache = new Map<string, ResolvedLanguage>();

  const load = (rows: readonly LanguageSupportOverride[]): void => {
    byCode = new Map();
    for (const row of rows) {
      // An override naming a code the registry does not have is ignored, not thrown. A
      // stale DB row must not be able to take the app down at boot.
      const code = normalizeCode(row.code);
      if (code) byCode.set(code, row);
    }
    cache = new Map();
  };
  load(overrides);

  const get = (code: string): ResolvedLanguage | null => {
    const key = normalizeCode(code);
    if (!key) return null;
    const cached = cache.get(key);
    if (cached) return cached;

    const entry = LANGUAGES[key];
    if (!entry) return null;
    const script = SCRIPTS[entry.script];
    if (!script) {
      // data-integrity.test.ts makes this unreachable; if it ever fires, the generated file
      // and the script table have drifted and guessing a fallback would hide it.
      throw new Error(`Language ${key} references unknown script '${entry.script}'`);
    }

    const resolved = resolveEntry(entry, script, byCode.get(key));
    cache.set(key, resolved);
    return resolved;
  };

  return {
    get,
    list(filter: LanguageFilter = {}): ResolvedLanguage[] {
      const out: ResolvedLanguage[] = [];
      for (const code of Object.keys(LANGUAGES)) {
        const language = get(code);
        if (language && matches(language, filter)) out.push(language);
      }
      return out.sort((a, b) => a.code.localeCompare(b.code, 'en'));
    },
    normalizeCode,
    refresh(rows: readonly LanguageSupportOverride[]): void {
      load(rows);
    },
    generatedAt: GENERATED_AT,
  };
}

/** Static-only convenience for callers with no database — the CLI, tests, the build. */
export function resolveLanguage(
  code: string,
  overrides: readonly LanguageSupportOverride[] = [],
): ResolvedLanguage | null {
  return createRegistry(overrides).get(code);
}

/** Static-only convenience. Seeded tiers only; no `language_support` rows applied. */
export function listLanguages(filter?: LanguageFilter): ResolvedLanguage[] {
  return createRegistry().list(filter);
}

export type { Tier };
