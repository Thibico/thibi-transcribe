# Phase 0 — Spikes and registries

## Goal

At the end of this phase three questions that can invalidate parts of the design have recorded
answers in `spikes/RESULTS.md`, the monorepo exists and builds, and `packages/languages` ships a
compiled, frozen registry of every Google language with its script, typography, text rules and a
generated `provider-matrix.json`. `thibi lang list --tier verified` prints one row. Nothing here
is user-facing; everything here is load-bearing for every later phase. It goes first because S1
decides whether pre-recognition biasing is a feature at all, S2 decides whether the
low-confidence QA surface can exist, S3 decides whether Phase 2 exists, and because every stage
from Phase 1 onward takes a `ResolvedLanguage` — building the pipeline before the registry means
threading `"my-MM"` through it and unpicking that later, which is exactly the mistake the old app
made at `lib/queue.ts:118`.

## Prerequisites

| Need | Why | Check |
|---|---|---|
| GCP project, Speech-to-Text v2 enabled | all three spikes | `gcloud services list --enabled \| grep speech` |
| Service-account JSON with `roles/speech.client` | S1, S2, S3, probe | `gcloud auth activate-service-account --key-file=sa.json` |
| `roles/storage.objectAdmin` + a bucket in the recognizer region | S3 only | `gsutil mb -l asia-southeast1 gs://…` |
| Node 22, pnpm 10, ffmpeg/ffprobe, `jq`, `gsutil` | everything | `node -v && pnpm -v && ffmpeg -version` |
| A 2 s Burmese clip and a ~90 s clip with 3+ proper nouns | S1/S2 and the probe | committed as fixtures |
| A ≥30 min and a ~2 h file | S3 latency measurement | not committed |
| Groq + OpenAI keys | matrix probe only; optional | — |

## Deliverables

| Path | Purpose |
|---|---|
| `pnpm-workspace.yaml` | workspace globs, `onlyBuiltDependencies` allowlist |
| `package.json` | root scripts, `packageManager`, `engines` |
| `turbo.json` | task graph and cache outputs |
| `tsconfig.base.json` | one compiler config, extended by every package |
| `tsconfig.json` | root solution file listing project references |
| `vitest.config.ts` | `test.projects` over `packages/*` and `apps/*` |
| `eslint.config.js` | flat config + the dependency-direction and `process.env` bans |
| `.nvmrc`, `.npmrc`, `.gitattributes` | Node pin, pnpm strictness, `linguist-generated` |
| `spikes/token.sh` | mints an access token from the SA; sourced by the others |
| `spikes/s1-adaptation.sh` | Chirp phrase-set probe, 3-cell matrix |
| `spikes/s2-word-confidence.ts` | word/confidence census over a language sample |
| `spikes/s3-batch-recognize.sh` | submit → poll → fetch, with wall-clock timing |
| `spikes/RESULTS.md` | the recorded answers; every later plan cites a row here |
| `spikes/raw/` (gitignored) | raw JSON responses |
| `packages/core/` | skeleton: `src/index.ts`, `src/types.ts`, package.json |
| `packages/languages/data/scripts.json` | ISO-15924 script table, hand-maintained |
| `packages/languages/data/languages.json` | ~116 language entries, seeded then reconciled |
| `packages/languages/data/provider-matrix.json` | **generated** by `thibi probe languages` |
| `packages/languages/data/matrix-overrides.json` | hand-judged corrections; merged last |
| `packages/languages/src/types.ts` | `ScriptEntry`, `LanguageEntry`, `ResolvedLanguage`, matrix types |
| `packages/languages/src/registry.ts` | `createRegistry`, `resolveLanguage`, `listLanguages`, `normalizeCode` |
| `packages/languages/src/normalizers/*.ts` | `nfc`, `collapse-ws`, `zero-width`, `digits` (zawgyi lands Phase 1) |
| `packages/languages/src/generated/registry.gen.ts` | frozen TS object; committed, drift-checked |
| `packages/languages/fixtures/probe-2s.flac` | the one clip every probe sends |
| `scripts/gen-languages.ts` | validates `data/*.json` → emits `registry.gen.ts` |
| `scripts/infer-scripts.ts` | one-shot: classify FLEURS reference text by Unicode block |
| `packages/{db,storage,engine,eval}/` | package.json + `src/index.ts` placeholders so the graph is real |
| `apps/{web,worker}/` | placeholders |
| `apps/cli/src/index.ts` | commander root |
| `apps/cli/src/commands/lang.ts` | `thibi lang list \| show` |
| `apps/cli/src/commands/probe-languages.ts` | `thibi probe languages` |

## Design

### 0.1 The three spikes, as decision gates

All three share one preamble. `chirp_2` is the model, `asia-southeast1` the region — not because
of any constraint (the research measured that doctrine false; see Porting notes) but because it is
the nearest region to the primary user.

```bash
# spikes/token.sh — source this
gcloud auth activate-service-account --key-file="${SA_JSON:?}"
export PROJECT_ID=$(jq -r .project_id "$SA_JSON")
export REGION=${REGION:-asia-southeast1}
export TOKEN=$(gcloud auth print-access-token)
export URL="https://$REGION-speech.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/recognizers/_"
```

Each spike writes one row into `spikes/RESULTS.md`:

```
| id | date | region | model | verdict | evidence | raw |
|----|------|--------|-------|---------|----------|-----|
| S1 | 2026-08-12 | asia-southeast1 | chirp_2 | … | … | spikes/raw/s1-*.json |
```

**A spike without a row is not done.** Downstream plans reference the row, not folklore.

---

#### S1 — Does Chirp support speech adaptation?

Three cells, run on the same 90 s clip:

| cell | model | adaptation | purpose |
|---|---|---|---|
| a | `chirp_2` | inline phrase set, boost 15 | the question |
| b | `chirp_2` | none | control — what changed? |
| c | `long` + `en-US` on an English clip | inline phrase set | positive control — is our request shape valid at all? |

```bash
# spikes/s1-adaptation.sh (cell a)
curl -sS -X POST "$URL:recognize" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- <<JSON | tee spikes/raw/s1-a.json
{
  "config": {
    "autoDecodingConfig": {},
    "languageCodes": ["my-MM"],
    "model": "chirp_2",
    "features": { "enableWordTimeOffsets": true, "enableWordConfidence": true },
    "adaptation": {
      "phraseSets": [{
        "inlinePhraseSet": {
          "phrases": [
            { "value": "အောင်ဆန်းစုကြည်", "boost": 15 },
            { "value": "နေပြည်တော်", "boost": 15 }
          ],
          "boost": 10
        }
      }]
    }
  },
  "content": "$(base64 -i fixtures/burmese-90s.flac | tr -d '\n')"
}
JSON
```

A 200 is not an answer. The dangerous outcome is *accepted and silently ignored*, so the gate
requires an A/B: five clips, each containing a proper noun `chirp_2` gets wrong in cell (b), run at
boost 0 / 15 / 20. **Adaptation counts as working only if ≥2 of 5 clips improve on the target term
and none regress.** Repeat cell (a) for `ha-NG`, `yo-NG`, `am-ET`, `ps-AF` — support may be
model-wide or per-language, and the answer becomes a per-language `adaptation` column in the matrix.

| Outcome | Recorded as | Design changes to |
|---|---|---|
| 200 and the A/B shows improvement | `adaptation: 'phrase-set'` | Glossary → inline phrase set is a real feature. Phase 6 wires `glossary_terms.term/variants/boost` into the request. The post-hoc entity pass is still built — it is the only mechanism for providers without adaptation. |
| 200 but output byte-identical to control across all 5 clips | `adaptation: 'none'`, matrix note `accepted-but-inert` | Same as rejection, **plus**: never render a boost control for Chirp; a UI slider that does nothing is worse than no slider. |
| 400 `INVALID_ARGUMENT` naming adaptation/model, cell (c) 200 | `adaptation: 'none'` | Entity pass is *the* entity mechanism, promoted from supplement to primary. Roadmap and marketing must not claim keyterm biasing for Hausa. `resolveModel()` may offer `long`/`short` as an opt-in for the ~30 languages they cover — documented as a Phase 6 hook, not built here. |
| 400 on cell (c) too | inconclusive | Our request shape is wrong. Fix and re-run; do **not** record a verdict. |
| Mixed per language | per-language `adaptation` in the matrix | `capabilities().adaptation` becomes a function of `(model, language)`, which the interface already allows via `supportsLanguage()`. |

Regardless of outcome: `adaptation` is a probed capability, never a hardcoded truth.

---

#### S2 — Is `wordConfidence` actually populated on Chirp?

Same endpoint, `features: { enableWordTimeOffsets: true, enableWordConfidence: true }`, over a
sample chosen to include the long tail where the word array is most likely to be missing:
`my-MM, ha-NG, yo-NG, am-ET, km-KH, ps-AF, ceb-PH, om-ET, zu-ZA, si-LK`.

`spikes/s2-word-confidence.ts` prints one row per language:

```
lang     segs  words  wordsWithConf  distinctConf  minConf  maxConf  segConf
my-MM       6    142            142            37     0.41     0.99    0.94
om-ET       4      0              0             0        -        -    0.71
```

`distinctConf` is the tell: one distinct value means a placeholder, not a measurement.

| Outcome | Recorded as | Design changes to |
|---|---|---|
| words present, confidence varies in (0,1) | `wordConfidence: true` | Low-confidence QA ships for Google. `words.confidence` populated; threshold default 0.6; the `INDEX (run_id) WHERE confidence < 0.5` partial index earns its keep. |
| confidence absent, or a single constant | `wordConfidence: false` | `words.confidence` stored **NULL, never 0** — an unknown must not sort as "bad". The editor hides the uncertain-word toolbar for Google runs and says "word confidence is not available from this provider" rather than implying certainty. faster-whisper (Phase 4) becomes the only provider with real word confidence, and the model picker should say so. |
| segment `confidence` present but word absent | `segmentConfidence: true, wordConfidence: false` | QA degrades to segment-level shading — a strictly worse but still useful surface. Build the resolution `word ?? segment ?? none` in Phase 12 with all three arms. |
| words empty for some language | that language gets `wordTimestamps: false` in the matrix | This is overview Risk 2 made concrete. Phase 1 builds the no-words path first (§1.6 of that plan) and this row is the list of languages that will exercise it. |

Record per language, not as one global answer. `capabilities()` in Phase 1 quotes this table with
the date in a comment, and a live smoke test asserts reality still matches it.

---

#### S3 — Does `batchRecognize` work end to end?

```bash
gsutil mb -l "$REGION" gs://thibi-spike-staging
gsutil cp fixtures/long-2h.flac gs://thibi-spike-staging/in/
```

Submit:

```bash
curl -sS -X POST "$URL:batchRecognize" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{
  "config": { "autoDecodingConfig": {}, "languageCodes": ["my-MM"], "model": "chirp_2",
              "features": { "enableWordTimeOffsets": true, "enableWordConfidence": true } },
  "files": [{ "uri": "gs://thibi-spike-staging/in/long-2h.flac" }],
  "recognitionOutputConfig": { "gcsOutputConfig": { "uri": "gs://thibi-spike-staging/out/" } },
  "processingStrategy": "DYNAMIC_BATCHING"
}' | tee spikes/raw/s3-submit.json
```

Poll `GET https://$REGION-speech.googleapis.com/v2/{operation.name}` every 30 s, logging elapsed
time, until `done: true`. Then read
`response.results["gs://…/in/long-2h.flac"].uri` → `gsutil cat` that JSON.

Five things must be measured, not just "it worked":

1. **Wall clock to `done`** for a 30 min and a 2 h file. This number *is* the routing threshold; the
   overview's 15 min is a hypothesis until this row exists.
2. **Does the output carry word offsets and word confidence?** Batch output has historically
   differed from sync. If batch drops words, batch mode silently degrades `wordTimingQuality` and
   the mode picker must say so.
3. **Offset encoding.** Sync returns `"1.500s"`. If batch returns `{"seconds":1,"nanos":5e8}`, the
   parser needs both branches — cheap to add in Phase 1, expensive to discover in Phase 2.
4. **Does the operation survive a client disconnect?** Kill the poll, wait 10 minutes, resume.
   The whole "long async steps never hold a worker slot" design depends on yes.
5. **Lifecycle rule shape.** `gsutil lifecycle get gs://…` — capture the exact JSON the engine
   must assert before it agrees to stage.

| Outcome | Design changes to |
|---|---|
| Works; 2 h file completes in ≲15 min | Phase 2 proceeds as written. `staging: 'gcs'`, `modes: ['sync','batch']`. Routing threshold = the measured crossover against 8-way chunked sync, not 15 min by assumption. |
| Works but latency is hours or wildly variable | Keep batch, but `mode: auto` never selects it; it becomes an explicit `--mode batch` for overnight jobs, with the latency printed in the confirm dialog. |
| `DYNAMIC_BATCHING` rejected, default batching accepted | Batch still solves the >1 min sync cap but **not** the money. Redo the arithmetic ($0.016 vs $0.003) before Phase 2 is scheduled; chunked sync may simply win. |
| Region/bucket mismatch errors | Engine asserts `bucket.location == recognizer.region` at first use and prints the `gsutil mb -l` fix. Add it to the Phase 2 preflight. |
| Fails end to end | **Phase 2 is cut.** `sync_chunked` is canonical at every duration. `staging` leaves `EngineContext`, `GOOGLE_GCS_STAGING_BUCKET` leaves the config, GCS leaves the compose docs, and the setup wizard loses the $48-vs-$9 page. |

---

### 0.2 Monorepo bootstrap

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
  - services/*
onlyBuiltDependencies:
  - esbuild
  - '@node-rs/argon2'
```

```jsonc
// package.json
{
  "name": "thibi-transcribe",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=22.11" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "gen": "turbo run gen",
    "thibi": "pnpm --filter @thibi/cli exec thibi"
  },
  "devDependencies": {
    "@types/node": "^22",
    "eslint": "^9",
    "turbo": "^2",
    "typescript": "^5.7",
    "typescript-eslint": "^8",
    "vitest": "^3.2"
  }
}
```

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["tsconfig.base.json", ".nvmrc"],
  "tasks": {
    "gen":       { "inputs": ["data/**", "scripts/**"], "outputs": ["src/generated/**"] },
    "build":     { "dependsOn": ["^build", "gen"], "outputs": ["dist/**", "*.tsbuildinfo"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "lint":      { "outputs": [] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "ESNext.Disposable", "ESNext.Intl"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true
  }
}
```

Three decisions worth stating once:

- **ESM everywhere, `tsc -b` project references, no bundler.** `packages/core` must be importable
  from React client components; emitted ESM with a `types`+`import` exports map is the least
  surprising way to do that in Next 16, and it means the CLI can run compiled output with plain
  `node`. Dev runs `tsc -b --watch` under turbo; the CLI runs under `tsx`.
- **`ESNext.Disposable` in `lib` from day one.** Phase 1's `await using` temp-file handles need
  `Symbol.asyncDispose`; discovering that later means touching every package's tsconfig.
- **`noUncheckedIndexedAccess`.** The registry is one giant record lookup and the LCS merge is
  array indexing; this flag is the cheapest defence available against both.

`vitest.config.ts` uses `test.projects: ['packages/*', 'apps/*']` (Vitest ≥3.2; the old
`vitest.workspace.ts` file is deprecated).

**ESLint carries two rules that are architecture, not style.** Both belong here because they are
free now and a refactor later.

```js
// eslint.config.js (excerpt)
const NO_ENV = {
  files: ['packages/{core,languages,db,storage,engine,eval}/src/**/*.ts'],
  ignores: ['**/__tests__/**'],
  rules: {
    'no-restricted-properties': ['error',
      { object: 'process', property: 'env',  message: 'The engine never reads process.env — take it from EngineContext.' },
      { object: 'process', property: 'cwd',  message: 'The engine never reads process.cwd() — take paths from EngineContext.' },
    ],
    'no-restricted-globals': ['error', { name: '__dirname', message: 'Engine code has no filesystem identity.' }],
  },
};

const LAYERS = { core: [], languages: ['core'], db: ['core','languages'],
                 storage: ['core'], engine: ['core','languages','db','storage'], eval: ['core','languages','engine'] };
// → one override per package emitting `no-restricted-imports` patterns for every
//   @thibi/* package NOT in its allow-list, plus `apps/*` banned from all of them.
```

Run with `--report-unused-disable-directives`, and add a CI grep
(`grep -rn 'process\.env' packages/*/src`) so an `eslint-disable` cannot quietly reintroduce it.

### 0.3 `packages/languages`

Three layers, per the overview: static JSON → generated frozen TS → DB overrides merged at
resolve time. The package itself never touches Postgres; overrides arrive as an argument. That is
what keeps the dependency direction one-way and the registry importable from a client component.

```ts
// src/types.ts
export type Direction = 'ltr' | 'rtl';
export type Tier = 'verified' | 'beta' | 'experimental' | 'unsupported';
export type ZeroWidth = 'strip' | 'keep';
export type NormalizerId = 'nfc' | 'collapse-ws' | 'zero-width' | 'digits' | 'zawgyi';

/** Script-level defaults. A language may override any of typography/zeroWidth/digits. */
export interface ScriptEntry {
  /** ISO 15924, e.g. 'Mymr'. */
  code: string;
  nameEn: string;
  direction: Direction;
  /** Needs shaping/reordering — drives the editor's rendering checks, not just fonts. */
  complex: boolean;
  /** Inclusive codepoint ranges. Used by the eval harness's script-integrity check, which is
   *  what catches the Groq romanization failure that CER only catches by accident. */
  unicodeRanges: Array<[number, number]>;
  /** Whether CER/LCS should operate on graphemes or codepoints for this script. */
  clusters: 'grapheme' | 'codepoint';
  typography: Typography;
  zeroWidth: { zwsp: ZeroWidth; zwnj: ZeroWidth; zwj: ZeroWidth };
  digits: { native: string | null; foldToLatin: boolean };
}

export interface Typography {
  /** Family name as declared in apps/web/app/fonts.ts. */
  fontFamily: string | null;
  /** next/font/google subset id, e.g. 'myanmar'. null ⇒ no Google Font, use a local fallback. */
  googleFontSubset: string | null;
  cssStack: string;
  /** Not cosmetic: Mymr/Khmr/Sinh stack diacritics vertically and clip at 1.5. */
  lineHeight: number;
  minFontPx: number;
}

export interface TextRules {
  /** 'none' ⇒ scriptio continua: CER strips whitespace, WER is meaningless, LCS uses graphemes. */
  wordSegmentation: 'spaces' | 'none' | 'icu';
  /** How words are rejoined into segment text after per-word transforms.
   *  ' ' even for Mymr — Google emits syllable-spaced Burmese and we preserve provider output. */
  wordJoin: ' ' | '';
  /** Ordered chain applied to provider output to produce segments.text. text_raw keeps the bytes. */
  normalizers: NormalizerId[];
  zawgyiApplies: boolean;
  zeroWidthPolicy?: Partial<ScriptEntry['zeroWidth']>;
  digits?: 'latin' | 'native' | 'preserve';
  punctuation: { sentenceEnders: string[]; quotes: [string, string] };
  /** The tiering metric strips whitespace for these — spacing is arbitrary on both sides. */
  cerStripsWhitespace: boolean;
  /** false ⇒ the harness reports WER as null rather than a number that cannot be compared. */
  reportWer: boolean;
}

export interface SubtitleRules {
  cpsMax: number;
  charsPerLineMax: number;
  maxLines: number;
  lineBreak: 'space' | 'grapheme' | 'icu';
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
  region: string | null;
  typography?: Partial<Typography>;
  text: TextRules;
  subtitle: SubtitleRules;
  /** FLEURS config id, e.g. 'my_mm'. null for the five non-FLEURS Google extras. */
  fleurs: { config: string | null };
  /** Advisory only — drives docs and default ordering, never behaviour. */
  waveHint: 'latin-exclusive' | 'asia-nonlatin' | 'rtl' | 'covered-by-openai' | 'skip' | null;
}
```

Provider matrix types — note `providerCode`, which is why adding a provider is one file plus a
column and not 107 edits:

```ts
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
  wordTimestamps: boolean | null;   // null = unknown until S2 / eval
  adaptation: 'none' | 'phrase-set' | 'prompt' | 'unknown';
  httpStatus?: number;
  errorMessage?: string;
  probedAt: string;                 // ISO date
}
```

`ResolvedLanguage` is the shape every engine stage and every React component receives:

```ts
export interface ResolvedLanguage extends Omit<LanguageEntry, 'typography'> {
  scriptEntry: ScriptEntry;
  direction: Direction;
  typography: Typography;                       // script defaults merged with language overrides
  tier: Tier;
  enabled: boolean;
  support: {
    cer: number | null; cerNoSpace: number | null;
    cerBaseline: number | null; cerRatio: number | null;
    evalDate: string | null; evalN: number | null;
    humanReviewed: boolean; notes: string | null;
  };
  providers: Partial<Record<ProviderId, ProviderLanguageCapability>>;
}

export interface LanguageRegistry {
  get(code: string): ResolvedLanguage | null;
  list(filter?: { tier?: Tier[]; provider?: ProviderId; enabledOnly?: boolean;
                  exclusiveTo?: ProviderId; script?: string }): ResolvedLanguage[];
  /** 'my' | 'mya' | 'MY-mm' | 'Burmese' | 'my-MM' → 'my-MM'. Unknown → null. Never throws. */
  normalizeCode(input: string): string | null;
  /** Re-merge DB overrides without rebuilding the static layer. */
  refresh(overrides: LanguageSupportOverride[]): void;
  readonly generatedAt: string;
}

export function createRegistry(overrides?: LanguageSupportOverride[]): LanguageRegistry;
export function resolveLanguage(code: string, overrides?: LanguageSupportOverride[]): ResolvedLanguage | null;
export function listLanguages(filter?): ResolvedLanguage[];   // static-only convenience
```

`createRegistry()` is what `EngineContext.languages` holds. The CLI builds it once from
`language_support`; the worker refreshes it on NOTIFY (Phase 9); tests build it from a fixture
array. **Shipping a new tier is a DB write, not a deploy** — this is the seam that makes that true.

`normalizeCode` must not be a regex. `pa-Guru-IN` and `cmn-Hans-CN` put a script subtag in the
middle and naive `lang-REGION` splitting produces `pa-IN`, which does not exist. Use an explicit
alias table generated from the data (iso639_1, iso639_3, lowercased nameEn, altNames, and the bare
primary subtag where it is unambiguous) plus `Intl.getCanonicalLocales` for casing.

**The build step.** `scripts/gen-languages.ts` validates `data/*.json` with zod, merges
`provider-matrix.json` with `matrix-overrides.json`, and emits:

```ts
// src/generated/registry.gen.ts — GENERATED, DO NOT EDIT. Run `pnpm --filter @thibi/languages gen`.
export const GENERATED_AT = '2026-08-12T…';
export const SCRIPTS = Object.freeze({ Mymr: Object.freeze({ … }), … });
export const LANGUAGES = Object.freeze({ 'my-MM': Object.freeze({ … }), … });
export const PROVIDER_MATRIX = Object.freeze({ … });
```

Why a compile step rather than importing the JSON: a client component importing JSON in Next
requires either an import attribute or a bundler-specific loader, and either way the whole file
lands in the client bundle unfrozen and un-tree-shakeable. A plain object literal in a TS module is
frozen at module scope, typed, and tree-shakes.

The generated file is **committed** (so `next dev` and `tsc` work with no prior build) and CI runs
`pnpm gen && git diff --exit-code` as the drift guard. `.gitattributes` marks it
`linguist-generated` so it collapses in diffs.

**Seeding procedure.** The 117-code Google list is not committed anywhere, so it is reconstructed
and then reconciled:

1. **Codes.** Fetch the FLEURS config list from the HF tree API
   (`https://huggingface.co/api/datasets/google/fleurs/tree/main/data`) — the directory names are
   the 102 configs. Map `xx_yy → xx-YY` with an explicit exception table for the ones the research
   already identified: `es_419→es-419`, `cmn_hans_cn→cmn-Hans-CN`, `yue_hant_hk→yue-Hant-HK`,
   `pa_in→pa-Guru-IN`, `ar_eg→ar-EG`, `hy_am→hy-AM`. Add the five non-FLEURS extras
   (`eu-ES, si-LK, sq-AL, su-ID, rup-BG`, `fleurs.config: null`) and the nine extra locales
   (`en-AU, en-GB, en-IN, es-ES, es-US, fr-CA, pt-PT, bn-BD, cmn-Hant-TW`). Total 116. **Then run
   the probe (§0.4) and reconcile** — any code Google accepts that is not in the file is a bug in
   this step, and the diff is the evidence.
2. **Scripts.** `scripts/infer-scripts.ts` pulls ~200 characters of each language's `dev.tsv`
   reference column and classifies by Unicode-block majority. This is precisely the check that
   catches `sd-IN` being Arabic despite the `-IN` tag. Output is written into `languages.json` and
   **reviewed by a human before commit** — the classifier is a labour saver, not an authority.
3. **Endonyms and ISO codes** from CLDR (`cldr-localenames-full`, a devDependency of the generator
   only). Where CLDR has nothing — Kabuverdianu, Umbundu, Kamba — write `endonym: null`.
4. **Typography**: a hand-written per-script table of ~20 rows. `lineHeight` 1.5 Latin/Cyrillic,
   1.9 Mymr/Khmr/Sinh (the existing app already sets 1.9 for Myanmar for exactly this reason), 1.7
   Deva/Beng/Guru/Ethi/Arab/Thaa. Noto family per script.
5. **Subtitle defaults**: `cpsMax` 17 Latin, 12 scriptio-continua; `charsPerLineMax` 42/24.
   Marked in the file as `"_provenance": "default, untuned"` — they are guesses to be tuned in
   Phase 7 and must not read as measurements.
6. **Tiers** — §0.5.

`data/languages.json` carries a `_meta` block: `{ seededFrom, seededAt, reconciledWithProbe }`.

### 0.4 `thibi probe languages`

Automates the research doc's manual method so that "which codes does this provider accept" is a
committed, dated, diffable file instead of a scratchpad memory.

```
thibi probe languages
  --provider google|openai|groq|all      (repeatable)
  --clip <path>          default packages/languages/fixtures/probe-2s.flac
  --codes <file>         default: every key in the registry
  --concurrency <n>      default 4 (google), 2 (openai/groq)
  --region <r>           google only, default asia-southeast1
  --model <m>            default per provider
  --out <path>           default packages/languages/data/provider-matrix.json
  --merge                keep rows for providers not probed in this run (default true)
  --dry-run              print the plan and the estimated cost, call nothing
```

**The clip.** One file, 2.0 s, 16 kHz mono FLAC, ~40 KB, a single Burmese phrase, committed at
`packages/languages/fixtures/probe-2s.flac`. Using the *same* clip for every code is deliberate:
this measures acceptance, never quality, and one clip makes runs comparable and the request cache
trivial. The sha256 of the clip is recorded in the output — if the clip changes, the matrix is
stale by definition.

**Concurrency.** 4 for Google (117 codes × ~1.2 s ≈ 40 s wall, far under the 300 rpm default
quota); 2 for Groq and OpenAI, which rate-limit aggressively. Full-jitter backoff on 429.

**Classification.** The single most likely way to corrupt this file is recording a rate-limit as a
rejection, so:

| Observation | `status` | `supported` | Note |
|---|---|---|---|
| HTTP 200 | `accepted` | `true` | `verdict: 'probe-only'` |
| 400 matching `/not supported\|unsupported language\|invalid.*language/i` | `rejected` | `false` | `verdict: 'measured-failure'` |
| 400 other | `error` | *unchanged* | flagged in the run summary for human review |
| 401 / 403 | — | — | **abort the entire run**; a misconfigured key must never write a file |
| 429 / 5xx after 3 retries | `unknown` | *unchanged* | previous value preserved |

**`supported: false` for a 200 can only come from `matrix-overrides.json` or the eval harness.**
The probe merges the override layer last and never writes it. This is what stops a re-run from
silently erasing the Groq finding.

```jsonc
// data/matrix-overrides.json (seed)
{
  "groq": {
    "my-MM": {
      "supported": false,
      "verdict": "measured-failure",
      "reason": "Accepts language=my and returns non-words; on autodetect returns romanized Latin.",
      "evidence": "လာက္းကေက် ရိုရ်းသဲ့ထါတ် … vs Google's correct output on the same 12 s clip. research/language-support-whisper-vs-google.md, 2026-07-30"
    },
    "km-KH": { "verdict": "suspected", "reason": "Same low-resource family as the measured my-MM failure; unverified. Warn in the picker; do not claim support." },
    "lo-LA": { "verdict": "suspected", "reason": "as km-KH" },
    "si-LK": { "verdict": "suspected", "reason": "as km-KH" },
    "ps-AF": { "verdict": "suspected", "reason": "as km-KH" },
    "am-ET": { "verdict": "suspected", "reason": "as km-KH" }
  }
}
```

Note the distinction: `measured-failure` sets `supported: false`; `suspected` leaves `supported`
true but makes the UI say "unverified on this provider". Marking the whole family unsupported on a
hunch would be the same error as marking it supported on a status code, in the other direction.

**Output format** — sorted keys, two-space indent, trailing newline, so a re-run's `git diff` is
exactly what changed:

```jsonc
{
  "_meta": { "schema": 1, "generatedBy": "thibi probe languages" },
  "providers": {
    "google": { "model": "chirp_2", "region": "asia-southeast1", "probedAt": "2026-08-12",
                "clipSha256": "…", "codesTried": 117, "accepted": 117, "rejected": 0, "unknown": 0 }
  },
  "languages": {
    "my-MM": {
      "google": { "status": "accepted", "supported": true, "verdict": "probe-only",
                  "providerCode": "my-MM", "wordTimestamps": true, "adaptation": "none",
                  "probedAt": "2026-08-12" },
      "groq":   { "status": "accepted", "supported": false, "verdict": "measured-failure",
                  "providerCode": "my", "reason": "…", "probedAt": "2026-08-12" }
    }
  }
}
```

**Commit protocol.** Run → inspect `git diff` → commit as
`probe(openai): 2026-08-12 — +3 codes (bn, fil, gu)`. CI does **not** re-run the probe (it would
call paid APIs from CI); the freshness discipline is a documented quarterly task plus the
`probedAt` dates being visible in `/settings/languages`.

**`thibi lang list`**, the phase's demonstrable surface:

```
thibi lang list --tier verified
thibi lang list --provider google --exclusive-to google
thibi lang list --script Arab
thibi lang show my-MM
```

`--exclusive-to google` recomputes the exclusive set from the committed matrix, asserted in a test,
which makes the matrix self-checking against numbers we already trust.

**Corrected 2026-08-09 by the live probe.** This plan said the flag would return 44. It conflates
two different figures and the flag means the stricter one:

| Query | Meaning | Research (2026-07-30) | Probe (2026-08-09) |
|---|---|---|---|
| `--provider google --not-supported-by openai` | Google handles it, no OpenAI model accepts it | 44 | **44** |
| `--exclusive-to google` | no other provider at all | 20 | **21** |

`--not-supported-by` was added for the first row; without it the headline figure was not
expressible on the CLI. The second row's extra language is `my-MM`: Groq *accepts* `my` and returns
non-words, so `matrix-overrides.json` marks it unsupported and Google becomes the only real option
for Burmese. The overrides mechanism proving itself on the one language this project was built for
is the best demonstration available that accepting a language code proves nothing.

### 0.5 Seed tiers

| Language | tier | Why |
|---|---|---|
| `my-MM` | `verified` | Known-good in production use since 2026. `cer: null`, `evalDate: null`, `humanReviewed: true`, `notes: "verified by operational use; CER to be measured in Phase 5"` |
| everything else Google accepts | `experimental` | Correct script assumed, quality unmeasured |
| anything the probe rejected | `unsupported` | Currently empty for Google — all 117 codes were accepted |

`enabled: true` for all; `/settings/languages` is where a newsroom narrows the picker, and a
disabled-by-default registry would make the picker look broken on first run.

Note what this seed says out loud: the one `verified` language is verified by *human judgement*,
not by the harness. That is consistent with the rule that the harness can award `beta` and
`experimental` on its own but **can never award `verified`**. Phase 5 will add the number; it will
not add the verdict.

## Porting notes

Nothing is ported as code in this phase — it is a fresh package tree. What is ported is *data and
findings*, and what matters most is what must not survive.

| From | To | Treatment |
|---|---|---|
| `research/language-support-whisper-vs-google.md` §"Languages Google handles…" (44 rows) | `data/provider-matrix.json` seed + the `exclusiveTo` test | Data, re-derived by the probe; the table is the check, not the source |
| Same doc, §"Groq accepts ≠ Groq works" | `data/matrix-overrides.json` `groq.my-MM` | Verbatim as `reason` + `evidence`, with the date |
| Same doc, §"Google's language list is FLEURS" | the seeding procedure in §0.3 | The 102 + 5 + 9 arithmetic is the bootstrap |
| `research/language-expansion-recommendations.md` waves 1–3 | `waveHint` | Advisory field only; it must not gate behaviour |
| Same doc, "Punjabi is half a language" / "Sindhi is Arabic script" | `pa-Guru-IN`, `sd-IN` entries + the script-inference review | Both are traps a naive tag parse falls into |
| Same doc, "Sinhala cannot be validated cheaply" | `si-LK` `fleurs.config: null` | First-class case, not an error |
| `lib/settings.ts:34-37` `SETTING_DEFAULTS` | `google_region` default `asia-southeast1` | Value survives; **the justification comment at `:29` does not** |
| `lib/providers/google.ts:11-14` region doctrine | — | **Delete on sight.** Measured false: `my-MM` returned identical correct output from all three regions |
| `lib/providers/google.ts:139-141` region error hint | — | **Delete on sight.** Phase 1 has a regression test asserting no error message mentions `asia-southeast1` |
| `app/settings/page.tsx:27` region hint | — | **Delete on sight** (Phase 14) |
| `lib/myanmar.ts:6-11` "myanmar-tools ships unbuilt" | comment on the `zawgyi` normalizer id | Real operational finding; it travels with the code in Phase 1 |
| `lib/db.ts:5` `DATA_DIR = process.cwd()/data` | — | Banned by the lint rule added in this phase |

## Tests

`packages/languages/src/__tests__/`

| File | Cases |
|---|---|
| `normalize-code.test.ts` | table: `my`→`my-MM`, `mya`→`my-MM`, `MY-mm`→`my-MM`, `my-MM`→`my-MM`, `Burmese`→`my-MM`, `burmese`→`my-MM`, `pa`→`pa-Guru-IN`, `pa-IN`→`pa-Guru-IN`, `zh`→`cmn-Hans-CN`, `xx`→`null`, `''`→`null`, `'../etc/passwd'`→`null` |
| `resolve.test.ts` | merge order script→language→override; `my-MM` gets `lineHeight 1.9`, `wordSegmentation 'none'`, `cerStripsWhitespace true`, `reportWer false`, `direction 'ltr'`; `ps-AF` gets `direction 'rtl'` and `clusters 'codepoint'`; `sd-IN` gets `script 'Arab'` (the trap); an override with `tier:'beta'` wins over the seeded `experimental`; an override for an unknown code is ignored, not thrown |
| `data-integrity.test.ts` | every `language.script` exists in `SCRIPTS`; every `fleurs.config` non-null except exactly `{eu-ES, si-LK, sq-AL, su-ID, rup-BG}`; every registry code has a `google` matrix row; no duplicate `(iso639_3, region)`; every RTL language's script has `direction:'rtl'`; every `normalizers[]` entry is a known id; every `unicodeRanges` pair is ascending |
| `matrix.test.ts` | `list({provider:'google', notSupportedBy:'openai'}).length === 44` including `ha-NG, ig-NG, ceb-PH, om-ET, ckb-IQ, my-MM, km-KH, ps-AF`; `list({exclusiveTo:'google'})` is the exact 21-code set; `get('my-MM').providers.groq` is `status:'accepted'` but `supported:false` with a non-empty `reason` and dated `evidence` — proving overrides are applied after the probe layer; the five `suspected` languages keep `supported:true`; no google row ever claims `adaptation` other than `'none'` |
| `frozen.test.ts` | `Object.isFrozen(LANGUAGES)`; `Object.isFrozen(LANGUAGES['my-MM'])`; assignment throws in strict mode |
| `registry-refresh.test.ts` | `refresh()` replaces tiers without re-reading static data; two registries with different overrides do not share state (guards against a module-global cache) |

`scripts/__tests__/gen-languages.test.ts` — regenerating from committed data is byte-identical to
the committed `registry.gen.ts`; a `languages.json` with an unknown script fails validation with a
message naming the offending code.

`apps/cli/src/commands/__tests__/probe-languages.test.ts` — classification against recorded
fixtures in `__fixtures__/probe/`: `google-200.json`, `google-400-unsupported.json`,
`google-400-other.json`, `groq-429.json`, `openai-401.json`.
Cases: 200→accepted/supported; 400-unsupported→rejected; 400-other→`error` and leaves the previous
row untouched; 429 after retries→`unknown` and **does not overwrite** a previous `accepted`;
401→throws before writing any file (assert the output file is unmodified); `--merge` preserves
other providers' rows; output is byte-stable across two runs with the same inputs.

Fixtures: `packages/languages/fixtures/probe-2s.flac`,
`__fixtures__/fleurs-tree.json` (a recorded HF tree response, so `infer-scripts` is testable
offline).

## Verification

```bash
$ pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test
#  all green; turbo reports 10 packages
```

```bash
$ pnpm thibi lang list --tier verified
CODE    NAME      ENDONYM   SCRIPT  DIR  TIER      PROVIDERS
my-MM   Burmese   မြန်မာ      Mymr    ltr  verified  google
1 language
```

```bash
$ pnpm thibi lang list --provider google --not-supported-by openai --json | jq length
44
$ pnpm thibi lang list --exclusive-to google --json | jq length
21
$ pnpm thibi lang show ps-AF
ps-AF  Pashto  پښتو
  script      Arab (rtl, complex)   clusters codepoint
  typography  Noto Naskh Arabic · line-height 1.7 · min 15px
  text        segmentation spaces · normalizers nfc,collapse-ws · WER reported
  subtitle    17 cps · 42 chars/line · 2 lines
  fleurs      ps_af
  tier        experimental (unmeasured)
  providers   google accepted (probe-only, 2026-08-12) · openai rejected · groq accepted (suspected)
```

```bash
# the frozen-registry guarantee, from a plain node REPL
$ node -e "import('@thibi/languages').then(m=>{ try { m.LANGUAGES['my-MM'].nameEn='x'; console.log('MUTABLE — FAIL') } catch { console.log('frozen') } })"
frozen
```

```bash
$ pnpm gen && git diff --exit-code packages/languages/src/generated
#  no output, exit 0  → the committed generated file matches its inputs

$ grep -rn "process\.env\|process\.cwd" packages/*/src | grep -v __tests__
#  no output

$ pnpm thibi probe languages --provider google --dry-run
would send fixtures/probe-2s.flac (sha256 3f9a…) to 117 codes on chirp_2 @ asia-southeast1
concurrency 4 · estimated wall clock 40s · estimated cost $0.06
```

Spikes are verified by their rows existing and being unambiguous:

```bash
$ grep -c '^| S[123] |' spikes/RESULTS.md
3
$ grep '^| S1' spikes/RESULTS.md
| S1 | 2026-08-12 | asia-southeast1 | chirp_2 | REJECTED (400, cell c passed) | adaptation unavailable on chirp_2; entity pass is primary | spikes/raw/s1-*.json |
```

Any row whose verdict is `inconclusive` blocks the phase.

## Risks and open questions

1. **The 117-code list is not committed anywhere.** The FLEURS-based bootstrap gets to 116 and the
   probe reconciles, but that ordering means the registry cannot be finalised until a working
   service account exists. If the SA is delayed, ship the registry with 116 codes and treat the
   reconciliation as a follow-up commit — do not block the monorepo bootstrap on it.
2. **Script inference is 95% right.** The long tail (Kabuverdianu, Aromanian, Umbundu) has small or
   odd reference text. Human review of the inferred table is mandatory, and the review is the
   deliverable, not the script.
3. **CLDR endonyms are incomplete** for exactly the languages that most need them. `null` is the
   honest answer; a picker row showing only the English name is better than a wrong endonym.
4. **Committed generated code invites merge conflicts.** Mitigated by `linguist-generated` and the
   drift test, but if it becomes painful the fallback is generating at build with a `prebuild` hook
   and accepting that `tsc` needs one build before it type-checks.
5. **S1's "accepted but inert" verdict is the hardest to reach honestly.** Budget an hour and five
   clips. If the A/B is inconclusive, record `unknown` — a guess here propagates into a product
   claim about Hausa.
6. **`processingStrategy: DYNAMIC_BATCHING` may not exist under that name** in the current API
   revision. If the field is rejected, that is a valid S3 outcome (row 3 of the table), not a
   scripting error — check the field name against the live discovery document before concluding.
7. **Open:** whether `pa-Guru-IN` should be keyed as-is or normalised to a BCP-47 canonical form.
   Decision taken: **key on exactly the string Google accepts**, because the registry key is also
   the wire value for the primary provider, and `providerCode` handles the divergence for everyone
   else. Revisit only if a second provider needs a script subtag.

## Definition of done

- [ ] `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm typecheck` is green from a clean clone.
- [ ] `spikes/RESULTS.md` has three rows, none `inconclusive`, each linking raw JSON.
- [ ] S1's verdict is reflected in a constant the Phase 1 `capabilities()` will read, with the date in a comment.
- [ ] S2's verdict is recorded **per language** for the ten-language sample.
- [ ] S3's verdict includes measured wall-clock for a 30 min and a 2 h file, or an explicit "Phase 2 is cut".
- [ ] `packages/languages/data/languages.json` has ≥116 entries; every one validates; every script resolves.
- [ ] `provider-matrix.json` is committed with a `probedAt` date and a clip sha256 for at least Google.
- [ ] `matrix-overrides.json` encodes the Groq Burmese failure as `supported: false` with its evidence, and the five suspected languages as `suspected` rather than unsupported.
- [ ] `my-MM` is the only `verified` language and its notes say why (operational use, not measured).
- [x] `thibi lang list --provider google --not-supported-by openai` returns **44**, reproducing the
      2026-07-30 research figure from a live probe; `--exclusive-to google` returns **21** and the
      test asserts the exact set.
- [ ] `LANGUAGES` is deeply frozen and mutation throws.
- [ ] `pnpm gen` produces no diff.
- [ ] `grep -rn 'process.env' packages/*/src` is empty and the lint rule that enforces it is in `eslint.config.js`.
- [ ] The dependency-direction lint rule rejects a deliberate `import '@thibi/db'` added to `packages/core`.
- [ ] No file in the repo contains the string `asia-southeast1` outside a default value or a spike script.

