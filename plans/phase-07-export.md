# Phase 7 — Export, subtitle reflow, bidi

## Goal

At the end of this phase `thibi export <run> --format srt --layer translated --lang en --out sub.srt`
produces a subtitle file that a real player renders correctly in Burmese, Khmer, Hausa and Pashto,
and `--format docx` produces a speaker-labelled interview transcript a journalist can paste quotes
from. Every writer takes a `LayerSpec` plus a fallback chain, which removes the current app's
hard limitation that SRT/VTT/TXT only ever emit the verbatim layer. Everything except the docx
renderer lives in `packages/core` with **zero runtime dependencies and no Node built-ins**, so the
editor previews CPS live in the browser and the harness, the CLI and the app compute identical
numbers.

It sits at 7 because it is the first phase where every prior artefact converges: segments and words
(phase 1), batch runs (2), speakers and `speaker_purity` (3), and `segment_texts` populated by the
editorial passes (6). Export is the only phase that reads all of them at once, so it is also the
phase that discovers whether they were modelled correctly. It is deliberately **before** ingest and
the queue, because export is pure — no I/O, no network, no workers — and is therefore the cheapest
place to build the `has_words = false` degradation path that the overview insists comes first.

## Prerequisites

| From | What is needed |
|---|---|
| Phase 0 | `packages/languages` registry with `script.direction`, `subtitle.{cpsMax,charsPerLineMax,maxLines,lineBreak}`, `text.wordSegmentation` |
| Phase 1 | `segments`, `words`, `runs`, `EngineContext`, `ObjectStore` port, `thibi` CLI skeleton |
| Phase 3 | `speakers`, `segments.speaker_id`, `segments.speaker_purity`, `words.speaker_id` |
| Phase 6 | `segment_texts`, `editorial_passes` populated for `cleaned` / `translated` / `entity_corrected` |
| Runtime | Node ≥ 18 with full ICU (verified below); `docx` npm package pinned in `packages/engine` only |

Not required: phase 8, phase 9. Export is synchronous in this phase; `export` becomes a
`run_steps.kind` in phase 9 with no signature change.

## Deliverables

| Path | Purpose |
|---|---|
| `packages/core/src/layers/resolve.ts` | `resolveLayer(seg, texts, want, fallback)` — replaces `lib/export.ts:6-8` `displayText` |
| `packages/core/src/layers/types.ts` | `LayerName`, `LayerSpec`, `SegmentTextRow`, `ResolvedText`, `DEFAULT_FALLBACKS` |
| `packages/core/src/export/timecode.ts` | `pad` (verbatim port), `formatTimestamp` on integer ms, `formatClock`, `parseTimestamp` |
| `packages/core/src/export/text.ts` | `graphemeLength`, `tokenize`, `myanmarSyllables`, `hasSegmenter`, capability probe |
| `packages/core/src/export/reflow.ts` | `reflow(words, lang, limits)`, `interpolateWords`, `balanceLines`, `enforceTiming` |
| `packages/core/src/export/bidi.ts` | `applyBidi`, `BidiMode`, isolate/RLM/none, trailing-punctuation handling |
| `packages/core/src/export/speakers.ts` | `splitBySpeaker` — export-time split of `speaker_purity < 0.6` segments |
| `packages/core/src/export/document.ts` | `buildTranscriptDocument` — the shared model behind `md` and `docx` |
| `packages/core/src/export/types.ts` | `ExportInput`, `ExportOptions`, `ExportWriter`, `Cue`, `ExportWarning` |
| `packages/core/src/export/writers/srt.ts` | SRT + bilingual SRT |
| `packages/core/src/export/writers/vtt.ts` | WebVTT + bilingual VTT |
| `packages/core/src/export/writers/txt.ts` | Plain text, optional timecode/speaker prefixes |
| `packages/core/src/export/writers/json.ts` | Full JSON with provider/model/prompt provenance |
| `packages/core/src/export/writers/markdown.ts` | Speaker-labelled timecoded transcript |
| `packages/core/src/export/index.ts` | `WRITERS` registry, `renderExport(input, opts)` |
| `packages/core/src/export/__fixtures__/**` | Reflow, bidi, speaker and golden-output fixtures (see Tests) |
| `packages/languages/data/languages.json` | **modified** — add `subtitle.clausePunctuation`, `subtitle.cpsUnit`, `subtitle.source` |
| `packages/engine/src/export/docx.ts` | Renders `TranscriptDocument` via the `docx` package (`bidirectional`, run `rtl`) |
| `packages/engine/src/export/load.ts` | Builds `ExportInput` from Postgres in one query set |
| `packages/engine/src/export/cache.ts` | `exports/{runId}/{sha}.{ext}` object-store cache, lifecycle assertion |
| `packages/engine/src/export/http.ts` | RFC 5987 `Content-Disposition`, filename derivation |
| `packages/engine/src/export/index.ts` | `exportRun(ctx, { runId, format, options })` — the one entry point |
| `apps/cli/src/commands/export.ts` | `thibi export` |
| `apps/web/src/app/api/runs/[id]/export/route.ts` | Ports `route.ts`, now layer-aware and cache-aware |

## Design

### 1. The layer resolver

`lib/export.ts:6-8` is one line of policy — *manual edit wins, else raw* — and it is the reason the
current app can only ever emit verbatim. Replace it with an explicit spec plus an explicit chain.

```ts
// packages/core/src/layers/types.ts
export type LayerName = 'verbatim' | 'cleaned' | 'translated' | 'entity_corrected';

export interface LayerSpec { readonly layer: LayerName; readonly lang?: string }

export interface SegmentTextRow {
  readonly segmentId: string;
  readonly layer: LayerName;
  readonly targetLang: string;          // '' except for translations
  readonly origin: 'asr' | 'llm' | 'human' | 'rule';
  readonly text: string;
  readonly passId: string | null;
}

export interface ResolvedText {
  readonly text: string;
  readonly layer: LayerName;
  readonly targetLang: string;
  readonly origin: SegmentTextRow['origin'] | 'asr_immutable';
  readonly passId: string | null;
  readonly fellBackFrom: LayerSpec | null;   // null when the requested layer was found
}
```

```ts
// packages/core/src/layers/resolve.ts
const key = (layer: LayerName, lang: string) => `${layer}\u0000${lang}`;

export function indexTexts(texts: readonly SegmentTextRow[]): Map<string, SegmentTextRow> {
  // Caller supplies live rows only (superseded_at IS NULL). Last write wins on a duplicate,
  // which cannot happen given the partial unique index — but do not throw in an exporter.
  const m = new Map<string, SegmentTextRow>();
  for (const t of texts) m.set(key(t.layer, t.targetLang), t);
  return m;
}

export function resolveLayer(
  seg: { readonly id: string; readonly text: string },
  index: Map<string, SegmentTextRow>,
  want: LayerSpec,
  fallback: readonly LayerSpec[] = [],
): ResolvedText {
  for (let i = -1; i < fallback.length; i++) {
    const spec = i < 0 ? want : fallback[i];
    const row = index.get(key(spec.layer, spec.lang ?? ''));
    if (row && row.text.trim() !== '') {
      return {
        text: row.text.trim(),
        layer: row.layer,
        targetLang: row.targetLang,
        origin: row.origin,
        passId: row.passId,
        fellBackFrom: i < 0 ? null : want,
      };
    }
  }
  // The floor is always segments.text: the immutable ASR record. An exporter never
  // returns an empty string because a pass has not run.
  return {
    text: seg.text.trim(),
    layer: 'verbatim',
    targetLang: '',
    origin: 'asr_immutable',
    passId: null,
    fellBackFrom: want.layer === 'verbatim' && !want.lang ? null : want,
  };
}
```

Default chains, exported as a constant so the editor and the exporters cannot drift:

```ts
export const DEFAULT_FALLBACKS: Readonly<Record<LayerName, readonly LayerSpec[]>> = Object.freeze({
  verbatim:         [],
  cleaned:          [{ layer: 'verbatim' }],
  entity_corrected: [{ layer: 'cleaned' }, { layer: 'verbatim' }],
  translated:       [],   // deliberately empty — see below
});
```

**`translated` has no default fallback.** Silently falling back to the source produces a file
labelled "English" containing Burmese, which is the single worst failure mode this module can
have. `ExportOptions.onMissing` governs it:

| value | behaviour |
|---|---|
| `error` (default) | Refuse the export; the error lists the first 5 missing segment indices and the total |
| `source` | Fall back through `[{layer:'cleaned'},{layer:'verbatim'}]`, emit an `ExportWarning`, and (json/md/docx) mark those segments `"untranslated": true` |
| `blank` | Emit an empty cue body; still a warning |

`ResolvedText.fellBackFrom` is what makes the warning countable: *"3 of 412 segments had no English
translation and fell back to the source."*

### 2. Grapheme and word segmentation

Two measured facts drive this section. Both were checked on Node v22.18.0 with full ICU.

**Fact 1 — `Intl.Segmenter` word granularity does ICU dictionary segmentation for exactly the
scriptio-continua set we need.** Measured output:

```
th  ["ไป","กิน","ข้าว","ที่","ร้าน","อาหาร"]
km  ["ខ្ញុំ","ចង់ទៅ","ផ្សារ"]
lo  ["ຂ້ອຍ","ໄປ","ຕະຫຼາດ"]
my  ["မင်္ဂလာ","ပါ","ခင်ဗျာ","ကျွန်တော်","နာမည်"]
```

Khmer merges `ចង់ទៅ` ("want to go") into one token — coarser than ideal, harmless for line breaking,
because a coarse tokenizer only ever *removes* break opportunities, never invents an illegal one.
That asymmetry is why dictionary segmentation is safe to depend on here and would not be safe for,
say, a word-count metric.

**Fact 2 — counting code units is wrong for Myanmar.** `မင်္ဂလာပါခင်ဗျာ` is 15 UTF-16 units,
15 code points, **11 extended grapheme clusters**, and roughly 5 written syllables. A CPS computed
on `.length` overstates reading load by ~1.4× against graphemes.

Runtime support, to be stated in the module docblock:

| Runtime | `Intl.Segmenter` | Dictionary data |
|---|---|---|
| Node ≥ 16.0 | yes | full ICU bundled by default since Node 13 — **verified on v22.18.0** |
| Bun ≥ 1.0 | yes | full ICU bundled |
| Chrome/Edge ≥ 87 | yes | yes |
| Safari ≥ 14.1 | yes | yes |
| Firefox ≥ 125 | yes | yes |
| Firefox < 125 | **no** | fallback path required |
| Node built `--with-intl=small-icu` | `Segmenter` exists, dictionaries do not | fallback path required |

```ts
// packages/core/src/export/text.ts
export const hasSegmenter: boolean =
  typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function';

/** True when this runtime actually has the dictionary, not just the API. */
export const hasDictionarySegmentation: boolean = (() => {
  if (!hasSegmenter) return false;
  try {
    const out = [...new Intl.Segmenter('th', { granularity: 'word' }).segment('ไปกินข้าว')];
    return out.length > 1;               // small-icu returns the whole run as one segment
  } catch { return false; }
})();

const graphemeCache = new Map<string, Intl.Segmenter>();
const wordCache = new Map<string, Intl.Segmenter>();

function segmenter(cache: Map<string, Intl.Segmenter>, lang: string, granularity: 'grapheme' | 'word') {
  let s = cache.get(lang);
  if (!s) { s = new Intl.Segmenter(lang, { granularity }); cache.set(lang, s); }
  return s;
}

/** Extended grapheme clusters. This is the unit `subtitle.cpsMax` is expressed in. */
export function graphemeLength(text: string, lang: string): number {
  if (!hasSegmenter) return [...text].length;          // code points; wrong, but less wrong than .length
  let n = 0;
  for (const _ of segmenter(graphemeCache, lang, 'grapheme').segment(text)) n++;
  return n;
}
```

Break opportunities:

```ts
export type LineBreakMode = 'space' | 'icu';

/**
 * Returns the text split at legal line-break opportunities, whitespace attached to the
 * preceding token. Concatenating the result reproduces the input exactly.
 */
export function tokenize(text: string, lang: string, mode: LineBreakMode): string[] {
  if (mode === 'space') return attachTrailingSpace(text.split(/(\s+)/));
  if (hasDictionarySegmentation) {
    const out: string[] = [];
    for (const s of segmenter(wordCache, lang, 'word').segment(text)) out.push(s.segment);
    return attachTrailingSpace(out);
  }
  return fallbackTokenize(text, lang);
}
```

The fallback is script-specific and deliberately unequal:

```ts
function fallbackTokenize(text: string, lang: string): string[] {
  const script = scriptOf(lang);                       // from packages/languages
  if (script === 'Mymr') return myanmarSyllables(text);
  // Thai, Lao, Khmer: there is no safe heuristic. Guessing a break inside a Thai word is
  // worse than one long line. Return one token; reflow will emit one cue per segment and
  // push an ExportWarning naming the runtime.
  if (script === 'Thai' || script === 'Laoo' || script === 'Khmr') return [text];
  return attachTrailingSpace(text.split(/(\s+)/));
}
```

Myanmar gets a fallback because **syllable boundaries are always legal Burmese line breaks**, so a
coarse syllable splitter degrades to "more breaks than a reader wants" rather than "a break in the
wrong place":

```ts
const MY_BASE = /[\u1000-\u102A\u103F\u104C-\u104F\u1050-\u1055]/u;   // consonants + independent vowels
const VIRAMA = '\u1039';
const ASAT   = '\u103A';

/**
 * sylbreak heuristic: a Myanmar base character starts a new syllable unless it is stacked
 * under the previous one (preceded by U+1039) or killed as a final (followed by U+103A).
 * Coarse, but every boundary it produces is a legal break.
 */
export function myanmarSyllables(text: string): string[] {
  const cp = [...text];
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < cp.length; i++) {
    const c = cp[i];
    const starts =
      MY_BASE.test(c) &&
      cp[i - 1] !== VIRAMA &&
      cp[i + 1] !== ASAT &&
      cp[i + 1] !== VIRAMA;
    if (starts && cur !== '') { out.push(cur); cur = ''; }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}
```

Registry additions (`packages/languages/data/languages.json`, `subtitle` block):

```jsonc
"subtitle": {
  "cpsMax": 15,
  "cpsUnit": "grapheme",          // NEW — explicit, because codepoint CPS for Mymr is ~1.4x
  "charsPerLineMax": 30,
  "maxLines": 2,
  "lineBreak": "icu",
  "clausePunctuation": "။၊",      // NEW — preferred cue-boundary characters
  "source": "provisional"         // NEW — "netflix-ttsg" | "ebu-r110" | "provisional"
}
```

### 3. Subtitle re-flow

```ts
// packages/core/src/export/reflow.ts
export interface ReflowWord {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly isEstimated?: boolean;
  readonly speakerId?: string | null;
  readonly segmentId: string;
}

export interface ReflowLimits {
  charsPerLineMax: number;
  maxLines: number;
  cpsMax: number;                 // graphemes per second
  minCueMs: number;               // 1000
  maxCueMs: number;               // 7000
  minGapMs: number;               // 80  — two frames at 25fps
  lineBreak: LineBreakMode;
  clauseChars: string;            // from the registry
}

export interface Cue {
  index: number;                  // 1-based, assigned by the writer, not here
  startMs: number;
  endMs: number;
  lines: string[];
  cps: number;
  cpsExceeded: boolean;
  isEstimated: boolean;           // any constituent word had estimated timing
  segmentIds: string[];
  speakerId: string | null;
}
```

The packer. Greedy forward fill with a clause-punctuation preference in the back 40% of the
window — the same shape as the chunk planner's back-half-of-window rule from
`lib/audio/chunk.ts`, deliberately, so the two read alike:

```ts
export function reflow(words: readonly ReflowWord[], lang: string, L: ReflowLimits): Cue[] {
  if (words.length === 0) return [];
  const budget = L.charsPerLineMax * L.maxLines;
  const cues: Cue[] = [];
  let i = 0;

  while (i < words.length) {
    let chars = 0;
    let last = i;                 // furthest index that still fits
    let clause = -1;              // best clause-punctuation boundary seen

    for (let j = i; j < words.length; j++) {
      const len = graphemeLength(words[j].text, lang);
      const dur = words[j].endMs - words[i].startMs;
      if (j > i && (chars + len > budget || dur > L.maxCueMs)) break;
      chars += len;
      last = j;
      if (chars >= budget * 0.6 && endsClause(words[j].text, L.clauseChars)) clause = j;
    }

    const cut = clause >= 0 ? clause : last;
    cues.push(buildCue(words.slice(i, cut + 1), lang, L));
    i = cut + 1;
  }
  return enforceTiming(cues, L);
}

function endsClause(token: string, clauseChars: string): boolean {
  const t = token.trimEnd();
  return t.length > 0 && clauseChars.includes(t[t.length - 1]);
}
```

Cue construction and line balancing. Balancing is a small DP that minimises the squared slack per
line, which produces the "roughly equal lines, last line not orphaned" result humans expect:

```ts
function buildCue(ws: readonly ReflowWord[], lang: string, L: ReflowLimits): Cue {
  const text = ws.map(w => w.text).join('').trim();
  const lines = balanceLines(text, lang, L);
  const startMs = ws[0].startMs;
  const endMs = Math.max(ws[ws.length - 1].endMs, startMs + 1);
  const chars = lines.reduce((n, l) => n + graphemeLength(l, lang), 0);
  const cps = chars / ((endMs - startMs) / 1000);
  return {
    index: 0,
    startMs, endMs, lines, cps,
    cpsExceeded: cps > L.cpsMax,
    isEstimated: ws.some(w => w.isEstimated === true),
    segmentIds: [...new Set(ws.map(w => w.segmentId))],
    speakerId: majoritySpeakerByDuration(ws),
  };
}

export function balanceLines(text: string, lang: string, L: ReflowLimits): string[] {
  const toks = tokenize(text, lang, L.lineBreak);
  const n = toks.length;
  if (n === 0) return [''];
  const w = toks.map(t => graphemeLength(t.trimEnd(), lang));
  const pre = [0]; for (const x of w) pre.push(pre[pre.length - 1] + x);
  const width = (a: number, b: number) => pre[b] - pre[a];          // [a, b)

  const INF = Number.POSITIVE_INFINITY;
  // best[k][a] = min cost of laying tokens [a, n) into at most k lines
  let prev = new Float64Array(n + 1).fill(INF); prev[n] = 0;
  const cut: number[][] = [];
  for (let k = 1; k <= L.maxLines; k++) {
    const cur = new Float64Array(n + 1).fill(INF);
    const c = new Int32Array(n + 1).fill(-1);
    cur[n] = 0;
    for (let a = n - 1; a >= 0; a--) {
      for (let b = a + 1; b <= n; b++) {
        const ww = width(a, b);
        if (ww > L.charsPerLineMax && b > a + 1) break;             // never overflow, except a single unbreakable token
        const slack = L.charsPerLineMax - ww;
        const cost = (b === n ? 0 : slack * slack) + prev[b];
        if (cost < cur[a]) { cur[a] = cost; c[a] = b; }
      }
    }
    cut.push(Array.from(c));
    prev = cur;
  }

  if (!Number.isFinite(prev[0])) return [text];                     // pathological: emit one long line
  const lines: string[] = [];
  let a = 0, k = cut.length - 1;
  while (a < n && k >= 0) {
    const b = cut[k][a];
    if (b < 0) break;
    lines.push(toks.slice(a, b).join('').trim());
    a = b; k--;
  }
  return lines.length ? lines : [text];
}
```

Timing normalisation runs once over the finished cue list:

```ts
function enforceTiming(cues: Cue[], L: ReflowLimits): Cue[] {
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k];
    if (c.endMs - c.startMs < L.minCueMs) {
      const ceiling = k + 1 < cues.length ? cues[k + 1].startMs - L.minGapMs : Infinity;
      c.endMs = Math.max(c.startMs + 1, Math.min(c.startMs + L.minCueMs, ceiling));
    }
    if (k > 0) {
      const p = cues[k - 1];
      if (c.startMs - p.endMs < L.minGapMs) p.endMs = Math.max(p.startMs + 1, c.startMs - L.minGapMs);
    }
  }
  for (let k = 0; k < cues.length; k++) recomputeCps(cues[k], L);
  return cues.map((c, k) => ({ ...c, index: k + 1 }));
}
```

**`cpsExceeded` is reported, never silently fixed.** Fixing it means either dropping text or
stealing time from a neighbouring cue; both are editorial decisions. The exporter counts them into
an `ExportWarning` (`"9 of 240 cues exceed 15 cps"`) and the editor renders the same flag live,
because both call this function.

#### The `has_words = false` degradation path

Built first, per the overview. A segment with no words is turned into synthetic words by
proportional grapheme-count interpolation across the segment interval, and every derived artefact
inherits `isEstimated`.

```ts
export function interpolateWords(
  segment: { id: string; startMs: number; endMs: number; speakerId?: string | null },
  text: string,
  lang: string,
  mode: LineBreakMode,
): ReflowWord[] {
  const toks = tokenize(text, lang, mode).filter(t => t.trim() !== '');
  if (toks.length === 0) return [];
  const weight = toks.map(t => Math.max(1, graphemeLength(t.trimEnd(), lang)));
  const total = weight.reduce((a, b) => a + b, 0);
  const span = Math.max(1, segment.endMs - segment.startMs);
  const out: ReflowWord[] = [];
  let acc = 0;
  for (let i = 0; i < toks.length; i++) {
    const s = segment.startMs + Math.round((acc / total) * span);
    acc += weight[i];
    const e = segment.startMs + Math.round((acc / total) * span);
    out.push({
      startMs: s,
      endMs: Math.max(e, s + 1),
      text: toks[i],
      isEstimated: true,
      speakerId: segment.speakerId ?? null,
      segmentId: segment.id,
    });
  }
  return out;
}
```

Propagation of `isEstimated`, per format:

| Format | How estimation is surfaced |
|---|---|
| `json` | `"timing": "estimated"` on the cue and `"isEstimated": true` on each word |
| `vtt` | `NOTE timings estimated — this run has no word-level timings` in the file header |
| `srt` | Nowhere — SRT has no comment syntax. Reported via `ExportWarning` and the CLI's stderr summary |
| `md` / `docx` | A single italic line under the provenance block |
| CLI | `warning: 412 of 412 segments had no word timings; cue boundaries are interpolated` |

`ExportInput` construction (`packages/engine/src/export/load.ts`) is where the choice happens: for
each segment, use real `words` rows when `has_words`, else `interpolateWords`. Nothing downstream
of that line knows the difference except through `isEstimated`.

### 4. Bidi

`packages/core/src/export/bidi.ts`. SRT and VTT carry no direction metadata at all, so a Pashto cue
beginning with a Latin acronym has first-strong-character LTR and renders with the Pashto to the
right of the acronym — visually backwards.

```ts
export const LRI = '\u2066', RLI = '\u2067', FSI = '\u2068', PDI = '\u2069';
export const LRM = '\u200E', RLM = '\u200F';

export type BidiMode = 'isolate' | 'rlm' | 'none';

export interface BidiOptions {
  mode: BidiMode;                              // default 'isolate'
  dir: 'rtl' | 'ltr' | 'auto';                 // from registry script.direction
  trailingPunctuation: 'inside' | 'outside';   // default 'inside' — see Risks
}

// Neutral / weak trailing run. Note U+061F ARABIC QUESTION MARK and U+060C ARABIC COMMA.
const TRAILING = /[\s.,!?;:…"'”’»)\]}\u061F\u060C\u061B\u06D4]+$/u;

export function applyBidi(line: string, o: BidiOptions): string {
  if (o.mode === 'none' || o.dir === 'ltr' || line === '') return line;
  if (o.mode === 'rlm') return RLM + line;

  const open = o.dir === 'auto' ? FSI : RLI;
  if (o.trailingPunctuation === 'inside') return open + line + PDI;

  const m = TRAILING.exec(line);
  if (!m) return open + line + PDI;
  const core = line.slice(0, line.length - m[0].length);
  if (core === '') return open + line + PDI;
  return open + core + PDI + m[0];
}
```

Rules, all of them load-bearing:

1. **Applied per line, not per cue.** A hard line break in SRT/VTT resets the bidi paragraph in most
   renderers, so an isolate opened on line 1 does not survive to line 2. Every line is wrapped
   independently.
2. **Only `srt` and `vtt` get bidi marks.** `docx` carries direction structurally (`w:bidi`,
   run-level `w:rtl`), and `txt` / `md` / `json` go into editors and pipelines where invisible
   control characters show up as tofu or corrupt a diff. `renderExport` forces `mode: 'none'` for
   those formats and ignores a user override with a warning.
3. **`auto` uses FSI**, which lets the renderer pick base direction from the first strong character
   — correct for a bilingual file where some cues are the English translation.
4. The `rlm` mode exists because a handful of players (older mobile SoC decoders, some hardware
   TVs) drop U+2066–U+2069 entirely; a leading RLM sets the paragraph direction without needing
   isolate support and is the pragmatic degradation.

Worked fixture, the case that motivates the whole module:

```
input   UN د افغانستان لپاره ۱۴ میلیون ډالره مرسته اعلان کړه؟
none    UN د افغانستان لپاره ۱۴ میلیون ډالره مرسته اعلان کړه؟
        → base direction LTR (first strong char = 'U'); the Pashto run is pushed right of "UN"
isolate \u2067UN د افغانستان لپاره ۱۴ میلیون ډالره مرسته اعلان کړه؟\u2069
        → base direction RTL; "UN" is an LTR island at the right edge, '؟' at the left edge
outside \u2067UN د افغانستان لپاره ۱۴ میلیون ډالره مرسته اعلان کړه\u2069؟
rlm     \u200FUN د افغانستان لپاره ۱۴ میلیون ډالره مرسته اعلان کړه؟
```

### 5. Formats

```ts
// packages/core/src/export/types.ts
export type ExportFormat =
  | 'srt' | 'vtt' | 'txt' | 'json' | 'md'
  | 'srt-bilingual' | 'vtt-bilingual'
  | 'docx';

export interface ExportOptions {
  layer: LayerSpec;
  fallback: readonly LayerSpec[];
  secondary?: LayerSpec;                 // bilingual only; rendered under `layer`
  onMissing: 'error' | 'source' | 'blank';
  speakers: boolean;                     // prefix cues / label turns
  splitImpureSegments: boolean;          // default true
  purityThreshold: number;               // default 0.6
  bidi: BidiOptions;
  limits: Partial<ReflowLimits>;         // merged over the registry defaults
  timecodes: boolean;                    // txt/md
  bom: boolean;                          // default false
  withCues: boolean;                     // json only
}

export interface ExportWarning { code: string; message: string; count: number }

export interface ExportResult {
  body: string | Uint8Array;
  mime: string;
  extension: string;
  filename: string;
  warnings: ExportWarning[];
}
```

| id | ext | mime | rendered in |
|---|---|---|---|
| `srt` | `srt` | `application/x-subrip; charset=utf-8` | core |
| `vtt` | `vtt` | `text/vtt; charset=utf-8` | core |
| `txt` | `txt` | `text/plain; charset=utf-8` | core |
| `json` | `json` | `application/json; charset=utf-8` | core |
| `md` | `md` | `text/markdown; charset=utf-8` | core |
| `srt-bilingual` | `srt` | `application/x-subrip; charset=utf-8` | core |
| `vtt-bilingual` | `vtt` | `text/vtt; charset=utf-8` | core |
| `docx` | `docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | **engine** |

`docx` is in `packages/engine`, not `packages/core`, because the `docx` npm package is a runtime
dependency and `core` has none. `core` exports the `TranscriptDocument` model; `engine` renders it.
Same split, same reason, as `Content-Disposition` living in `engine`.

#### Timecode — ported, with a bug fixed

`pad` from `lib/export.ts:10-12` travels verbatim. `formatTimestamp` from `:14-22` is rewritten on
integer milliseconds, because the whole new schema is `*_ms` and because **the original has a real
carry bug**:

```
old formatTimestamp(59.9996, ',')  →  "00:00:59,1000"     ← four-digit ms, malformed SRT
old formatTimestamp(3661.5,  ',')  →  "01:01:01,500"      ← correct
```

`Math.round((c - Math.floor(c)) * 1000)` can return 1000 without carrying into seconds. The
replacement rounds once, up front, and derives everything from the integer:

```ts
// packages/core/src/export/timecode.ts

/** Ported verbatim from lib/export.ts:10-12. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** 3661500 → "01:01:01,500" (SRT) or "01:01:01.500" (VTT). Always HH:MM:SS. */
export function formatTimestamp(ms: number, msSeparator: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(t % 1000, 3)}`;
}
```

WebVTT permits `MM:SS.mmm`; always emit `HH:MM:SS.mmm`, which every parser accepts.
Line endings are **LF**, no BOM, one trailing newline. `--bom` prepends U+FEFF for the Windows
players that need it; it is off by default because it breaks `diff` and some ffmpeg builds.

#### SRT / VTT

```ts
export function renderSrt(cues: readonly Cue[], o: ExportOptions): string {
  return cues.map(c => {
    const lines = c.lines.map(l => applyBidi(prefixSpeaker(l, c, o), o.bidi));
    return `${c.index}\n${formatTimestamp(c.startMs, ',')} --> ${formatTimestamp(c.endMs, ',')}\n${lines.join('\n')}\n`;
  }).join('\n');
}
```

Structure preserved verbatim from `lib/export.ts:24-34` — 1-based index, `-->`, each block already
ending in `\n` so `join('\n')` produces the required blank line. VTT keeps `WEBVTT\n\n` from
`:36-44` and gains an optional `NOTE` header block for estimated timings and provenance.

Speaker prefix, when `opts.speakers`: `srt` uses `<v Name>` only in VTT (it is standard there) and a
plain `Name: ` prefix in SRT, where `<v>` is not part of the format and shows as literal text in
VLC.

#### Bilingual SRT / VTT

Source above translation, two texts merged into one cue.

The hard part: the translated layer has **no word timings**, ever — it is LLM output keyed to a
segment. So the two layers cannot be reflowed independently and then zipped; that produces cue
boundaries that disagree.

The rule:

1. Reflow the **primary** layer (`opts.layer`, default the source) normally, from its words.
2. For each primary cue, take the set of `segmentIds` it covers. For each such segment, resolve the
   secondary layer's text and cut it proportionally by grapheme count at the same relative offsets
   the primary cue occupies within that segment.
3. Every secondary line is `isEstimated`. When a primary cue spans exactly one whole segment — the
   common case for short segments — no cutting happens and the secondary line is exact.
4. `charsPerLineMax` and `maxLines` are checked against the **combined** cue; a bilingual cue
   defaults to `maxLines: 4` (2 + 2) and `cpsMax` is taken from the primary language only, since a
   viewer reads one of the two.

```
1
00:00:12,340 --> 00:00:16,010
ကျွန်တော်တို့ ရွေးကောက်ပွဲကို စောင့်ကြည့်နေပါတယ်
We are monitoring the election.
```

Optional `--bilingual-style tag` writes VTT with two `<v>` voices and a CSS class so a web player
can style the translation, and `--bilingual-order translation-first` inverts the stack.

#### Speaker-labelled transcript — `md` and `docx`

A distinct output shape, not a subtitle file: timecoded, speaker-attributed prose. Consecutive
segments from the same speaker merge into one turn, with an inline timecode anchor every
`anchorEveryMs` (default 30 000) inside a long turn so a quote can be located in the audio.

```ts
// packages/core/src/export/document.ts
export interface TranscriptBlock { startMs: number; text: string; isEstimated: boolean; untranslated: boolean }
export interface TranscriptTurn {
  speakerId: string | null;
  speakerName: string | null;
  uncertain: boolean;              // speaker_purity below threshold and not splittable
  startMs: number; endMs: number;
  blocks: TranscriptBlock[];
}
export interface TranscriptDocument {
  title: string;
  dir: 'rtl' | 'ltr';
  lang: string;
  provenance: ProvenanceBlock;
  turns: TranscriptTurn[];
  warnings: ExportWarning[];
}
export function buildTranscriptDocument(input: ExportInput, o: ExportOptions): TranscriptDocument;
```

Markdown rendering:

```markdown
# Interview — Daw Khin Ma Ma Myo

*Transcribed with google/chirp_2 (my-MM) · translated to English with
anthropic/claude-sonnet-4-5 (prompt `translate.v3`) · thibi-transcribe 0.7.0 · 2026-08-09*

### [00:00:12] Daw Khin Ma Ma Myo

We are monitoring the election closely. `[00:00:44]` The main concern is access for
observers in the border townships.

### [00:01:31] Interviewer

Has that improved since March?
```

DOCX renders the same model. The `docx` package (pin the major in
`packages/engine/package.json`; the run-level flag was renamed across majors — use
`rightToLeft` and keep a compile-time assertion that the option exists):

```ts
// packages/engine/src/export/docx.ts
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';

function turnParagraphs(t: TranscriptTurn, doc: TranscriptDocument): Paragraph[] {
  const rtl = doc.dir === 'rtl';
  const head = new Paragraph({
    heading: HeadingLevel.HEADING_3,
    bidirectional: rtl,                                   // → w:bidi on the paragraph
    alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: [
      new TextRun({ text: `[${formatClock(t.startMs)}] `, bold: true, rightToLeft: false }),
      new TextRun({ text: t.speakerName ?? 'Unknown speaker', bold: true, rightToLeft: rtl }),
      ...(t.uncertain ? [new TextRun({ text: '  (speaker uncertain)', italics: true })] : []),
    ],
  });
  const body = t.blocks.map(b => new Paragraph({
    bidirectional: rtl,
    alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: [new TextRun({ text: b.text, rightToLeft: rtl })],
  }));
  return [head, ...body];
}
```

Timecodes and speaker names are emitted as `rightToLeft: false` runs even in an RTL document,
because `[00:12:03]` is an LTR token; this is the structural equivalent of the isolate wrapping in
SRT and is why docx needs no bidi control characters.

#### Export-time speaker splitting

Segments are never split by the pipeline. `speaker_purity < 0.6` means ASR endpointing straddled a
speaker change, which in an interview is the normal case at exactly the moments that matter. Split
at export:

```ts
// packages/core/src/export/speakers.ts
export interface SplitOptions { purityThreshold: number; minRunMs: number; minRunWords: number }
export const DEFAULT_SPLIT: SplitOptions = { purityThreshold: 0.6, minRunMs: 400, minRunWords: 2 };

export function splitBySpeaker(seg: ExportSegment, o: SplitOptions): ExportSegment[] {
  if (seg.speakerPurity == null || seg.speakerPurity >= o.purityThreshold) return [seg];

  // No words → no boundary to split at. Never guess where one speaker stopped.
  if (!seg.hasWords) return [{ ...seg, speakerUncertain: true }];

  // Run-length encode the word sequence by speaker, then absorb runs too short to be real.
  const runs = absorbShortRuns(runLengthBySpeaker(seg.words), o);
  if (runs.length < 2) return [seg];

  return runs.map((r, k) => ({
    ...seg,
    id: `${seg.id}#${k}`,
    derivedFrom: seg.id,
    startMs: r.words[0].startMs,
    endMs: r.words[r.words.length - 1].endMs,
    words: r.words,
    text: r.words.map(w => w.text).join(seg.lineBreak === 'space' ? ' ' : '').trim(),
    speakerId: r.speakerId,
    speakerPurity: 1,
  }));
}
```

`absorbShortRuns` merges any run under `minRunMs` **and** under `minRunWords` into whichever
neighbour is longer. This is deliberately the same guard shape as reconcile's width-3 median
filter (phase 3) and for the same reason: a genuine one-word interjection in an interview is
exactly the word that matters, so the guard requires *both* conditions before eating a run.

**The constraint the brief does not mention, and which matters most:** splitting rewrites
`text` from the word sequence, so it is only valid on the **verbatim** layer. `cleaned`,
`entity_corrected` and `translated` rows are per-segment strings with no word alignment. When
`opts.layer` is not verbatim and a segment is impure, the segment is **not** split; it is emitted
whole, attributed to the majority speaker, and marked `speakerUncertain`, with an
`ExportWarning` counting how many. Attributing a translated sentence to the wrong person in a
newsroom document is worse than an honest "(speaker uncertain)".

#### JSON provenance

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T11:04:22.113Z",
  "engineVersion": "0.7.0",
  "run": {
    "id": "…", "jobId": "…", "provider": "google", "model": "chirp_2",
    "languageCode": "my-MM", "mode": "batch", "wordTimingQuality": "full",
    "costUsd": 0.42, "createdAt": "…"
  },
  "job": { "id": "…", "title": "…", "filename": "interview-01.m4a" },
  "asset": { "sha256": "…", "durationMs": 4322000, "source": "upload", "sourceMeta": null },
  "layer": { "layer": "translated", "lang": "en" },
  "fallbacks": [{ "from": { "layer": "translated", "lang": "en" }, "to": "verbatim", "count": 3 }],
  "passes": [{
    "id": "…", "kind": "translate", "layer": "translated", "targetLang": "en",
    "sourceLayer": "cleaned",
    "llmProvider": "anthropic", "model": "claude-sonnet-4-5",
    "promptId": "translate.v3", "promptVersion": 3,
    "glossaryIds": ["…"], "tokensIn": 214_003, "tokensOut": 68_140,
    "segmentsDone": 409, "segmentsSkippedHuman": 3, "costUsd": 0.31
  }],
  "speakers": [{ "id": "…", "key": "speaker-00", "displayName": "Daw Khin Ma Ma Myo" }],
  "warnings": [{ "code": "cps_exceeded", "message": "…", "count": 9 }],
  "segments": [{
    "id": "…", "idx": 0, "startMs": 12340, "endMs": 16010,
    "speakerId": "…", "speakerPurity": 0.94, "needsSpeakerReview": false,
    "hasWords": true, "confidence": 0.91,
    "text": "We are monitoring the election.",
    "origin": "llm", "passId": "…",
    "textVerbatim": "ကျွန်တော်တို့ ရွေးကောက်ပွဲကို စောင့်ကြည့်နေပါတယ်",
    "words": [{ "startMs": 12340, "endMs": 12610, "text": "…", "confidence": 0.88,
                "speakerId": "…", "isEstimated": false }]
  }],
  "cues": []
}
```

`textVerbatim` is always included alongside a non-verbatim layer — a JSON export of a translation
that cannot be checked against the source is not useful to a newsroom. `cues` is populated only
with `--with-cues`, since it doubles file size.

### 6. Export caching

```
exports/{runId}/{sha256(canonicalJson({format, options, contentEtag, engineVersion}))}.{ext}
```

`contentEtag` is one query, so an edit invalidates without a trigger or a version column:

```sql
SELECT concat_ws(':',
  coalesce(max(s.updated_at),  'e'), coalesce(count(s.id), 0),
  coalesce(max(t.created_at),  'e'),
  coalesce(max(p.updated_at),  'e'),
  coalesce(max(sp.updated_at), 'e')
) AS etag
FROM segments s
LEFT JOIN segment_texts    t  ON t.run_id = s.run_id AND t.superseded_at IS NULL
LEFT JOIN editorial_passes p  ON p.run_id = s.run_id
LEFT JOIN speakers        sp  ON sp.job_id = $2
WHERE s.run_id = $1 AND s.superseded_at IS NULL;
```

`canonicalJson` sorts keys and drops undefined so option ordering cannot produce a cache miss.

| Property | Decision |
|---|---|
| Lookup | `store.head(key)`; hit → stream/presign, miss → render, `store.put`, then serve |
| Lifecycle | 30 days on the `exports/` prefix, asserted at first use the same way the GCS staging lifecycle is asserted; refuse to cache (but still serve) if the rule is absent, printing the `mc ilm` command |
| Invalidation | None needed — the key contains the etag. Stale objects age out |
| Bypass | `--no-cache` / `?nocache=1` renders and overwrites |
| Never cached | Exports that produced an `onMissing: 'error'` failure; exports with `--stdout` |
| Regenerable | Yes, always. Losing the whole prefix costs CPU, not data |

### 7. HTTP and filenames

```ts
// packages/engine/src/export/http.ts
// RFC 5987 attr-char = ALPHA / DIGIT / "!" "#" "$" "&" "+" "-" "." "^" "_" "`" "|" "~"
// encodeURIComponent leaves ' ( ) * unescaped, which are NOT attr-char. The old route at
// app/api/runs/[id]/export/route.ts:34 has this bug and also omits the ASCII fallback.
const EXTRA = /['()*]/g;
const hex = (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase();

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(filename).replace(EXTRA, hex);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}
```

Filename derivation keeps the base-name rule from `route.ts:28` and adds the layer:

```ts
const base = (job.title || job.filename).replace(/\.[^.]+$/, '') || 'transcript';
const parts = [base];
if (opts.layer.lang) parts.push(opts.layer.lang);
if (opts.layer.layer !== 'verbatim') parts.push(opts.layer.layer);
parts.push(run.provider);
const filename = `${parts.join('.')}.${writer.extension}`;
// → "interview-01.en.translated.google.srt"
```

The route otherwise ports `route.ts` structurally: 404 on unknown run, 400 listing valid formats,
`Content-Type` from the writer. New: `?layer=`, `?lang=`, `?fallback=`, `?bidi=`, `?speakers=`,
`?cps=`, and warnings echoed in an `X-Thibi-Warnings` header (JSON, so the UI can toast them
without re-parsing the body).

### 8. CLI

```
thibi export <run> --format srt --layer translated --lang en --out sub.srt
```

| Flag | Default | Notes |
|---|---|---|
| `--format` | `srt` | one of the 8 ids |
| `--layer` | `verbatim` | |
| `--lang` | — | required when `--layer translated` |
| `--fallback` | per `DEFAULT_FALLBACKS` | comma list, e.g. `cleaned,verbatim` |
| `--on-missing` | `error` | `error` \| `source` \| `blank` |
| `--bilingual <layer[:lang]>` | — | implies `--format srt-bilingual` unless overridden |
| `--speakers` / `--no-speakers` | on for `md`/`docx`, off for subtitles | |
| `--no-split-impure` | split on | disables export-time speaker splitting |
| `--purity` | `0.6` | |
| `--cps`, `--chars-per-line`, `--max-lines`, `--min-cue-ms`, `--max-cue-ms` | registry | override the registry per run |
| `--bidi` | `isolate` | `isolate` \| `rlm` \| `none` |
| `--trailing-punct` | `inside` | `inside` \| `outside` |
| `--bom` | off | |
| `--with-cues` | off | json only |
| `--out <path>` | — | `-` or omitted with `--stdout` writes to stdout |
| `--no-cache` | off | |
| `--json` | off | machine-readable result envelope on stdout, file still written |

Exit codes: `0` ok, `2` bad arguments, `3` `onMissing: error` triggered, `4` run not found.
Warnings always go to **stderr**, so `thibi export … --stdout > f.srt` stays clean.

## Porting notes

| Old | New | Treatment |
|---|---|---|
| `lib/export.ts:10-12` `pad` | `core/src/export/timecode.ts` | **Verbatim** |
| `lib/export.ts:14-22` `formatTimestamp` | same file | **Changed** — integer ms; fixes the `59.9996 → "00:00:59,1000"` carry bug |
| `lib/export.ts:24-34` `toSrt` | `writers/srt.ts` | Structure verbatim (index, `-->`, blank-line join); body now cue-based |
| `lib/export.ts:36-44` `toVtt` | `writers/vtt.ts` | `WEBVTT\n\n` header verbatim; adds `NOTE` blocks |
| `lib/export.ts:46-48` `toTxt` | `writers/txt.ts` | Extended with timecode/speaker prefixes |
| `lib/export.ts:50-64` `toJson` | `writers/json.ts` | **Replaced** — the old shape hardcodes four text columns, which is exactly the model this repo abandoned |
| `lib/export.ts:66-74` `EXPORTERS` | `export/index.ts` `WRITERS` | Same registry idea, richer writer interface |
| `route.ts:28-29` filename derivation | `engine/src/export/http.ts` | Kept, extended with layer/lang |
| `route.ts:34` `Content-Disposition` | same | **Changed** — escape `'()*`, add the ASCII `filename=` fallback |
| `route.ts:11-20` run lookup + format validation | `apps/web/.../export/route.ts` | Structure kept, Drizzle instead of `better-sqlite3` |
| `job-detail.tsx` `formatClock` | `core/src/export/timecode.ts` | **Verbatim**, re-exported so the editor and `md` agree |

**Must not survive the port:**

- `displayText` (`lib/export.ts:6-8`). Its `edited_text ?? text` policy is the whole reason the
  current app cannot export a translation. There is no equivalent function; `resolveLayer` takes
  an explicit spec and there is no default.
- The four-column `toJson` shape (`:50-64`) — `edited_text` / `cleaned_text` / `translation` are
  the columns `segment_texts` replaced.
- `SegmentRow`'s float `start_sec` / `end_sec`. Everything is integer ms.

## Tests

`packages/core` uses `node --test` with fixtures as JSON, and byte-exact golden files.

### `layers/__tests__/resolve.test.ts`

| Case | Assertion |
|---|---|
| `human-beats-llm` | Two live rows for `(cleaned,'')` is impossible; assert the index keeps the last and does not throw |
| `wanted-present` | `fellBackFrom === null`, `origin` passes through |
| `translated-missing` | Falls through the supplied chain; `fellBackFrom` equals the requested spec |
| `empty-text-skipped` | A row with `text: '   '` is treated as absent |
| `immutable-floor` | No rows at all → `segments.text`, `origin === 'asr_immutable'` |
| `no-silent-translation-fallback` | `DEFAULT_FALLBACKS.translated` is `[]` (a regression guard on the dangerous default) |

### `export/__tests__/reflow.test.ts` — `__fixtures__/reflow/`

| Fixture | Asserts |
|---|---|
| `my-news-45s.words.json` | Burmese, real Chirp timings: no cue > `cpsMax`, no line > `charsPerLineMax` graphemes, every break at an ICU token boundary |
| `my-no-words.segments.json` | `has_words:false` → all cues `isEstimated`, ≥ 2 cues, strictly increasing non-overlapping times |
| `th-scriptio.words.json` | Thai: breaks match a hand-checked expected list; **no break inside a listed word** |
| `km-scriptio.words.json` | Khmer, same shape |
| `lo-scriptio.words.json` | Lao, same shape |
| `ha-long-sentence.words.json` | Hausa `space` mode: two lines within 3 graphemes of equal length |
| `ps-rtl.words.json` | Pashto: reflow then bidi, combined golden output |
| `clause-preference.words.json` | Cue ends after `။`, not mid-clause, when the clause mark is in the back 40 % |
| `clause-too-early.words.json` | A `။` at 20 % of the window is **ignored** (guards against 3-word cues) |
| `one-word-30s.words.json` | A single 30 s token → one cue clamped to `maxCueMs`, no crash, warning emitted |
| `zero-duration.words.json` | `endMs === startMs` → no division by zero, extended to `minCueMs` |
| `overlapping-words.words.json` | Words with overlapping ranges (a real Chirp artefact) → monotonic cues |
| `single-unbreakable-token.json` | One token longer than `charsPerLineMax` → emitted on one over-long line, warning, never dropped |

Plus a property test: for 500 random word sequences, `cues.flatMap(c => c.lines).join('')` with
whitespace normalised equals the input text with whitespace normalised. **No reflow may lose a
character.**

Plus a degraded-runtime test that stubs `Intl.Segmenter` to the small-icu behaviour and asserts:
Myanmar falls back to syllables and still reflows; Thai emits one cue per segment plus the
`no_dictionary_segmentation` warning.

### `export/__tests__/bidi.test.ts` — `__fixtures__/bidi/`

| Fixture | Asserts |
|---|---|
| `ps-latin-acronym.json` | `UN د افغانستان…؟` → starts `\u2067`, ends `\u2069`, `UN` byte-identical, all four modes as golden strings |
| `ar-trailing-question.json` | `inside` vs `outside` produce the two documented strings; `؟` position differs by exactly the PDI |
| `mixed-digits.json` | Eastern-Arabic `۱۴۰۳` and ASCII `2026` in one cue survive unmodified |
| `two-line-cue.json` | Each line wrapped independently; exactly 2 RLI and 2 PDI |
| `rlm-mode.json` | Leading `\u200F`, zero isolate characters |
| `none-mode.json` | Output byte-identical to input |
| `ltr-noop.json` | Hausa cue unchanged in every mode |
| `empty-and-punct-only.json` | `''` and `'؟'` do not produce an empty isolate |

### `export/__tests__/speakers.test.ts` — `__fixtures__/speakers/`

| Fixture | Asserts |
|---|---|
| `impure-two-runs.json` | purity 0.42, two clean runs → 2 sub-segments with word-derived times, ids `#0` / `#1`, `derivedFrom` set |
| `flicker-180ms.json` | A 180 ms 1-word run is absorbed → still 1 segment |
| `genuine-interjection.json` | A 700 ms 1-word run is **kept** → 3 sub-segments (the guard requires both conditions) |
| `no-words-impure.json` | Not split; `speakerUncertain: true` |
| `translated-layer-impure.json` | Not split even with words; warning counted |
| `all-same-speaker-low-purity.json` | Purity low but one run → returned unchanged |

### `export/__tests__/writers.test.ts` — `__fixtures__/golden/`

Byte-exact comparison of `my-verbatim.srt`, `my-en-bilingual.srt`, `ps-isolate.vtt`,
`ha-speakers.vtt`, `interview.md`, `interview.json`, `estimated.vtt`. Also asserted: LF line
endings, exactly one trailing newline, no BOM by default, BOM present with `--bom`, SRT indices
contiguous from 1.

### `export/__tests__/timecode.test.ts`

| Input | Expected |
|---|---|
| `3_661_500` | `01:01:01,500` (parity with the old function) |
| `59_999.6` | `00:01:00,000` — **the carry-bug regression guard** |
| `-5` | `00:00:00,000` |
| `0` | `00:00:00,000` |
| `359_999_999` | `99:59:59,999` |
| round-trip | `parseTimestamp(formatTimestamp(x)) === Math.round(x)` for 10 000 random values |

### `packages/engine/src/export/__tests__/`

- `docx.test.ts` — unzip the produced `.docx` and assert `w:bidi` on paragraphs and `w:rtl` on runs
  for a Pashto document, absent for Hausa; assert the timecode run has no `w:rtl`.
- `cache.test.ts` — `MemoryObjectStore`; two identical exports issue one render; changing
  `--cps` changes the key; a segment edit changes `contentEtag` and therefore the key.
- `http.test.ts` — `contentDisposition("ဆွေးနွေးပွဲ (၁).srt")` escapes `(` and `)`, has an ASCII
  fallback, and round-trips through `content-disposition`'s parser.

## Verification

```bash
# zero runtime deps in core — this is the invariant, so assert it mechanically
node -e "const p=require('./packages/core/package.json');
         if (Object.keys(p.dependencies||{}).length) { console.error('core has deps'); process.exit(1) }"

# core must not import node built-ins
grep -rnE "from ['\"]node:|require\(['\"]node:" packages/core/src && exit 1 || echo "core is browser-safe"

pnpm --filter @thibi/core test        # all fixtures above
pnpm --filter @thibi/engine test

# runtime capability, printed into the phase-7 notes
node -e "console.log([...new Intl.Segmenter('my',{granularity:'word'}).segment('မင်္ဂလာပါခင်ဗျာကျွန်တော်နာမည်')].map(s=>s.segment))"
# expected: [ 'မင်္ဂလာ', 'ပါ', 'ခင်ဗျာ', 'ကျွန်တော်', 'နာမည်' ]

thibi export "$RUN" --format srt  --layer verbatim              --out /tmp/my.srt
thibi export "$RUN" --format srt  --layer translated --lang en  --out /tmp/en.srt
thibi export "$RUN" --format srt-bilingual --layer verbatim --bilingual translated:en --out /tmp/bi.srt
thibi export "$RUN" --format vtt  --bidi isolate                --out /tmp/ps.vtt
thibi export "$RUN" --format docx --speakers                    --out /tmp/interview.docx
thibi export "$RUN" --format json --with-cues                   --out /tmp/run.json

# structural validation — ffmpeg refuses malformed timestamps and reports the cue count
ffmpeg -v error -i /tmp/my.srt -f null - && echo "srt parses"
ffprobe -v error -show_entries stream=nb_read_packets -count_packets -select_streams s:0 /tmp/en.srt

# provenance present
jq -e '.passes[0].promptVersion and .run.model and .engineVersion' /tmp/run.json

# docx direction
mkdir -p /tmp/dx && (cd /tmp/dx && unzip -o -q /tmp/interview.docx && grep -c '<w:bidi' word/document.xml)

# cache: second call renders nothing
time thibi export "$RUN" --format srt --out /tmp/a.srt
time thibi export "$RUN" --format srt --out /tmp/b.srt   # should be materially faster
cmp /tmp/a.srt /tmp/b.srt
```

Manual, once per phase, on the four script classes from the overview's E2E list (Hausa, Amharic,
Khmer, Pashto):

1. Open each SRT in **VLC** and in a browser `<track>` element. Check direction, line count, and
   that no isolate marks are visible as glyphs.
2. Open the Pashto DOCX in **Word or LibreOffice**: paragraphs right-aligned, timecodes LTR.
3. Toggle `--bidi none` on the Pashto file and confirm it renders visibly wrong — if it looks the
   same, the isolates are not doing anything and the player is normalising them.

## Risks and open questions

1. **`trailingPunctuation: 'outside'` contradicts UAX #9.** With `RLI text؟ PDI`, the `؟` renders
   at the left edge of the RTL run, which is correct Arabic/Pashto typography. Hoisting it outside
   the isolate makes it take the *paragraph* direction, which in an LTR-based player puts it on the
   right. The brief asked for outside; the default here is `inside` with `outside` as an
   escape hatch and both golden fixtures committed. **Settle it with the player matrix in
   Verification before the UI exposes the option**, and record the result in this file.
2. **`cpsMax` values for the exclusive-language set are guesses.** Netflix's Timed Text Style
   Guides cover Thai, Khmer, Arabic and Hebrew; nothing authoritative exists for Hausa, Oromo,
   Sorani or Burmese. Seed from TTSG where it exists, mark everything else
   `"source": "provisional"`, and surface that word in the export dialog rather than presenting a
   made-up number as a standard.
3. **Grapheme is not syllable for Burmese.** Measured: `မင်္ဂလာပါခင်ဗျာ` is 15 code points,
   11 graphemes, ~5 syllables. `cpsUnit: "grapheme"` is the committed decision because
   `Intl.Segmenter` provides it consistently and it matches what "characters per second" means in
   every published guideline. Open: whether a syllable-based limit correlates better with Burmese
   reading speed. Measurable later against editor telemetry; not blocking.
4. **The translated layer has no word timings, ever.** Bilingual secondary lines and any
   non-verbatim speaker split are therefore estimated or refused. If the product later wants exact
   bilingual cue alignment, the answer is a forced-alignment step, not a smarter exporter.
5. **`docx` package API churn.** `bidirectional` (paragraph) and `rightToLeft` (run) have been
   renamed across majors. Pin exactly, and let `docx.test.ts` fail the build on an upgrade rather
   than silently emitting an LTR Pashto document.
6. **Cache key completeness.** If a writer reads any input not covered by `contentEtag` — a
   registry value, a settings key — the cache serves stale output. Mitigation: `canonicalJson`
   includes the resolved `ReflowLimits` and the registry entry's `version`, and `--no-cache`
   exists. A stale export is regenerable, so the blast radius is a confusing file, not data loss.
7. **Firefox < 125 and small-icu Node.** Handled by `hasDictionarySegmentation` + the per-script
   fallback, but the Thai/Khmer/Lao degradation (one cue per segment) is genuinely bad output. The
   Docker image must be verified full-ICU at build time — add it to `thibi doctor`.

## Definition of done

- [ ] `packages/core/package.json` has an empty `dependencies` and no `node:` imports anywhere in
      `src`; both are asserted in CI.
- [ ] `resolveLayer` is the only text-selection function in the repo; `displayText` does not exist.
- [ ] `DEFAULT_FALLBACKS.translated` is `[]` and `onMissing` defaults to `error`.
- [ ] `formatTimestamp(59_999.6)` returns `00:01:00,000`, asserted in a named regression test.
- [ ] `reflow` never loses a character (property test over 500 random inputs, in CI).
- [ ] `has_words = false` produces cues for every fixture language, all marked `isEstimated`, and
      the estimation is visible in `json`, `vtt`, `md`, `docx` and the CLI's stderr.
- [ ] Thai, Khmer, Lao and Burmese fixtures break only at ICU token boundaries; the small-icu
      stub test proves the fallback path and its warning.
- [ ] `ps-latin-acronym` renders correctly in VLC and a browser with `--bidi isolate`, and visibly
      wrong with `--bidi none`.
- [ ] All 8 formats produced from one real run; SRT and VTT parse under `ffmpeg -v error`.
- [ ] Bilingual SRT stacks source over translation in one cue, secondary lines marked estimated.
- [ ] A `speaker_purity 0.42` segment splits into two correctly-timed sub-segments on the verbatim
      layer, and does **not** split on the translated layer.
- [ ] DOCX for Pashto has `w:bidi` paragraphs, `w:rtl` runs, and LTR timecode runs.
- [ ] JSON export contains provider, model, prompt id and version, and per-pass token counts.
- [ ] Second identical export is a cache hit; changing any option or editing a segment misses.
- [ ] `thibi export <run> --format srt --layer translated --lang en --out file` works end to end
      and exits 3 (not 0) when a translation is missing and `--on-missing error`.

