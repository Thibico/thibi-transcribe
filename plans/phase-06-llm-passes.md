# Phase 6 — LLM editorial passes

## Goal

At the end of this phase `thibi pass cleanup <run>`, `thibi pass entities <run>`,
`thibi pass translate <run> --target en` and `thibi pass document <run> --kind summary|chapters|quotes`
all run against Postgres through one provider-agnostic gateway, write `segment_texts` and
`documents` rows with full provenance, never overwrite a human edit, and record their spend in
`usage_records`. The cleanup prompt is rewritten from scratch and is **measured** better than
doing nothing in every language tested — which is why this phase follows Phase 5 rather than
preceding it. This is the layer the overview calls the actual differentiator: the ASR is not the
product, the editorial passes are, and they generalise across languages far better than ASR does.

## Prerequisites

| Needs | From | Why |
|---|---|---|
| `EngineContext`, `segments`, `segment_texts`, `editorial_passes`, `documents`, `usage_records`, `rates`, `model_profiles` | Phase 1 | Every write target |
| `resolveLayer()` in `packages/core/src/layers/resolve.ts` | Phase 1 | Reading the source layer with human edits preferred |
| `glossaries` / `glossary_terms` | Phase 1 | Translate lexicon and the entities pass |
| `speakers`, `speaker_turns`, reconciled `segments.speaker_id` | Phase 3 | Speaker-attributed quotes |
| **Phase 5 harness, working and gating** | Phase 5 | No prompt ships without it |
| `scriptIntegrity`, `normalizeForScoring`, `levenshtein` from `packages/core/src/metrics` | Phase 5 | Reused at runtime — see §6.3 entities and §6.3 document |
| Spike S1 outcome | Phase 0 | If Chirp has no phrase-set support, the entities pass is the *primary* entity mechanism |

## Deliverables

| Path | Purpose |
|---|---|
| `packages/engine/src/llm/gateway.ts` | `LlmGateway` over Anthropic / OpenAI / OpenRouter via the Vercel AI SDK |
| `packages/engine/src/llm/models.ts` | `model_profiles` resolution; per-pass provider/model/temperature |
| `packages/engine/src/llm/errors.ts` | `LlmRefusal`, `LlmMalformed`, `LlmTruncated` — typed, not string throws |
| `packages/engine/src/llm/usage.ts` | Token → USD via `rates`; one `usage_records` row per call |
| `packages/engine/src/passes/pass-runner.ts` | The generalised batch runner. Descends from `lib/postprocess/run.ts` |
| `packages/engine/src/passes/batching.ts` | Token-aware batching, script-aware token estimation |
| `packages/engine/src/passes/write.ts` | Supersession, human-edit protection, `segment_revisions` |
| `packages/engine/src/passes/cleanup.ts` | The cleanup pass |
| `packages/engine/src/passes/translate.ts` | The translation pass |
| `packages/engine/src/passes/entities.ts` | Candidate generation + LLM adjudication + TS splicing |
| `packages/engine/src/passes/document.ts` | Summary / chapters / quotes, with map-reduce for long runs |
| `packages/engine/src/llm/prompts/vars.ts` | `PromptLanguageVars` built from `resolveLanguage()` |
| `packages/engine/src/llm/prompts/cleanup.ts` | `cleanup.restraint` v3 |
| `packages/engine/src/llm/prompts/translate.ts` | `translate.default` v2 |
| `packages/engine/src/llm/prompts/entities.ts` | `entities.adjudicate` v1 |
| `packages/engine/src/llm/prompts/document.ts` | `document.summary|chapters|quotes` v1 |
| `packages/engine/src/llm/prompts/__snapshots__/*.txt` | Rendered prompts per language; a diff forces a version bump |
| `packages/engine/src/llm/schemas.ts` | zod schemas incl. `documents.content` per kind |
| `apps/cli/src/commands/pass.ts` | `thibi pass <kind> <runId> [...]`, `--explain`, `--dry-run` |
| `packages/db/migrations/*` | `editorial_passes.meta jsonb`, `segments_failed`, `segments_unreturned` |

## Design

### 6.1 The gateway

```ts
// packages/engine/src/llm/gateway.ts
import { generateObject, NoObjectGeneratedError, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { z } from 'zod';

export interface ModelProfile {
  key: string;                 // 'cleanup.default'
  provider: 'anthropic' | 'openai' | 'openrouter';
  model: string;
  temperature: number;
  maxOutputTokens?: number;
}

export interface LlmRequest<T> {
  profile: ModelProfile;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export interface LlmResult<T> {
  object: T;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  finishReason: string;
  raw: unknown;
}

export interface LlmGateway {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export function createGateway(secrets: SecretReader): LlmGateway {
  const models = new Map<string, LanguageModel>();

  const resolve = (p: ModelProfile): LanguageModel => {
    const id = `${p.provider}:${p.model}`;
    let m = models.get(id);
    if (!m) {
      // Keys come from the settings table via EngineContext. Never process.env.
      switch (p.provider) {
        case 'anthropic':  m = createAnthropic({ apiKey: secrets.require('anthropic_api_key') })(p.model); break;
        case 'openai':     m = createOpenAI({ apiKey: secrets.require('openai_api_key') })(p.model); break;
        case 'openrouter': m = createOpenRouter({ apiKey: secrets.require('openrouter_api_key') })(p.model); break;
      }
      models.set(id, m);
    }
    return m;
  };

  return {
    async generate(req) {
      try {
        const r = await generateObject({
          model: resolve(req.profile),
          schema: req.schema,
          schemaName: req.schemaName,
          system: req.system,
          prompt: req.user,
          temperature: req.profile.temperature,
          maxOutputTokens: req.maxOutputTokens,
          // Our retry ladder lives in run_steps, so it is visible in the UI and fights nothing.
          // Same reasoning as `retryLimit: 0` on every pg-boss send.
          maxRetries: 0,
          abortSignal: req.abortSignal,
        });
        if (r.finishReason === 'length') throw new LlmTruncated(req.maxOutputTokens);
        if (r.finishReason === 'content-filter') throw new LlmRefusal('content-filter');
        return {
          object: r.object,
          usage: {
            inputTokens: r.usage.inputTokens ?? 0,
            outputTokens: r.usage.outputTokens ?? 0,
            cachedInputTokens: r.usage.cachedInputTokens,
          },
          finishReason: r.finishReason,
          raw: r.response?.body,
        };
      } catch (e) {
        if (NoObjectGeneratedError.isInstance(e)) throw new LlmMalformed(e.text ?? '', e.cause);
        throw e;
      }
    },
  };
}
```

**Why this replaces `lib/postprocess/run.ts:85`.** That call passes
`output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } }`, which is an
Anthropic-only field with no equivalent shape elsewhere. OpenAI wants
`response_format: { type: 'json_schema', json_schema: { …, strict: true } }`; OpenRouter passes
structured-output requests through to whichever provider is behind the model and **degrades
silently to prose** for models that do not support it. Three genuinely divergent mechanisms
behind one call site is exactly what `generateObject` is for. It also gives us
`usage.inputTokens/outputTokens` uniformly — which `usage_records` needs and which every SDK
reports differently — a typed `finishReason`, and `response.body` for the raw archive.

`model_profiles` supplies provider, model and temperature per pass key:

| Key | Default | Why |
|---|---|---|
| `cleanup.default` | a **small** model, temperature 0 | Restraint beats capability. `gpt-5.4-mini` beat `gpt-5.5` in almost every language: Xhosa 0.011 vs 0.089, Somali 0.013 vs 0.063, Pashto 0.012 vs 0.069. It edits less |
| `translate.default` | a **frontier** model | The ordering reverses: Somali 66.2 vs 58.6, Javanese 77.1 vs 70.3 chrF2 |
| `entities.default` | small, temperature 0 | It only returns booleans |
| `document.default` | frontier | Long context, synthesis |

The `/settings/models` page shows those two sentences as help text with a link to the eval
report. An operator who can see why a default is a default is one who can report when it stops
being right.

**Cost.** `rates` carries `(provider, model, unit, usd_per_unit)` with units `llm_input_tokens`,
`llm_output_tokens`, `llm_cache_read_tokens`. One `usage_records` row per call
(`run_id`, `step_id`, `kind: 'llm_tokens'`, `quantity`, `usd`), summed into
`editorial_passes.cost_usd`. `--dry-run` estimates from the same token estimator the batcher
uses and reuses `ConfirmRunDialog`'s arithmetic.

### 6.2 `pass-runner.ts`

```ts
export interface PassSpec<TItem, TOut> {
  kind: 'cleanup' | 'translate' | 'entities' | 'document';
  layer: SegmentLayer;              // what it WRITES
  sourceLayer: SegmentLayer;        // what it READS
  targetLang: string;               // '' except translate
  promptId: string;
  promptVersion: number;
  profileKey: string;               // 'cleanup.default'
  buildSystem(vars: PromptLanguageVars, extras: unknown): string;
  schema: z.ZodType<TOut>;
  batchTokenBudget: number;
  outputTokenFactor: number;        // 2.2 cleanup, 2.5 translate
  toItem(seg: SegmentRow, text: string): TItem;
  extractTexts(out: TOut): Array<{ idx: number; text: string; meta?: unknown }>;
}
```

Default layer wiring — a table, because the order is the design:

| Pass | reads | writes |
|---|---|---|
| cleanup | `verbatim` | `cleaned` |
| entities | `cleaned` if present, else `verbatim` | `entity_corrected` |
| translate | `entity_corrected` → `cleaned` → `verbatim`, first present | `translated` + `target_lang` |
| document | same fallback chain as translate | `documents` rows |

Entities before translate is deliberate: a corrected name is what gets translated, so
`Daw Aung San Suu Kyi` survives into English instead of a mangled transliteration of a mangled
source.

**The idx-keyed matching — kept verbatim in spirit.**

```ts
// Descended from lib/postprocess/run.ts:110-120. The comment travels because the property is
// the single most important safety guarantee in the original file.
//
// Match on idx, not position — a batch that came back short or reordered then updates only
// what it actually covered instead of shifting text onto the wrong timestamps. The timestamps
// in `segments` are the spine the audio player, the reconciler and every export format hang
// off; a pass that silently shifted text by one would desync a 90-minute transcript in a way
// that looks fine until somebody plays it.
const expected = new Map(batch.map((s) => [s.idx, s]));
const seen = new Set<number>();
const applied: AppliedResult[] = [];

for (const r of spec.extractTexts(result)) {
  if (!expected.has(r.idx)) continue;          // an idx we did not send
  if (seen.has(r.idx)) continue;               // a duplicate idx in one response
  if (typeof r.text !== 'string') continue;    // a null, a number, an object
  seen.add(r.idx);
  applied.push({ idx: r.idx, text: r.text.trim(), meta: r.meta });
}

// New: coverage is recorded, not swallowed. The original silently did 60% of a batch and
// reported success; a pass that covered 1,400 of 2,300 segments must SAY so.
const unreturned = batch.length - seen.size;
```

`editorial_passes` gains `segments_unreturned` and `segments_failed` alongside the existing
`segments_done` and `segments_skipped_human`. A pass whose coverage is below 100% completes in
state `partial`, never `done` — the same partial-is-survivable doctrine the chunk pipeline uses.

**Token-aware batching instead of a fixed 20.**

```ts
// packages/engine/src/passes/batching.ts
/**
 * A fixed BATCH_SIZE of 20 is either wasteful or fatal depending on the script. 20 Hausa
 * segments are ~600 tokens and waste a round trip; 20 Burmese segments can be ~4,000, and
 * because Myanmar tokenizes at roughly one token per codepoint the OUTPUT blows through
 * max_tokens — which truncates the JSON and loses the tail of the batch. Truncation is the
 * expensive failure here, so we budget both directions.
 */
const CHARS_PER_TOKEN: Record<string, number> = {
  Latn: 3.7, Cyrl: 2.6, Arab: 1.8, Ethi: 1.2, Deva: 1.4, Guru: 1.4,
  Mymr: 1.0, Khmr: 1.0, Laoo: 1.0, Thai: 1.1, Sinh: 1.2, Orya: 1.3,
};
const HARD_MAX_SEGMENTS = 40;
const JSON_OVERHEAD_TOKENS_PER_SEGMENT = 12;   // {"idx":123,"text":""},

export function estimateTokens(text: string, script: string): number {
  const cpt = CHARS_PER_TOKEN[script] ?? 3.0;
  return Math.ceil(Array.from(text).length / cpt) + JSON_OVERHEAD_TOKENS_PER_SEGMENT;
}

export function batch<T extends { idx: number; text: string }>(
  items: readonly T[], script: string, budget: number,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], tokens = 0;
  for (const it of items) {
    const t = estimateTokens(it.text, script);
    if (cur.length > 0 && (tokens + t > budget || cur.length >= HARD_MAX_SEGMENTS)) {
      out.push(cur); cur = []; tokens = 0;
    }
    cur.push(it); tokens += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Output budget: cleanup ≈ input + punctuation; translation expands. Floor so tiny batches work. */
export const outputBudget = (inputTokens: number, factor: number) =>
  Math.max(1024, Math.ceil(inputTokens * factor));
```

The per-script constants are a first guess. Every LLM call already writes real `inputTokens` to
`usage_records`, so `thibi admin calibrate-tokens` recomputes them from actual usage and writes
them back into the registry. Guessing once and measuring later beats guessing forever.

**Human-edit protection.** The old code reads human text (`run.ts:75`,
`s.edited_text ?? s.text`) but has no concept of refusing to overwrite it, because with columns
there is nothing to overwrite. With layers there is.

```
Rule: an LLM pass NEVER supersedes a row whose origin = 'human', unless overwriteHumanEdits
      is explicitly set. Skipped rows are counted in editorial_passes.segments_skipped_human
      and reported in the CLI summary and the run timeline.
```

One transaction per batch:

```sql
BEGIN;
-- Lock the segments we are about to write so a concurrent human edit cannot land between
-- the origin check and the insert.
SELECT id FROM segments WHERE run_id = $1 AND idx = ANY($2) FOR UPDATE;

-- Supersede only non-human live rows for this (segment, layer, target_lang).
UPDATE segment_texts
   SET superseded_at = now(), superseded_by = $passId
 WHERE segment_id = ANY($3) AND layer = $4 AND target_lang = $5
   AND superseded_at IS NULL
   AND (origin <> 'human' OR $overwriteHumanEdits);

INSERT INTO segment_texts (segment_id, run_id, layer, target_lang, origin, text, pass_id, meta)
SELECT ... ;   -- only for segments whose live row was not a protected human row
COMMIT;
```

The partial unique index `UNIQUE (segment_id, layer, target_lang) WHERE superseded_at IS NULL`
makes a bug here a constraint violation rather than a duplicate layer. Supersession is history,
not destructive overwrite, so reverting a pass stays one `UPDATE`.

**Refusals and malformed JSON.** The original throws a string for both (`run.ts:94-108`) and
kills the whole pass. Neither is right.

| Condition | Handling |
|---|---|
| `LlmMalformed` | One repair attempt: resend with the raw text and "return only JSON matching this schema, no prose". Then fail the **batch**, not the pass. The step retries per the `editorial.pass` ladder (4 × 5 s jitter); past `max_attempts` those idxs count in `segments_failed` and the pass completes `partial` |
| `LlmTruncated` | Halve the batch and retry immediately — the batcher under-estimated. Log the miss so `calibrate-tokens` sees it |
| `LlmRefusal` | **Never retry unchanged** — it will refuse again. Halve the batch **once**: a refusal is nearly always triggered by one segment's content, and halving isolates it. On a batch of 1 that still refuses, write the source text through unchanged with `origin: 'rule'` and `meta: { refused: true, reason }` so the layer stays dense, the editor shows why, and the transcript is still exportable. Record the first 500 characters of the refusal in `editorial_passes.meta.refusals[]` |

The passthrough row is the important one. A newsroom transcribing atrocity testimony will hit
refusals, and the failure mode must not be "the cleaned layer has a hole in it and the export
skips a segment".

**Resumability.** Batches are `run_steps` shards: `UNIQUE (run_id, kind, shard)` with
`shard = batchOrdinal`, so re-running a pass after a crash skips completed batches and does not
re-bill. `editorial_passes.segments_done` is monotonic. Cancellation checks the `AbortSignal`
between batches, matching the chunk pipeline.

### 6.3 The four passes

#### cleanup — `prompt_id: cleanup.restraint`, `prompt_version: 3`

The old prompt is **not ported**. It is the measured cause of the damage.

The evidence, stated in the file so nobody re-adds the clause in six months: scored as CER
against a punctuated reference with *doing nothing* as the control, the current prompt is worse
than doing nothing in **every** language tested — Burmese 0.016 → 0.033, Yoruba 0.059 → **0.148**,
Pashto 0.011 → 0.048, Somali 0.031 → 0.070, Hausa 0.029 → 0.042, Xhosa 0.035 → 0.041. A
restraint-constrained prompt moves them dramatically toward the control: Yoruba 0.148 → 0.035,
Somali 0.070 → 0.009, Pashto 0.048 → 0.008, Hausa 0.042 → 0.013, Xhosa 0.041 → 0.008,
Burmese 0.033 → 0.019.

**One caveat the research doc's prose glosses over, and this plan does not.** Its text says
restraint "moves every language tested below the do-nothing control", but its own table has
Burmese restraint at **0.019 against a 0.016 control** — still above it, by a small margin, in
the one language currently in production. Five of six languages clear the control by a wide
margin; Burmese does not. The gate in §6.5 believes the table, so Burmese is expected to fail
on the first run of this phase and closing that gap is Phase 6 work. Do not relax the gate to
accommodate it.

The failure is not sloppy punctuation, it is silent rewriting:

- Yoruba — `UN tún ní ìrètí…` → `Wọ́n tún ní ìrètí…`. The named entity "UN" replaced by "they".
- Pashto — `د اغیزو` ("the effects") expanded to `د نړیوالې تودوخې` ("global warming"), and
  Arabic yeh normalised to Farsi yeh throughout.
- Somali — `ay … caalamka saameeyay` → `uu … caalamku saameeyay`: grammatical agreement
  "corrected", changing the sentence.
- Burmese — `သက်ရောက်ခြင်းရှိသော` → `သက်ရောက်မှုရှိသော`, and the rendering of "UN" altered.

**The pass meant to make a transcript quotable is altering quotations**, in Burmese, in
production, today.

Two lines of `lib/postprocess/cleanup.ts` cause it and neither may reappear:

- `:17` — *"Fix obvious spelling and Unicode normalization errors introduced by the recogniser."*
  In a language the model knows well that is safe; in a low-resource language it licenses the
  model to "correct" text that was already right. This is the measured cause.
- `:19-21` — *"Leave proper nouns, numbers, dates, and place names exactly as transcribed
  **unless the correct form is unambiguous**."* The escape hatch. `UN → Wọ́n` is precisely a
  model deciding it knew the unambiguous correct form. Delete the exception, keep no version of it.

The replacement, rendered from `PromptLanguageVars` (§6.4) so it never names a language:

```
You restore punctuation, casing and spacing in {{endonym}} ({{nameEn}}) speech-to-text
transcript segments. You are a typesetter, not an editor.

Input is JSON: {"segments":[{"idx":<integer>,"text":"<text>"}]}
Return JSON of the same shape: exactly one object per input segment, echoing "idx" unchanged.

You may change ONLY these things:
- Sentence-ending punctuation: {{sentenceEnd}}
- Clause-internal punctuation: {{clausePunct}}
- Quotation marks: {{quoteOpen}} {{quoteClose}}
- {{casingRule}}
- {{spacingRule}}

You may NOT change anything else. Specifically, do not:
- correct or alter spelling, even where a word looks misspelled or misheard;
- correct or alter grammar, agreement, tense, case, number, or word order;
- substitute any different word, synonym, or pronoun for a word that is present;
- expand, contract, complete or clarify an abbreviation, an acronym, a name or a number;
- add any word that is not in the input, or remove any word that is;
- transliterate, translate, or re-encode any character;
- normalise Unicode, swap visually similar characters, or "fix" diacritics or vowel signs;
- change the digit system in use ({{digitsExample}});
- reorder characters or insert directional marks;
- complete a segment that begins or ends mid-thought. These are segments of continuous
  speech and are supposed to be incomplete.

Apply this test to your own output before returning it: if every character you added is
removed and every space you changed is restored, the result must be character-for-character
identical to the input. If it would not be, you have changed too much — return the input.

If a segment is empty, unintelligible, or you are unsure, return it exactly as given.
Never merge, split, reorder or drop segments; each is pinned to an audio timestamp.
Return the JSON only — no commentary, no explanation, no notes.
```

The self-check paragraph is not decoration. It is the `content_delta` contract from Phase 5
§5.10 written into the prompt: the harness measures exactly that property, and the CI gate fails
at `content_delta > 0.005`. Prompt and metric assert the same thing, which is why the prompt can
be short and absolute rather than long and hedged.

Temperature 0, small model by default.

**Designed but gated:** passing the previous segment's text as read-only context (`prev`) so a
sentence-end decision at a segment boundary is informed. It is a real quality lever for
scriptio-continua languages and it is *also* an obvious route to the model editing the context
by mistake. It exists behind `--context-window 1`, defaults **off**, and only becomes default if
`thibi eval cleanup` shows it beats the current prompt in every language. That is the rule from
§6.5 applied to our own good idea.

#### translate — `prompt_id: translate.default`, `prompt_version: 2`

Target is a parameter, never a literal. `layer = 'translated'`, `target_lang = <bcp47>`, so N
targets are N rows and never new columns.

```
You translate {{sourceEndonym}} ({{sourceNameEn}}) transcript segments into
{{targetEndonym}} ({{targetNameEn}}).

Input is JSON: {"segments":[{"idx":<integer>,"text":"<text>"}]}
Return JSON of the same shape, where "text" is the translation of that segment.

{{glossaryBlock}}

Guidance:
- Translate for meaning, in natural {{targetNameEn}} — not word for word.
- These are segments of continuous speech. A segment may begin or end mid-sentence.
  Translate what is there; do not invent words to make it a complete sentence.
- Render personal and place names using their conventional {{targetNameEn}} spelling where
  one exists, and otherwise transliterate consistently across the whole batch.
- Keep register: if the speaker is informal, hesitant or blunt, the translation is too.
  This is a transcript of a person speaking, not a document.
- If a segment is unintelligible or empty, return an empty string rather than guessing.

Hard constraints:
- Exactly one object per input segment, echoing its "idx" unchanged.
- Never merge, split, reorder or drop segments. Each is pinned to an audio timestamp, so
  the mapping must stay one to one.
- Output the translation only — no notes, no transliteration alongside, no commentary.
```

The segment-boundary constraints and the "may begin or end mid-sentence" guidance come across
from `lib/postprocess/translate.ts:16-17` and `:23-26` nearly verbatim; they are correct and
hard-won. The Burmese/English literals and the fixed direction do not.

**Glossary injection.** `{{glossaryBlock}}` is built per batch, not per pass:

```ts
/**
 * A newsroom glossary can hold thousands of terms. Injecting all of them into every batch
 * costs more than the translation and buries the ten that matter. Select only terms that
 * actually occur in this batch's source text.
 */
export function selectTerms(batchText: string, terms: GlossaryTerm[], seg: 'space'|'none'|'icu', cap = 200) {
  const hay = seg === 'none' ? batchText : ` ${batchText} `;
  const hit = (s: string) =>
    seg === 'none'
      ? Array.from(s).length >= 2 && hay.includes(s)          // unspaced: substring, min 2 graphemes
      : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'iu').test(hay);
  return terms
    .filter((t) => hit(t.term) || t.variants.some(hit))
    .sort((a, b) => b.boost - a.boost)
    .slice(0, cap);
}
```

Rendered as two explicit lists, because "prefer this terminology" is advisory and these are not:

```
Fixed terminology. Use these renderings exactly, every time they occur:
  ဒေါ်အောင်ဆန်းစုကြည် → Daw Aung San Suu Kyi
  နိုင်ငံတော်စီမံအုပ်ချုပ်ရေးကောင်စီ → State Administration Council

Do not translate these. Reproduce them exactly as written in the source:
  Tatmadaw, 969
```

`do_not_translate` terms come from `glossary_terms.do_not_translate`; `translations` supplies the
target rendering, keyed by `target_lang`, falling back to no entry rather than to another
language's rendering.

**The 4-target cap.** A 3-hour interview is roughly 2,500 segments. Each additional target is a
2,500-row `segment_texts` insert, a full pass, and a proportional bill; four targets is a 10,000-row
insert and 4× the spend, on a job somebody kicked off from a dropdown. Each target is its own
`editorial_passes` row and its own set of `run_steps` shards, so four targets are four
independently resumable and independently revertible passes rather than one giant one.
`--force` lifts the cap after printing the estimate; the UI never offers it without the number.

Frontier model by default.

#### entities — `prompt_id: entities.adjudicate`, `prompt_version: 1`

**Given spike S1, this is the primary entity mechanism, not a supplement.** Chirp historically
does not support phrase sets in STT v2, and phrase-set biasing is a `long`/`short` model feature
covering a fraction of the 107 codes — that is, unavailable for exactly the exclusive-language
set that is the product thesis. Pre-recognition biasing is the opportunistic bonus; this pass is
the mechanism that has to work.

It is designed so that the model **cannot** rewrite text. Three stages:

**Stage 1 — deterministic candidate generation, in TypeScript.**

```ts
export interface Candidate {
  id: string;              // `${segIdx}:${offset}:${termId}`
  segIdx: number;
  offset: number;          // codepoint offset into the segment
  surface: string;         // exactly what is in the text now
  proposed: string;        // glossary_terms.term
  termId: string;
  matchKind: 'variant-exact' | 'fuzzy';
  distance: number;        // 0 for exact
}
```

Exact matches against `glossary_terms.variants` with the same boundary rules as `selectTerms`,
plus fuzzy matching over a sliding grapheme window: normalized edit distance ≤ 0.2 against each
variant, computed with `levenshtein` from `packages/core/src/metrics` — the same
parity-tested implementation the harness uses, not a second one. Unspaced scripts require a
minimum of 3 graphemes and a per-term `min_length` override, because a 2-grapheme Burmese term
matches almost everywhere.

**Stage 2 — the LLM adjudicates. It returns booleans.**

```ts
export const EntityDecisions = z.object({
  decisions: z.array(z.object({
    id: z.string(),
    accept: z.boolean(),
    confidence: z.number().min(0).max(1),
  })),
});
```

```
You are checking proposed name corrections in a {{endonym}} transcript.

You receive JSON: {"segments":[{"idx":…,"text":…}], "candidates":[{"id":…,"segIdx":…,
"surface":"<what the transcript says>","proposed":"<the glossary's preferred form>"}]}

For each candidate decide whether, in the context of that segment, the transcript's
"surface" text is a misrecognition of "proposed" — the same name, wrongly transcribed.

Return {"decisions":[{"id":…,"accept":true|false,"confidence":0..1}]}.

Accept only when the surrounding words support it. Reject when "surface" is a different
name, an ordinary word that merely resembles the term, or when the segment gives you no
way to tell. A rejected correction costs nothing; a wrong one puts a name in a
journalist's quotation that the speaker did not say.

Return the JSON only. Do not return any transcript text.
```

The prompt is short because the model's entire authority is one boolean per candidate.

**Stage 3 — TypeScript performs the substitution by splicing at recorded offsets**, highest
offset first so earlier offsets stay valid. The model never sees a text field it could return.

```ts
const out = spliceAll(sourceText, accepted);
// A pass that can only splice at known offsets must produce a string that differs from the
// source only at those offsets. Assert it rather than trust it — this is the property that
// makes the whole design auditable.
assertOnlyChangedAt(sourceText, out, accepted);
```

Every substitution is recorded in `segment_texts.meta`:

```json
{ "substitutions": [
  { "from": "အောင်ဆန်စုကြည်", "to": "ဒေါ်အောင်ဆန်းစုကြည်",
    "glossaryTermId": "…", "offset": 42, "matchKind": "fuzzy",
    "distance": 0.08, "confidence": 0.94, "promptVersion": 1 }
] }
```

`thibi pass entities <run> --explain` prints every substitution with before/after context in a
table, and `--dry-run` runs stages 1 and 2 and prints them without writing. A reviewer can audit
an entire entity pass on one screen, which is the difference between "the LLM fixed some names"
and a correction a newsroom can stand behind.

Constrained substitution against the glossary only. Never freeform. There is no code path by
which this pass emits a token that is not already in `glossary_terms`.

#### document — `prompt_id: document.{summary|chapters|quotes}`, `prompt_version: 1`

```ts
// packages/engine/src/llm/schemas.ts — documents.content per kind
export const SummaryContent = z.object({
  headline: z.string().min(1).max(200),
  abstract: z.string().min(1),              // 2-4 sentences
  bullets: z.array(z.string()).min(3).max(8),
  topics: z.array(z.string()).max(10),
  people: z.array(z.object({
    name: z.string(),
    role: z.string().nullable(),
    segmentIds: z.array(z.string()).min(1),
  })).max(20),
});

export const ChaptersContent = z.object({
  chapters: z.array(z.object({
    title: z.string().min(1).max(120),
    summary: z.string(),
    segmentIds: z.array(z.string()).min(1),
    startMs: z.number().int().nonnegative(),   // MODEL-PROPOSED, RECOMPUTED BELOW
    endMs: z.number().int().positive(),        // MODEL-PROPOSED, RECOMPUTED BELOW
  })).min(1).max(40),
});

export const QuotesContent = z.object({
  quotes: z.array(z.object({
    speakerKey: z.string().nullable(),         // 'speaker-01', or null when unattributed
    text: z.string().min(1),
    segmentIds: z.array(z.string()).min(1),
    startMs: z.number().int().nonnegative(),   // RECOMPUTED
    endMs: z.number().int().positive(),        // RECOMPUTED
    verbatim: z.boolean(),                     // COMPUTED, NOT TRUSTED — see below
    context: z.string().optional(),
  })).max(20),
});
```

The schema is the easy part. The validation is the design:

1. **Every `segmentId` must exist in this run.** Unknown ids are dropped and counted; an item
   left with none is dropped entirely.
2. **`startMs`/`endMs` are always recomputed** as `min(start)`/`max(end)` over the referenced
   segments. A model-proposed timecode is a suggestion about which segments it meant, never a
   time. This is why `segmentIds` is the required field and the timecodes are not.
3. **`verbatim` is computed, not asked.** Normalize the quote text and the concatenation of the
   referenced segments' text with `normalizeForScoring({ keepPunctuation: false, caseFold: true })`
   and compare with `cer`. `verbatim = cer < 0.02`. If the model paraphrased, the flag says so
   and the editor shows a warning next to the quote. A newsroom checks every quote against the
   recording; this makes that check machine-assisted instead of manual, and it means a
   paraphrase can never be exported looking like a quotation.
4. **Chapters must tile.** Sort by `startMs`; overlaps are clamped to the earlier chapter's last
   segment boundary; gaps over 5 s are reported in `meta.gaps` rather than silently closed.
5. `speakerKey` must resolve against the run's `speakers` rows; anything else becomes `null`.

`documents.content_md` is rendered from the validated object by a TS renderer, so the markdown
and the JSON can never disagree.

**Long transcripts.** The document pass sees the whole transcript, not batches. When the
transcript exceeds the model's context minus the output budget, run map-reduce: chapter-window
summaries first, then a summary over those, recording `meta.strategy = 'map-reduce'` and
`meta.windows = n` so a thin summary of a 3-hour file is explicable. Quotes are extracted
per-window and merged, capped at 20 by the model's own confidence ordering within each window.

### 6.4 Language parameterisation

No prompt names a language. The only literals in a prompt are the JSON envelope and the
constraints; everything language-specific is a slot filled from the registry.

```ts
// packages/engine/src/llm/prompts/vars.ts
export interface PromptLanguageVars {
  code: string;                    // 'my-MM'
  nameEn: string;                  // 'Burmese'
  endonym: string;                 // 'မြန်မာ'
  scriptCode: string;              // 'Mymr'
  direction: 'ltr' | 'rtl';
  sentenceEnd: readonly string[];  // ['။']            en: ['.','!','?']   am: ['።']
  clausePunct: readonly string[];  // ['၊']            en: [',',';',':']   am: ['፣','፤']
  quote: readonly [string, string];
  hasCase: boolean;
  spacing: 'inter-word' | 'phrase-level' | 'none';
  digitsExample: string;           // '၀၁၂၃ or 0123'
}

export function promptVars(code: string, langs: LanguageRegistry): PromptLanguageVars;
```

| Registry field | Prompt slot | Rendered as |
|---|---|---|
| `endonym`, `nameEn` | `{{endonym}}`, `{{nameEn}}` | Literal |
| `text.punctuation.sentenceEnd` | `{{sentenceEnd}}` | The actual marks, listed |
| `text.punctuation.clause` | `{{clausePunct}}` | The actual marks, listed |
| `text.punctuation.quote` | `{{quoteOpen}}/{{quoteClose}}` | The pair |
| `script.hasCase` | `{{casingRule}}` | See below |
| `text.wordSegmentation` | `{{spacingRule}}` | See below |
| `text.digits` | `{{digitsExample}}` | `'၀၁၂၃ or 0123'` |
| `script.direction` | (cleanup constraint list) | The "do not reorder characters or insert directional marks" line is emitted only for `rtl` |

```ts
const casingRule = (v: PromptLanguageVars) => v.hasCase
  ? 'Capitalisation: sentence-initial capitals, and proper nouns that are ALREADY capitalised '
    + 'in the input. Do not change the case of any other word, and never capitalise a word to '
    + 'make it look like a name.'
  : 'This script has no letter case. Do not change the case or form of any character.';

const spacingRule = (v: PromptLanguageVars) => ({
  'inter-word':   'Whitespace: collapse repeated spaces and remove leading and trailing space. '
                + 'Do not otherwise change spacing.',
  'phrase-level': 'Whitespace: this language does not space between every word. You may insert '
                + 'or remove a space at a PHRASE boundary only. Never insert a space inside a '
                + 'word or inside a syllable cluster, and never remove a space that separates '
                + 'two phrases.',
  'none':         'Whitespace: do not change spacing at all.',
}[v.spacing]);
```

`phrase-level` covers Mymr, Khmr, Laoo and Thai — the same set the Phase 5 normalizer strips
whitespace from before scoring, which is not a coincidence: spacing is arbitrary on both sides,
so the metric ignores it and the prompt is permitted to touch it.

**Prompt snapshots.** `packages/engine/src/llm/prompts/__snapshots__/<promptId>.<code>.txt` for
`my-MM`, `ha-NG`, `am-ET`, `ps-AF`, `km-KH`, `ceb-PH` — one non-cased scriptio-continua, one
Latin, one Ethiopic, one RTL, one more scriptio-continua, one Latin with heavy code-switching. A
prompt edit surfaces as a reviewable diff across six languages instead of one, which is how you
notice that a clause reads fine in English and is nonsense once `{{sentenceEnd}}` is `።`.

A test asserts: **if any rendered snapshot changed, `promptVersion` must have changed.** That is
what keeps `editorial_passes.prompt_version` honest, and it is what makes the Phase 5 cache key
(which includes `promptVersion`) a real cache key rather than a decoration.

### 6.5 The relationship to Phase 5

No prompt change ships without the harness showing it beats the do-nothing control. Written as a
procedure with the enforcement point named at each step, because an aspiration is not enough:
this exact regression already reached a shipped prompt once, and only measurement caught it.

| # | Step | Enforced by |
|---|---|---|
| 1 | Edit `packages/engine/src/llm/prompts/cleanup.ts`; bump `version` | — |
| 2 | `pnpm -F @thibi/engine test` fails on six snapshots. Update them; the rendered diff is now in the PR | Snapshot test |
| 3 | A changed snapshot with an unchanged `promptVersion` fails | Version-bump guard test |
| 4 | `thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,candidate --gate` locally | Exit 2 on regression |
| 5 | Paste `results/reports/llm-<date>.md` into the PR | Review convention |
| 6 | CI runs the same command with `--gate` | `.github/workflows/eval.yml` |
| 7 | Changing a `model_profiles` default needs the same evidence | Review convention + the seeded help text linking the report |

Three properties make this real rather than ceremonial:

- **`packages/eval` imports `buildCleanupPrompt` from `packages/engine`.** It never holds a
  prompt string. A copy would drift within a month and the gate would be measuring the wrong
  text. This is why the dependency direction is `engine ← eval`.
- **The response cache key includes `promptId` and `promptVersion`.** A bumped prompt is a
  genuine cache miss. Without this line the gate passes on the previous prompt's cached numbers.
- **The gate's pass condition is beating the do-nothing control, per language, not a fixed
  threshold.** Thresholds get tuned until they pass. A control cannot be.

The same discipline applies inward: the runtime reuses the harness's own functions rather than
approximations of them. `scriptIntegrity` guards every pass output — models sometimes return the
*translated* text from a cleanup pass on a low-resource language. If
`scriptIntegrity(output) < 0.8` while `scriptIntegrity(input) ≥ 0.8`, the item is rejected, the
source is kept, and `meta.rejected = 'script-integrity'` is recorded. One function, two callers,
no drift.

## Porting notes

| From | To | Verbatim? |
|---|---|---|
| `lib/postprocess/run.ts:110-120` idx-keyed matching | `pass-runner.ts` apply loop | **Verbatim in spirit**, comment travels. Added: duplicate-idx rejection and `segments_unreturned` |
| `run.ts:5-13` file header comment on why idx keying exists | `pass-runner.ts` header | Verbatim. It records a real operational finding |
| `run.ts:75` "manual edits are the human's intent" | `resolveLayer(..., preferHuman)` | **Changed and extended.** The old code reads human text; the new rule also refuses to overwrite it |
| `run.ts:51-55` `chunk()` | `batching.ts` | **Replaced.** Fixed 20 → token-aware |
| `run.ts:19-37` `RESULT_SCHEMA` | `schemas.ts` zod | Changed. Same shape, zod so `generateObject` can use it |
| `run.ts:15` `const MODEL` | `model_profiles` | Replaced |
| `run.ts:85` `output_config` | `generateObject` | Replaced — §6.1 |
| `run.ts:94-108` refusal / malformed handling | `errors.ts` + the halving ladder | **Replaced.** String throws that kill the pass → typed errors that degrade a batch |
| `run.ts:61-65` `runPass(runId, column, systemPrompt)` writing to a column | `segment_texts` rows | Replaced. The whole point of the layer table |
| `translate.ts:16-17, 23-26` segment-boundary and mid-sentence guidance | `prompts/translate.ts` | Verbatim in substance, target parameterised |
| `cleanup.ts:22-28` hard constraints (one object per segment, never merge/split/reorder, never translate) | `prompts/cleanup.ts` | Verbatim in substance |

Must **not** survive:

- `cleanup.ts:17` — *"Fix obvious spelling and Unicode normalization errors."* The measured cause.
- `cleanup.ts:19-21` — the *"unless the correct form is unambiguous"* escape hatch.
- `"Burmese (Myanmar)"` or any language name as a literal in any prompt.
- `column: "cleaned_text" | "translation"` — the type that makes N languages N columns.
- `const MODEL = "claude-opus-4-8"` — a hardcoded model in engine code.
- Anthropic-specific request fields anywhere outside `gateway.ts`.
- A pass throwing on the first bad batch and losing the other 2,000 segments.

## Tests

`packages/engine/src/passes/__tests__/` — all against a `FakeGateway` with scripted responses.

| File | Cases |
|---|---|
| `pass-runner.test.ts` | Response shorter than the batch → only covered idxs written, `segments_unreturned = 3`, pass state `partial`. Reordered response → correct text on correct idx. Duplicate idx → first wins, second ignored. Idx not in the batch → ignored. `text: null` / `text: 42` → skipped, not written as a string. Empty `segments` array → nothing written, no throw |
| `human-protection.test.ts` | Segment with a live `(cleaned, origin='human')` row → skipped, `segments_skipped_human = 1`, the human row is still live afterwards. With `--overwrite-human-edits` → superseded, `superseded_by` points at the pass, the human row is still retrievable, `segment_revisions` records it. A concurrent human write during the batch transaction blocks on `FOR UPDATE` and does not produce two live rows |
| `batching.test.ts` | 400 Burmese segments → every batch under budget, none over 40 segments. 400 Hausa segments → materially fewer, larger batches. A single segment larger than the budget → its own batch, never dropped. `outputBudget` floors at 1024 |
| `errors.test.ts` | Malformed once → repair succeeds. Malformed twice → batch fails, other batches still complete, pass `partial`. Truncated → batch halved and retried, both halves land. Refusal on 4 → halved once → refusal on 1 → passthrough row with `origin='rule'`, `meta.refused=true`; the other 3 are cleaned normally. Refusal is never retried unchanged (assert call count) |
| `script-integrity-guard.test.ts` | A cleanup response that returns English for a Burmese input is rejected and the source is kept, with `meta.rejected='script-integrity'` |
| `entities.test.ts` | Exact variant match found at the right offset. Fuzzy match at distance 0.08 found; 0.35 not found. A 2-grapheme term in an unspaced script is not proposed. Splice with three accepted candidates in one segment applies highest-offset-first and produces the right string. `assertOnlyChangedAt` throws when a splice would alter an unrecorded offset. `meta.substitutions` records every accepted candidate and no rejected one. A model returning a `text` field is ignored — the schema has no such field |
| `translate.test.ts` | `selectTerms` picks only terms occurring in the batch; caps at 200 by boost; `do_not_translate` renders in the second list. Target cap: a 5th target is refused without `--force`. Each target is a separate `editorial_passes` row |
| `document.test.ts` | Unknown `segmentId` dropped and counted. Timecodes recomputed from segments, ignoring the model's. `verbatim: true` claimed on a paraphrase → recomputed to `false`. An exact quote → `true`. Overlapping chapters clamped. A 30 s gap reported in `meta.gaps`, not closed. `speakerKey` not in `speakers` → `null`. A transcript over the context budget → `meta.strategy='map-reduce'` |
| `usage.test.ts` | One `usage_records` row per call with the right `kind` and `step_id`; `editorial_passes.cost_usd` equals their sum; a missing `rates` row records quantity with `usd = null` rather than failing the pass |
| `resume.test.ts` | Kill after batch 3 of 10; re-running the pass skips 1-3 (no gateway calls for them) and completes 4-10 |

`packages/engine/src/llm/prompts/__tests__/`

| File | Cases |
|---|---|
| `snapshots.test.ts` | Rendered prompt per `(promptId × {my-MM, ha-NG, am-ET, ps-AF, km-KH, ceb-PH})` against committed `.txt` files |
| `version-guard.test.ts` | A snapshot whose content hash differs from the hash recorded alongside its `promptVersion` fails with "bump promptVersion" |
| `no-language-literals.test.ts` | Grep every file in `prompts/` for `Burmese`, `Myanmar`, `English`, `မြန်မာ` outside a test fixture → must find nothing |
| `vars.test.ts` | `casingRule` for `hasCase: false` never mentions capitals; `spacingRule` for `phrase-level` forbids intra-word spaces; the RTL constraint line appears for `ps-AF` and not for `ha-NG` |

## Verification

```bash
# 1. Unit tests and prompt snapshots.
pnpm -F @thibi/engine test
#    → all green; six snapshots per prompt id

# 2. A real cleanup pass on a real Burmese run.
thibi pass cleanup <runId> --dry-run
#    → batch plan: 118 batches, ~412k input tokens, est. $0.--; no calls made
thibi pass cleanup <runId>
#    → segments_done=2314 skipped_human=0 unreturned=0 failed=0  cost=$0.--
psql -c "select layer, origin, count(*) from segment_texts where run_id='<runId>' group by 1,2"
#    → verbatim/asr 2314, cleaned/llm 2314

# 3. Human-edit protection, the property most likely to be quietly broken.
#    Edit three segments in the editor (or via the API), then re-run:
thibi pass cleanup <runId>
#    → segments_skipped_human=3, and those three rows still have origin='human'

# 4. The measured claim. This is the acceptance test for the phase.
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,restraint --gate; echo $?
#    → target: 0, every language's restraint CER at or below its control.
#      Expect yo/ps/so/ha/xh to clear comfortably on the first run and BURMESE TO FAIL
#      (research table: restraint 0.019 vs control 0.016). Iterate the prompt until it
#      passes; do not relax the gate. See risk 1.
#    → also assert content_delta == 0.000 for every language: the restraint prompt's
#      contract is that it changes nothing but punctuation, case and whitespace
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,current --gate; echo $?
#    → 2, naming yo-NG. The old prompt must still fail the gate — that is the regression test

# 5. Entities, auditable.
thibi pass entities <runId> --dry-run --explain
#    → a table: segment, offset, surface → proposed, matchKind, distance, accept, confidence
thibi pass entities <runId>
psql -c "select meta from segment_texts where layer='entity_corrected' and meta ? 'substitutions' limit 5"
#    → every substitution carries glossaryTermId, offset, matchKind, distance, confidence

# 6. Translate, cap and provenance.
thibi pass translate <runId> --target en
thibi pass translate <runId> --target th --target fr --target es --target de
#    → refused: "5 targets exceeds the cap of 4; --force after reviewing the estimate"
psql -c "select target_lang, count(*) from segment_texts where layer='translated' group by 1"

# 7. Document, with the quote check.
thibi pass document <runId> --kind quotes
#    → every quote carries segmentIds; timecodes match those segments; at least one quote
#      flagged verbatim=false if the model paraphrased, and the editor shows the warning

# 8. Resumability.
thibi pass translate <runId> --target en &   # kill after ~30s
thibi pass translate <runId> --target en
#    → resumes; the gateway is not called for completed shards; cost_usd reflects only new work

# 9. Refusal handling, on a deliberately provocative fixture run.
thibi pass cleanup <refusalRunId>
#    → completes; the refused segment has origin='rule', meta.refused=true; export still works
```

## Risks and open questions

1. **Burmese may not clear its own control, and it is the language in production.** The
   research table has restraint at 0.019 against a 0.016 do-nothing control — a small gap, but
   the wrong side of the line, in the one language shipping today. Its prose claims otherwise;
   the table wins. Two plausible causes, both testable with the harness at near-zero cost:
   the `phrase-level` spacing permission is doing damage (Burmese spacing is arbitrary and the
   reference's spacing is one arbitrary choice among many), and Burmese sentence punctuation
   `။`/`၊` placement is genuinely ambiguous. The first is checkable in one run by scoring
   Burmese with `stripWhitespace` forced on for the *cleanup* metric too — if the gap closes,
   the metric was measuring spacing preference, not damage, and the honest fix is to the metric.
   If it does not close, the fix is to the prompt. **Resolve this before claiming the phase is
   done, and record the answer here.**
2. **The restraint prompt is measured on clean text with punctuation removed, not on real ASR
   output.** FLEURS input is correct text, so the metric penalises every edit including genuine
   corrections. The restraint prompt sidesteps this by not attempting error correction at all —
   errors are the entities pass's job and the human's. But it means we have no measurement of
   how the pass behaves on genuinely garbled input. **Open:** score the pass against 30
   hand-corrected clips from a real newsroom recording via `--manifest`, once such a set exists.
   Until then the honest claim is "does not damage clean text", not "improves messy text".
3. **Refusals on newsroom content are a real operational risk.** Conflict reporting, atrocity
   testimony and political speech will trigger content filters. The halving-then-passthrough
   design keeps the transcript intact, but a newsroom whose material refuses at 30% has a
   broken feature. Mitigations: refusal counts per pass are recorded and surfaced in
   `/admin/queue`; `model_profiles` is per-pass so cleanup can be routed to a different provider
   without touching translation; OpenRouter exists in the gateway partly for this.
4. **Low-resource-language JSON quality.** Models return the wrong script, drop the `idx`, or
   answer in English for the long tail. The idx matching, the schema and the script-integrity
   guard each catch a different one of those, and all three fail *safe* — the source text
   survives. Coverage below 100% is reported, not hidden.
5. **Token estimation is a guess per script.** Under-estimating truncates output. The halving
   retry recovers, and `calibrate-tokens` fixes the constant from real `usage_records`, but the
   first Khmer job will probably halve a few batches.
6. **Glossary over-matching in unspaced scripts.** A short Burmese term substring-matches
   promiscuously. Minimum lengths and the LLM adjudication stage are the defence, and every
   substitution is recorded so a bad rule is visible rather than mysterious. **Open:** whether
   fuzzy matching should be off by default for `wordSegmentation: 'none'` until measured.
7. **Cost surprise on translate.** The 4-target cap plus a pre-run estimate is the guardrail. The
   estimate must include all targets, not one.
8. **The document pass on a 3-hour file.** Map-reduce is designed but is the least-tested path
   here. It must be exercised on a real long transcript before the UI exposes the button.
9. **Two people in one segment.** Speaker-attributed quotes inherit `segments.speaker_id`, which
   for a straddling segment is a majority vote with `speaker_purity`. A quote drawn from a
   segment with purity below 0.6 must carry the review flag through to the document, or the
   summary attributes a sentence to the wrong person. Wire `needs_speaker_review` into
   `QuotesContent` handling.
10. **`verbatim` uses a 0.02 CER threshold**, chosen not measured. Too tight and every quote with
   a stripped filler word is flagged; too loose and a paraphrase passes. **Open:** tune it
   against 50 hand-labelled quotes and record the number here.

## Definition of done

- [ ] `packages/engine/src/llm/gateway.ts` is the only file in the repo that imports
      `@ai-sdk/*` or `@openrouter/*`; a grep proves it.
- [ ] All four passes run against Anthropic, OpenAI and OpenRouter with no branch outside
      `resolve()`.
- [ ] `maxRetries: 0` on every `generateObject` call; retries live in `run_steps`.
- [ ] Model, temperature and provider for every pass come from `model_profiles`; no model id
      appears as a literal in engine code.
- [ ] Results are matched by `idx`, never by array position, with duplicate-idx rejection, and
      the original comment explaining why is present in `pass-runner.ts`.
- [ ] `segments_unreturned`, `segments_failed` and `segments_skipped_human` are recorded and
      printed by the CLI; a pass with coverage below 100% ends `partial`, never `done`.
- [ ] Batching is token-aware and script-aware; no batch exceeds 40 segments or the token budget.
- [ ] An LLM pass never supersedes an `origin='human'` row without `overwriteHumanEdits`, proven
      by a test that inspects the live row afterwards.
- [ ] Refusal → halve once → passthrough with `origin='rule'`; a refused batch never aborts the
      pass and never leaves a hole in the layer.
- [ ] One `usage_records` row per LLM call; `editorial_passes.cost_usd` equals their sum.
- [ ] Passes resume from `run_steps` shards without re-billing completed batches.
- [ ] No prompt file contains a language name; `no-language-literals.test.ts` enforces it.
- [ ] Rendered prompt snapshots exist for six languages per prompt id, and a changed snapshot
      without a `promptVersion` bump fails CI.
- [ ] `editorial_passes` records `prompt_id` and `prompt_version` for every run, and they match
      the prompt that actually executed.
- [ ] The cleanup prompt contains no instruction to fix spelling, grammar, word choice, names or
      Unicode, and no "unless unambiguous" exception.
- [ ] `thibi eval cleanup --arms control,restraint --gate` exits 0 for
      `my,yo,ps,so,ha,xh`; `--arms control,current --gate` still exits 2.
- [ ] The Burmese control gap (risk 1) is resolved and the cause — prompt or metric — is
      written into this document with the run id that settled it.
- [ ] `content_delta` is 0.000 for every language under the restraint prompt.
- [ ] `packages/eval` imports the prompt builders from `packages/engine`.
- [ ] The entities pass cannot emit a token that is not in `glossary_terms`; substitution is
      performed in TypeScript by offset splice and asserted by `assertOnlyChangedAt`.
- [ ] Every entity substitution is recorded in `segment_texts.meta` and printed by `--explain`.
- [ ] Translate honours the glossary lexicon and `do_not_translate`, caps at 4 targets, and
      writes one `editorial_passes` row per target.
- [ ] `documents.content` validates against the zod schema per kind; timecodes and `verbatim` are
      recomputed from `segmentIds`, never taken from the model.
- [ ] Quotes carry `segmentIds` so the editor can jump to the audio.
