/**
 * Validates `data/*.json` and emits `src/generated/registry.gen.ts`.
 *
 * Why a compile step rather than importing the JSON directly: a React client component
 * importing JSON in Next needs either an import attribute or a bundler-specific loader,
 * and either way the whole file lands in the client bundle unfrozen and un-tree-shakeable.
 * A plain object literal in a TS module is frozen at module scope, typed, and tree-shakes.
 *
 * The output is committed so `next dev` and `tsc` work with no prior build, and CI runs
 * `pnpm gen && git diff --exit-code` as the drift guard.
 *
 *   pnpm --filter @thibi/languages gen
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

// --- Schemas ---------------------------------------------------------------------------

const Typography = z.object({
  fontFamily: z.string().nullable(),
  googleFontSubset: z.string().nullable(),
  cssStack: z.string(),
  lineHeight: z.number().positive(),
  minFontPx: z.number().int().positive(),
});

const ZeroWidth = z.enum(['strip', 'keep']);

const ScriptEntry = z.object({
  code: z.string().regex(/^[A-Z][a-z]{3}$/, 'ISO 15924 is one uppercase then three lowercase'),
  nameEn: z.string().min(1),
  direction: z.enum(['ltr', 'rtl']),
  complex: z.boolean(),
  unicodeRanges: z
    .array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]))
    .min(1)
    .refine((rs) => rs.every(([lo, hi]) => lo <= hi), 'every range must be ascending')
    .refine(
      (rs) => rs.every((r, i) => i === 0 || r[0] > rs[i - 1]![1]),
      'ranges must be sorted and non-overlapping',
    ),
  clusters: z.enum(['grapheme', 'codepoint']),
  typography: Typography,
  zeroWidth: z.object({ zwsp: ZeroWidth, zwnj: ZeroWidth, zwj: ZeroWidth }),
  digits: z.object({
    native: z.array(z.string().refine((s) => [...s].length === 10, 'a digit set is ten characters')),
    foldToLatin: z.boolean(),
  }),
});

const NormalizerId = z.enum(['nfc', 'collapse-ws', 'zero-width', 'digits', 'zawgyi']);

const TextRules = z.object({
  wordSegmentation: z.enum(['spaces', 'none', 'icu']),
  wordJoin: z.enum([' ', '']),
  normalizers: z.array(NormalizerId),
  zawgyiApplies: z.boolean(),
  zeroWidthPolicy: z.object({ zwsp: ZeroWidth, zwnj: ZeroWidth, zwj: ZeroWidth }).partial().optional(),
  digits: z.enum(['latin', 'native', 'preserve']).optional(),
  punctuation: z.object({
    sentenceEnders: z.array(z.string()),
    quotes: z.tuple([z.string(), z.string()]),
  }),
  cerStripsWhitespace: z.boolean(),
  reportWer: z.boolean(),
});

const LanguageEntry = z.object({
  code: z.string().min(2),
  iso639_1: z.string().length(2).nullable(),
  iso639_3: z.string().min(2),
  nameEn: z.string().min(1),
  endonym: z.string().min(1).nullable(),
  altNames: z.array(z.string()),
  script: z.string(),
  altScripts: z.array(z.string()),
  region: z.string().nullable(),
  typography: Typography.partial().optional(),
  text: TextRules,
  subtitle: z.object({
    cpsMax: z.number().positive(),
    charsPerLineMax: z.number().int().positive(),
    maxLines: z.number().int().positive(),
    lineBreak: z.enum(['space', 'grapheme', 'icu']),
  }),
  fleurs: z.object({ config: z.string().nullable() }),
  waveHint: z
    .enum(['latin-exclusive', 'asia-nonlatin', 'rtl', 'covered-by-openai', 'skip'])
    .nullable(),
  seed: z.object({
    tier: z.enum(['verified', 'beta', 'experimental', 'unsupported']),
    enabled: z.boolean(),
    humanReviewed: z.boolean(),
    notes: z.string().nullable(),
  }),
});

const ProviderId = z.enum(['google', 'openai', 'groq', 'faster-whisper']);

const Capability = z.object({
  status: z.enum(['accepted', 'rejected', 'error', 'unknown']),
  supported: z.boolean(),
  verdict: z.enum(['probe-only', 'measured-ok', 'measured-failure', 'suspected']),
  reason: z.string().optional(),
  evidence: z.string().optional(),
  providerCode: z.string(),
  models: z.array(z.string()).optional(),
  wordTimestamps: z.boolean().nullable(),
  adaptation: z.enum(['none', 'phrase-set', 'prompt', 'unknown']),
  httpStatus: z.number().int().optional(),
  errorMessage: z.string().optional(),
  probedAt: z.string(),
});

const ScriptsFile = z.object({ _meta: z.unknown(), scripts: z.record(z.string(), ScriptEntry) });
const LanguagesFile = z.object({ _meta: z.unknown(), languages: z.record(z.string(), LanguageEntry) });
const MatrixFile = z.object({
  _meta: z.unknown(),
  providers: z.record(z.string(), z.unknown()),
  // Partial: a language probed against Google but not yet against faster-whisper has one
  // column, not four. zod's z.record over an enum demands every key.
  languages: z.record(z.string(), z.partialRecord(ProviderId, Capability)),
});
const OverridesFile = z.record(z.string(), z.unknown());

// --- Load and validate -----------------------------------------------------------------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** zod's flattened errors do not name the offending key; a failure must say which language. */
function parseOrDie<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  console.error(`\n${what} failed validation:`);
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

const scriptsFile = parseOrDie(ScriptsFile, readJson('data/scripts.json'), 'data/scripts.json');
const languagesFile = parseOrDie(
  LanguagesFile,
  readJson('data/languages.json'),
  'data/languages.json',
);

// The matrix is produced by `thibi probe languages`. Before the first probe it is absent,
// and a registry with no provider columns is a legitimate intermediate state — not a
// reason to fail the build of a package the probe command itself depends on.
const matrix = existsSync('data/provider-matrix.json')
  ? parseOrDie(MatrixFile, readJson('data/provider-matrix.json'), 'data/provider-matrix.json')
  : { _meta: null, providers: {}, languages: {} };
if (!existsSync('data/provider-matrix.json')) {
  console.error('data/provider-matrix.json absent — emitting an empty provider matrix.');
  console.error('Run `pnpm thibi probe languages --provider all` and regenerate.');
}

const overridesRaw = parseOrDie(
  OverridesFile,
  readJson('data/matrix-overrides.json'),
  'data/matrix-overrides.json',
);

// --- Cross-file integrity --------------------------------------------------------------

const errors: string[] = [];

for (const [code, language] of Object.entries(languagesFile.languages)) {
  if (code !== language.code) errors.push(`${code}: key does not match .code (${language.code})`);
  if (!scriptsFile.scripts[language.script]) {
    errors.push(`${code}: unknown script '${language.script}' — add it to data/scripts.json`);
  }
  for (const alt of language.altScripts) {
    if (!scriptsFile.scripts[alt]) errors.push(`${code}: unknown altScript '${alt}'`);
  }
  if (language.text.normalizers.includes('zawgyi')) {
    errors.push(
      `${code}: 'zawgyi' cannot appear in text.normalizers — it is not length-preserving ` +
        `and must be applied per word. Set text.zawgyiApplies instead.`,
    );
  }
  // The implication only holds one way. `waveHint: 'rtl'` names the wave of RTL languages
  // Google reaches and OpenAI does not, so it must have an RTL script — but plenty of RTL
  // languages (Persian, Hebrew, Urdu) are covered by OpenAI and belong to a different
  // wave. Direction is carried by `scriptEntry.direction`, which is what actually drives
  // rendering; waveHint is advisory and must never be read as a script property.
  const script = scriptsFile.scripts[language.script];
  if (language.waveHint === 'rtl' && script?.direction !== 'rtl') {
    errors.push(`${code}: waveHint is 'rtl' but script '${language.script}' is not right-to-left`);
  }
}

if (errors.length) {
  console.error('\nintegrity errors:');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

// --- Merge the matrix with its overrides -------------------------------------------------

/**
 * Merge order is probe -> overrides. A hand judgement always wins, which is the point: the
 * probe records what the API said, the override records what we know.
 */
const providerMatrix: Record<string, Record<string, unknown>> = {};

for (const code of Object.keys(languagesFile.languages)) {
  const row = { ...(matrix.languages[code] ?? {}) } as Record<string, Record<string, unknown>>;
  for (const [provider, byCode] of Object.entries(overridesRaw)) {
    if (provider.startsWith('_')) continue;
    const patch = (byCode as Record<string, Record<string, unknown>>)[code];
    if (!patch) continue;
    const base = row[provider];
    if (!base) {
      // An override for a provider that was never probed is kept, but it cannot invent an
      // acceptance: status stays 'unknown' and only the judgement fields carry through.
      row[provider] = {
        status: 'unknown',
        supported: false,
        verdict: 'suspected',
        providerCode: code,
        wordTimestamps: null,
        adaptation: 'unknown',
        probedAt: 'never',
        ...patch,
      };
    } else {
      row[provider] = { ...base, ...patch };
    }
  }
  if (Object.keys(row).length) providerMatrix[code] = row;
}

// --- Emit ---------------------------------------------------------------------------------

/** Deterministic: sorted keys and stable formatting, so a re-run's diff is only real change. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function literal(value: unknown): string {
  return JSON.stringify(stable(value), null, 2);
}

// Derived from the inputs, not the clock. `stable()` above exists to make this script a
// pure function of data/*.json so that "a re-run's diff is only real change" — and a
// `new Date()` here was the one thing violating it. The CI drift check regenerates and
// diffs, so from the day after the file was committed it compared a timestamp rather than
// content and went red with no input change at all.
//
// The newest input date is also the more useful claim. What a caller wants from this
// constant is how fresh the *data* is — the probedAt dates the provider matrix carries —
// not when someone last ran the script over unchanged inputs.
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function collectDates(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (ISO_DATE_PREFIX.test(value)) found.push(value.slice(0, 10));
  } else if (Array.isArray(value)) {
    for (const item of value) collectDates(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectDates(item, found);
  }
  return found;
}

// ISO dates sort lexicographically, so max is the last after a plain sort. 'unknown' is
// unreachable while languages.json carries _meta.seededAt, and is here so a stripped-down
// data set degrades to an honest string rather than to today's date.
const generatedAt =
  [scriptsFile, languagesFile, matrix, overridesRaw]
    .flatMap((file) => collectDates(file))
    .sort()
    .at(-1) ?? 'unknown';

const source = `// GENERATED — DO NOT EDIT.
//
// Produced by scripts/gen-languages.ts from data/scripts.json, data/languages.json,
// data/provider-matrix.json and data/matrix-overrides.json.
// Regenerate with \`pnpm --filter @thibi/languages gen\`. CI asserts this file matches
// its inputs, so hand-editing it fails the build rather than taking effect.
//
// Frozen at module scope: this is the reason the registry is a compiled TS object rather
// than an imported JSON file. A client component can import it, it tree-shakes, and
// nothing downstream can mutate the shared table.

import type { LanguageEntry, ProviderLanguageCapability, ProviderId, ScriptEntry } from '../types.js';

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const SCRIPTS: Readonly<Record<string, ScriptEntry>> = deepFreeze(
  ${literal(scriptsFile.scripts)} as Record<string, ScriptEntry>,
);

export const LANGUAGES: Readonly<Record<string, LanguageEntry>> = deepFreeze(
  ${literal(languagesFile.languages)} as Record<string, LanguageEntry>,
);

export const PROVIDER_MATRIX: Readonly<
  Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>
> = deepFreeze(
  ${literal(providerMatrix)} as Record<string, Partial<Record<ProviderId, ProviderLanguageCapability>>>,
);
`;

writeFileSync('src/generated/registry.gen.ts', source);

const providerCounts = new Map<string, number>();
for (const row of Object.values(providerMatrix)) {
  for (const p of Object.keys(row)) providerCounts.set(p, (providerCounts.get(p) ?? 0) + 1);
}
console.error(
  `wrote src/generated/registry.gen.ts — ` +
    `${Object.keys(scriptsFile.scripts).length} scripts, ` +
    `${Object.keys(languagesFile.languages).length} languages, ` +
    `matrix rows: ${[...providerCounts].map(([p, n]) => `${p}=${n}`).join(' ') || 'none'}`,
);
