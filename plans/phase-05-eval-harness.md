# Phase 5 — FLEURS eval harness

## Goal

At the end of this phase `packages/eval` exists and `thibi eval asr | cleanup | translate` run
end to end. They produce `results/tiers.json` — which `packages/languages` imports at build
time and `/settings/languages` renders directly — plus a dated ASR report and a dated LLM
report. Metrics live in `packages/core/src/metrics` so the editor and the harness score
identically, and are asserted against frozen `jiwer`/`sacrebleu` parity fixtures in CI. The
phase sits here because it needs at least two providers to be worth running (Phases 1–4) and
because Phase 6 must not ship a prompt the harness hasn't scored. This is the machinery that
converts "the API returned 200" into "we measured it" — finding 2 of the three treated as
requirements.

## Prerequisites

| Needs | From | Why |
|---|---|---|
| `packages/languages` registry with `fleurs.config`, `script`, `text.*` | Phase 0 | Drives normalization, script integrity, WER nullability |
| `EngineContext`, `TranscriptionProvider`, Google adapter | Phase 1 | The harness calls providers through the same interface the app does |
| `whisper-http` / Groq / faster-whisper adapters | Phase 4 | Cross-provider tiering; the Groq romanization case is the script-integrity test |
| `packages/engine/src/llm/prompts/*` builders | Phase 6 (partial) | The cleanup/translate evals import the **real** prompt builders. Land stub builders in Phase 5 and the real prompts in Phase 6 — never a copy (see §5.10) |
| Node 22 (`Intl.Segmenter`, `Readable.fromWeb`, native `fetch`) | — | Grapheme CER and the ranged-tarball stream |
| Python 3 + pinned `jiwer`/`sacrebleu` — dev machine only, never CI | — | One-time parity fixture generation |

Dependency direction: **`engine ← eval`**. The overview's chain
(`core ← languages ← db ← engine ← {web, cli, worker}`) gains `eval` after `engine`, deliberately,
so the harness scores the production prompt objects rather than a transcription of them.

## Deliverables

| Path | Purpose |
|---|---|
**The metrics layer is built and merged** — everything from `levenshtein.ts` to
`parity.json` below, on branch `phase-5/metrics`, 2026-08-12. The `packages/eval` half is
not started. Amendments 54–59 in [`00-overview.md`](./00-overview.md) record what this
document got wrong about it and are folded in inline below.

| `packages/core/src/metrics/levenshtein.ts` | **Built.** Two-row DP edit distance over a unit array |
| `packages/core/src/metrics/cer.ts` | **Built.** Codepoint and grapheme CER; corpus CER as ratio-of-sums |
| `packages/core/src/metrics/wer.ts` | **Built.** WER, returning `null` for non-word-delimited scripts |
| `packages/core/src/metrics/chrf.ts` | **Built.** chrF2 ported from sacrebleu 2.6.0's source; per-order stats + corpus aggregation |
| `packages/core/src/metrics/normalize.ts` | **Built.** `normalizeForScoring` — the eight scoring rules |
| `packages/core/src/metrics/script-integrity.ts` | **Built** — a rename of Phase 4a's `metrics/script.ts`, not a new module. See amendment 54 |
| `packages/core/src/metrics/bootstrap.ts` | **Built.** Seeded percentile bootstrap over per-clip statistics |
| `packages/core/src/metrics/index.ts` | **Built.** The metrics barrel, re-exported by `@thibi/core`'s root; nothing deep-imports a metric module |
| `packages/core/src/metrics/__fixtures__/parity.json` | **Built.** Frozen `jiwer` 4.0.0 / `sacrebleu` 2.6.0 expectations, 19 sentence cases plus a corpus block, asserted in CI |
| `packages/core/scripts/gen-parity.py` | **Built.** Regenerates the fixture. Run by hand, never in CI |
| `packages/core/scripts/requirements-dev.txt` | **Built.** Pins `jiwer==4.0.0` and `sacrebleu==2.6.0` |
| `packages/eval/src/fleurs/tsv.ts` | HF tree API → `oid` → cached `dev.tsv`, quote-aware parse |
| `packages/eval/src/fleurs/audio.ts` | Ranged tarball → gunzip → `tar-stream` → N wavs → abort |
| `packages/eval/src/fleurs/manifest.ts` | `--manifest ./local.tsv` loader, same 7 columns, local audio |
| `packages/eval/src/sample.ts` | Deterministic sampling; id dedupe; seeded shuffle for text-only evals |
| `packages/eval/src/cache.ts` | Three cache layers; `sha256(provider\|model\|lang\|clipHash\|paramsHash)` |
| `packages/eval/src/budget.ts` | `--dry-run` estimation and `--budget-usd` enforcement |
| `packages/eval/src/runlog.ts` | `results/runs/<runId>.jsonl` writer and reader |
| `packages/eval/src/asr.ts` | The ASR eval |
| `packages/eval/src/cleanup.ts` | The cleanup eval: arms, `content_delta`, `entity_drift`, the gate |
| `packages/eval/src/translate.ts` | The translation eval: n-way join on `id`, chrF2, the two controls |
| `packages/eval/src/tier.ts` | Thresholds, baseline handling, CI, `humanReview` merge, `tiers.json` |
| `packages/eval/src/report/asr.ts` | Dated ASR markdown, tier changes first |
| `packages/eval/src/report/llm.ts` | Dated LLM markdown in the research doc's table shape |
| `apps/cli/src/commands/eval.ts` | `thibi eval asr\|cleanup\|translate\|report\|init-manifest` |
| `results/human-review/<code>.json` | Committed human sign-off blocks; the only route to `verified` |
| `.github/workflows/eval.yml` | CI: parity assertions + `thibi eval cleanup --gate` |
| `packages/languages/src/tiers.ts` | Build-time import of `results/tiers.json`, all-experimental fallback |

## Design

### 5.1 What the data actually looks like

Verified against the live repo. Everything here is load-bearing for the code that follows.

| Fact | Value |
|---|---|
| TSV URL | `https://huggingface.co/datasets/google/fleurs/resolve/main/data/<cfg>/dev.tsv` |
| Auth | None |
| Tree API | `https://huggingface.co/api/datasets/google/fleurs/tree/main/data/<cfg>?recursive=true` → `[{type,oid,size,path}]` |
| **`oid` is also the resolve ETag** | `ETag: "15b8e8cc455f214dd11ddb3cfc1ef8298f057eb7"` for `my_mm/dev.tsv`, identical to the tree `oid` |
| Rate limit | `ratelimit-policy: "fixed window";"resolvers";q=3000;w=300` — 3000 resolver hits per 5 min |
| Audio | `data/<cfg>/audio/dev.tar.gz` only. **No per-file URL.** `my_mm` dev is 281 MB |
| Rows API | `Scan size limit exceeded`. Broken for this dataset. Do not plan on it |
| Tar members | `dev/<filename>.wav`, preceded by a `dev/` directory entry |
| Tar order | Lexicographic over random-hash filenames → deterministic, effectively-random, reproducible |
| Split-name trap | The **file** is `dev.tsv`; the HF **config split** is `validation`. Never derive one from the other |

The seven columns, no header:

| # | Field | Example / meaning | Used for |
|---|---|---|---|
| 0 | `id` | `1542` — **shared sentence key across languages** | The n-way join for the translation eval |
| 1 | `filename` | `3332794734215124213.wav` | Tar member `dev/<filename>`; the wav cache key |
| 2 | `raw_transcription` | punctuated, cased | Cleanup **reference**; translation source and reference |
| 3 | `transcription` | same sentence lowercased, punctuation stripped | Cleanup **input**; ASR reference |
| 4 | grapheme string | space-separated units, `|` at word boundaries | Unused in v1 — see risks; it is a free word-boundary reference for Burmese |
| 5 | `num_samples` | `305280` — ÷ 16000 = seconds (16 kHz mono) | **Dry-run cost estimation with zero audio downloaded** |
| 6 | `gender` | `MALE` / `FEMALE` | Sample-composition reporting |

Two traps in the file format itself:

1. **Multiple rows share an `id`.** Different speakers reading the same sentence. Dedupe before
   sampling or a 30-clip sample can contain 30 renderings of 11 sentences.
2. **It is tab-delimited but CSV-quoted.** Row 1 of `my_mm/dev.tsv` wraps `raw_transcription`
   in `"` with inner quotes doubled (`""ကိုရီးယား…""`). `split('\t')` leaves stray quote
   characters in the reference string and silently corrupts every CER computed against it.
   Parse properly.

### 5.2 `tsv.ts` — fetch and cache keyed by blob oid

```ts
// packages/eval/src/fleurs/tsv.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HF = 'https://huggingface.co';
const REPO = 'datasets/google/fleurs';

export type Split = 'dev' | 'test' | 'train';

export interface FleursRow {
  id: number;          // 0 — SHARED SENTENCE KEY ACROSS LANGUAGES
  filename: string;    // 1 — tar member is `<split>/<filename>`
  raw: string;         // 2 — punctuated, cased
  plain: string;       // 3 — lowercased, unpunctuated
  graphemes: string;   // 4 — space-separated units, '|' at word boundaries
  numSamples: number;  // 5 — ÷ 16000 = seconds
  gender: string;      // 6
}

interface TreeEntry { type: 'file' | 'directory'; oid: string; size: number; path: string }

/**
 * One tree call covers every file in the config, and returns `size` as well as `oid`,
 * which is what the budget estimator wants for the tarball. `oid` is also the resolve
 * ETag, so `If-None-Match` is an equivalent path — we prefer the tree because it is one
 * request for the TSV *and* the audio metadata.
 */
export async function configTree(cfg: string): Promise<Map<string, TreeEntry>> {
  const res = await fetch(`${HF}/api/${REPO}/tree/main/data/${cfg}?recursive=true`);
  if (res.status === 404) throw new NoEvalSetError(cfg);
  if (!res.ok) throw new Error(`FLEURS tree ${cfg}: HTTP ${res.status}`);
  const entries = (await res.json()) as TreeEntry[];
  return new Map(entries.map((e) => [e.path, e]));
}

export class NoEvalSetError extends Error {
  constructor(readonly cfg: string) { super(`no FLEURS config '${cfg}'`); }
}

/**
 * The oid goes in the *filename*, not in a sidecar metadata file. A changed oid is then a
 * plain cache miss with no conditional request at all, revalidation costs one tree call for
 * the whole config, and stale files are garbage-collectable by pattern.
 */
export async function loadTsv(
  cacheDir: string, cfg: string, split: Split = 'dev',
): Promise<{ rows: FleursRow[]; oid: string }> {
  const tree = await configTree(cfg);
  const entry = tree.get(`data/${cfg}/${split}.tsv`);
  if (!entry) throw new NoEvalSetError(cfg);

  const path = join(cacheDir, 'fleurs', cfg, `${split}.${entry.oid}.tsv`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    const res = await fetch(`${HF}/${REPO}/resolve/main/data/${cfg}/${split}.tsv`);
    if (!res.ok) throw new Error(`FLEURS ${cfg}/${split}.tsv: HTTP ${res.status}`);
    text = await res.text();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  }
  return { rows: parseTsv(text), oid: entry.oid };
}

/** Tab-delimited but CSV-quoted. See §5.1 trap 2. */
export function parseTsv(text: string): FleursRow[] {
  const records: string[][] = [];
  let field = '', record: string[] = [], quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === '\t') { record.push(field); field = ''; continue; }
    if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || record.length > 0) { record.push(field); records.push(record); }

  return records
    .filter((r) => r.length >= 7 && r[0] !== '')
    .map((r) => ({
      id: Number(r[0]),
      filename: r[1],
      raw: r[2],
      plain: r[3],
      graphemes: r[4],
      numSamples: Number(r[5]) || 0,
      gender: r[6],
    }));
}
```

### 5.3 `audio.ts` — the ranged-tarball stream

There is no per-file audio URL and the rows API is broken, so this is the only cheap route to
audio. Request a byte prefix of the 281 MB tarball, gunzip it, walk it with `tar-stream`, take
N complete entries, abort the request. ~730 KB compressed per clip measured; 6 MB yielded 7
complete wavs.

```ts
// packages/eval/src/fleurs/audio.ts
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import extract from 'tar-stream';

const HF = 'https://huggingface.co';
const REPO = 'datasets/google/fleurs';
const BYTES_PER_CLIP = 900_000;   // measured ~730 KB compressed; margin for long clips
const HEADROOM = 1_000_000;

export interface Clip { filename: string; bytes: Buffer }

export async function fetchClips(cfg: string, split: string, n: number): Promise<Clip[]> {
  let limit = n * BYTES_PER_CLIP + HEADROOM;
  for (let attempt = 0; attempt < 4; attempt++) {
    const clips = await streamPrefix(cfg, split, n, limit);
    if (clips.length >= n) return clips.slice(0, n);
    limit *= 2;   // a config of unusually long clips; double and retry
  }
  throw new Error(`FLEURS ${cfg}/${split}: could not reach ${n} clips within ${limit} bytes`);
}

async function streamPrefix(cfg: string, split: string, n: number, limit: number): Promise<Clip[]> {
  const url = `${HF}/${REPO}/resolve/main/data/${cfg}/audio/${split}.tar.gz`;
  const ac = new AbortController();
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${limit - 1}` },
    signal: ac.signal,
    redirect: 'follow',
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`FLEURS audio ${cfg}/${split}: HTTP ${res.status}`);
  }

  const out: Clip[] = [];
  const source = Readable.fromWeb(res.body as any);
  const gunzip = createGunzip();
  const tar = extract();

  const done = new Promise<void>((resolve, reject) => {
    // A ranged read cuts the gzip member mid-stream, so "unexpected end of file" is the
    // NORMAL termination path here. It is only a failure if we are still short of N.
    const settle = (err: unknown) => (out.length >= n ? resolve() : reject(err));
    source.on('error', settle);
    gunzip.on('error', settle);
    tar.on('error', settle);
    tar.on('finish', () => resolve());

    tar.on('entry', (header, stream, next) => {
      const take = out.length < n && header.type === 'file' && header.name.endsWith('.wav');
      if (!take) {
        // MUST drain a skipped entry or the extractor stalls forever.
        stream.on('end', next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('end', () => {
        out.push({ filename: header.name.split('/').pop()!, bytes: Buffer.concat(chunks) });
        if (out.length >= n) { ac.abort(); resolve(); return; }
        next();
      });
    });
  });

  source.pipe(gunzip).pipe(tar);
  try { await done; } finally { ac.abort(); }
  return out;
}
```

Four things that will bite whoever writes this from scratch:

- `.pipe()` does **not** forward errors. Handlers are needed on all three streams; `ac.abort()`
  surfaces as an `AbortError` on `source`, not on `tar`.
- A skipped entry must be drained (`stream.resume()`), or `tar-stream` never emits the next one.
- Truncated-gzip errors are the success path. Discriminate on `out.length`, not on error type.
- The first entry is the `dev/` directory; `header.type === 'file'` filters it.

**Determinism.** Tar order is lexicographic over random-hash filenames. It correlates with
nothing in the data, so "the first N entries" is a random-but-reproducible sample: the same
`(cfg, split, n)` yields the same clips on every machine, forever, with no seed and no
manifest. Every report states this explicitly, because a reader is entitled to know the sample
was not chosen.

Wavs are cached at `<cacheDir>/wav/<cfg>/<split>/<filename>` — the FLEURS filename is already a
content hash, so the filename *is* the cache key.

Clips join back to the TSV by `filename`. If a tar member has no TSV row (never observed, but
cheap to guard), it is dropped and counted in `sample.unmatched`.

### 5.4 `manifest.ts` — the door for non-FLEURS languages

`--manifest ./local.tsv` takes a hand-built file in **the same 7 columns**, with two relaxations:

| Column | Manifest behaviour |
|---|---|
| `id` | Any integer, unique. Only used for the translation join, so it may be arbitrary |
| `filename` | Resolved against `--audio-dir` (default: the manifest's directory) instead of a tarball |
| `raw` / `plain` | If `plain` is empty it is derived from `raw` by the score normalizer (lowercase + strip punctuation), so a hand-transcriber fills in one column, not two |
| `graphemes` | May be empty |
| `num_samples` | May be `0`; the harness then probes duration with ffprobe and rewrites the file in place |
| `gender` | May be empty |

Everything downstream — sampling, caching, metrics, tiering, reports — is identical. There is no
`if (manifest)` branch past the loader.

`thibi eval init-manifest ./clips/ --config shn_mm > local.tsv` scaffolds the file: ids, filenames
and durations filled, transcription columns blank.

This serves three cases at once:

1. **The five non-FLEURS Google languages** — Sinhala `si-LK`, Basque `eu-ES`, Albanian `sq-AL`,
   Sundanese `su-ID`, Aromanian `rup-BG`. Without a manifest they are a first-class state, not
   an error: `tier: "experimental"`, `reason: "no-eval-set"`, `cer: null`. That is a *different*
   state from measured-and-bad and the picker must render it differently — "not yet measured",
   never "poor quality". `NoEvalSetError` from `configTree` is caught and turned into this row.
2. **Hand-collected clips for unsupported languages.** 30 transcribed Shan or Sgaw Karen clips
   enter the harness unchanged. Since none of Myanmar's ethnic languages exist in any provider,
   the interesting run is
   `thibi eval asr --manifest rakhine.tsv --config rk_mm --provider google --lang my-MM` —
   the research doc's "does `my-MM` partially transcribe Rakhine" question, answered with a CER
   and a bootstrap CI instead of an impression.
3. **Newsroom audio.** FLEURS is read Wikipedia sentences. A partner newsroom's 30 real phone
   interviews scored through the same harness is the only honest read on production quality, and
   the manifest is how those get in.

### 5.5 Metrics in TypeScript

**Why not `jiwer`.** Three reasons, in order of weight:

1. **jiwer's WER tokenizer is whitespace-based**, which is precisely wrong for Burmese, Khmer,
   Lao and Thai. On scriptio-continua text it produces a per-sentence WER of 0 or 1 and a corpus
   WER that means nothing. We report `null` instead; jiwer cannot.
2. **The app needs the same numbers.** Run comparison and confidence review in the editor score
   text live in the browser. A Python metric would mean a second implementation, and two
   implementations of the *normalizer* — the actual source of variance — drift silently until
   the report and the UI disagree about the same run.
3. It would make the Python sidecar mandatory for the harness. It is optional everywhere else.

The cost of not using it is one cross-check, done once and frozen (§5.7).

```ts
// packages/core/src/metrics/levenshtein.ts
/** Two-row DP. Symmetric, so we keep the shorter sequence on the row axis: O(min) memory. */
export function levenshtein(src: readonly string[], dst: readonly string[]): number {
  let a = src, b = dst;
  if (a.length < b.length) { const t = a; a = b; b = t; }
  const m = b.length;
  if (m === 0) return a.length;

  const prev = new Uint32Array(m + 1);
  const cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ai === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    prev.set(cur);
  }
  return prev[m];
}
```

```ts
// packages/core/src/metrics/cer.ts
export type Units = 'codepoint' | 'grapheme';

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function units(s: string, mode: Units): string[] {
  return mode === 'codepoint'
    ? Array.from(s)
    : Array.from(graphemeSegmenter.segment(s), (x) => x.segment);
}

export interface EditStats { edits: number; refLen: number }

export function editStats(hyp: string, ref: string, mode: Units = 'codepoint'): EditStats {
  const h = units(hyp, mode), r = units(ref, mode);
  return { edits: levenshtein(h, r), refLen: r.length };
}

/** Sentence CER. `null` — not 1 — when the reference is empty; that is undefined, not perfect error. */
export function cer(hyp: string, ref: string, mode: Units = 'codepoint'): number | null {
  const { edits, refLen } = editStats(hyp, ref, mode);
  if (refLen === 0) return units(hyp, mode).length === 0 ? 0 : null;
  return edits / refLen;
}

/**
 * Corpus CER is the ratio of sums, never the mean of sentence CERs. FLEURS clip lengths vary
 * by 4×; averaging sentence rates over-weights short clips and shifts the number materially.
 * This is also the jiwer/sacrebleu convention, which the parity fixture depends on.
 */
export function corpusCer(stats: readonly EditStats[]): number | null {
  let e = 0, r = 0;
  for (const s of stats) { e += s.edits; r += s.refLen; }
  return r === 0 ? null : e / r;
}
```

```ts
// packages/core/src/metrics/wer.ts
/**
 * Rule 8. A whitespace tokenizer on scriptio-continua text is not "approximate WER", it is a
 * different quantity, and once it is printed in a table nobody remembers that. Return null.
 * `werKind` travels with the number so a consumer can never mistake an ICU-segmented WER for a
 * comparable one.
 */
export type WerKind = 'spaces' | 'icu' | null;

export function wer(hyp: string, ref: string, rules: SegmentationRules): WerResult;
```

**Corrected against the built file (amendment 59).** Three things this sketch had wrong:

- The vocabulary is `'spaces'`, not `'space'` — that is how the registry spells
  `text.wordSegmentation`, and a profile is meant to be a projection of the registry with no
  translation step to get wrong. Same for `WerKind`.
- It takes the existing `SegmentationRules` shape from `timing/interpolate.ts` (`code` +
  `wordSegmentation`) rather than a bare enum, so word segmentation for timings and word
  segmentation for scoring cannot become two different opinions.
- ICU segmentation runs in the **language's own locale**, not `'und'`: Thai, Khmer and Lao
  word breaking is dictionary-driven and locale-sensitive. A small-ICU Node build — which has
  `Intl.Segmenter` but breaks Thai into runs of characters — gets the same refusal as
  `'none'` rather than a plausible-looking number.

`werStats` and `corpusWer` accompany it, for the same reason `editStats` accompanies `cer`:
the corpus estimator is the ratio of sums and a rate cannot be summed back into one.

```ts
// packages/core/src/metrics/chrf.ts
// Port of sacrebleu CHRF with char_order=6, word_order=0, beta=2, whitespace removed —
// i.e. plain chrF2, the sacrebleu default, which is what the research doc's numbers are.
const EPS = 1e-16;

export interface ChrfStats { hyp: number; ref: number; match: number }

function ngrams(units: readonly string[], n: number, sep = ''): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + n <= units.length; i++) {
    const g = units.slice(i, i + n).join(sep);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function overlap(h: Map<string, number>, r: Map<string, number>): ChrfStats {
  let hyp = 0, ref = 0, match = 0;
  for (const v of h.values()) hyp += v;
  for (const v of r.values()) ref += v;
  for (const [k, v] of h) { const o = r.get(k); if (o) match += Math.min(v, o); }
  // CORRECTED, amendment 58. sacrebleu 2.6.0's `_get_match_statistics` is
  // `hyp_count if ref_ngrams else 0`: at any order where the reference has no n-grams at
  // all, the hypothesis count is reported as zero and — via the effective-order rule — the
  // order drops out of the average entirely. Returning `hyp` unconditionally, as this
  // sketch did, scores a short hypothesis against a long reference differently from
  // sacrebleu. `chrf-asymmetric-short` in the parity fixture is the case that catches it.
  return { hyp: ref === 0 ? 0 : hyp, ref, match };
}

/** Per-order statistics for one pair. Codepoints, not UTF-16 units — sacrebleu works on Python str. */
export function chrfStats(hyp: string, ref: string, charOrder = 6, wordOrder = 0): ChrfStats[] {
  const hc = Array.from(hyp.replace(/\s+/gu, ''));   // remove_whitespace=True
  const rc = Array.from(ref.replace(/\s+/gu, ''));
  const hw = hyp.split(/\s+/u).filter(Boolean);
  const rw = ref.split(/\s+/u).filter(Boolean);
  const out: ChrfStats[] = [];
  for (let n = 1; n <= charOrder; n++) out.push(overlap(ngrams(hc, n), ngrams(rc, n)));
  for (let n = 1; n <= wordOrder; n++) out.push(overlap(ngrams(hw, n, ' '), ngrams(rw, n, ' ')));
  return out;
}

/** sacrebleu `_compute_f_score`: arithmetic mean of per-order P and R over *effective* orders, then F-beta. */
export function chrfScore(stats: readonly ChrfStats[], beta = 2): number {
  const factor = beta * beta;
  let avgPrec = 0, avgRec = 0, effective = 0;
  for (const s of stats) {
    const prec = s.hyp > 0 ? s.match / s.hyp : EPS;
    const rec = s.ref > 0 ? s.match / s.ref : EPS;
    if (s.hyp > 0 && s.ref > 0) { avgPrec += prec; avgRec += rec; effective++; }
  }
  if (effective === 0) return 0;
  avgPrec /= effective; avgRec /= effective;
  if (avgPrec + avgRec === 0) return 0;
  return (100 * (1 + factor) * avgPrec * avgRec) / (factor * avgPrec + avgRec);
}

/** Corpus chrF2: aggregate statistics first, score once. Never the mean of sentence scores. */
export function corpusChrf2(pairs: ReadonlyArray<{ hyp: string; ref: string }>): number {
  const total: ChrfStats[] = [];
  for (const { hyp, ref } of pairs) {
    const s = chrfStats(hyp, ref);
    for (let i = 0; i < s.length; i++) {
      total[i] ??= { hyp: 0, ref: 0, match: 0 };
      total[i].hyp += s[i].hyp; total[i].ref += s[i].ref; total[i].match += s[i].match;
    }
  }
  return chrfScore(total);
}
```

### 5.6 Normalization for scoring

Get this wrong and every number in the report is garbage. All eight rules, and where each lands:

| # | Rule | Where |
|---|---|---|
| 1 | NFC first, always | `normalizeForScoring` step 1 |
| 2 | Zawgyi detect + convert before scoring | step 2, then **re-NFC** — conversion is not NFC-stable |
| 3 | Strip all whitespace for Mymr/Khmr/Laoo/Thai; tier on `cer_nospace` | step 7, via `profile.stripWhitespace` |
| 4 | Punctuation stripped for ASR, **kept** for cleanup | step 6, via `opts.keepPunctuation` |
| 5 | Digit-shape normalization | step 4, via `profile.nativeDigits` — a **list** of 10-character sets |
| 6 | ZWSP always; ZWNJ/ZWJ per script (semantic in Sinhala and Devanagari) | step 3, via `profile.zeroWidth`, the registry's three-way record |
| 7 | Codepoint **and** grapheme CER reported; tier on codepoint | metric layer, `units()` |
| 8 | WER `null` for non-word-delimited scripts | metric layer, `wer()` |

**Corrections from building it (amendments 55–57).** The `ScoreProfile` sketched below is
not the shape the registry can produce, and the code block that follows is superseded by
`packages/core/src/metrics/normalize.ts`:

- **`nativeDigitBase?: number` cannot express Arabic script**, which has two native digit
  sets — Arabic-Indic U+0660 and Extended Arabic-Indic U+06F0 — either of which a provider
  may return against the same reference. One base folds one set and leaves the other wrong at
  every digit. The profile takes `scriptEntry.digits.native` unchanged.
- **Rule 5 folds unconditionally**, ignoring `digits.foldToLatin`. That flag is `false` for
  every script in the tree; it is a rendering policy about what a user should see, and
  honouring it here would have meant rule 5 never fired at all. Scoring is symmetric, so
  folding both sides cannot lose a distinction that matters.
- **`zeroWidth: 'strip-all' | 'strip-zwsp' | 'keep'` collapses a per-character policy** the
  registry already distinguishes and has to: ZWJ is semantic in Sinhala and ZWNJ in
  Devanagari, so one enum cannot both strip Burmese's and keep Sinhala's.
- **`letterlikePunct` has no registry field to come from.** `text.punctuation` carries
  `sentenceEnders` and `quotes` and nothing else, so Somali's glottal apostrophe and Hausa's
  compounding hyphen are stripped as punctuation today and both languages' WER is overstated
  at every occurrence. The mechanism is built and tested; adding `text.letterlikePunct` to
  the registry is open work and belongs with `toScoreProfile`.
- **Zawgyi is injected, not imported.** `is-zawgyi` and `rabbit-node` are not in the tree,
  `@thibi/core` has zero runtime dependencies and ships into a React client bundle, so
  `ScoreOptions.convertZawgyi` is the seam and `@thibi/languages` is where the real detector
  and converter belong. A profile with `zawgyiApplies: true` and no converter **throws** —
  silently skipping conversion reports a correct Burmese transcript at ~100% error, which
  reads as a provider failure, and nothing else in the suite would catch it.
- **Rule 7 stands, but its wording must not.** A grapheme cluster is not a Burmese syllable:
  `မြန်မာ` is two syllables and four extended grapheme clusters, and `တော်` splits as `တေ` +
  `ာ်` (measured, Node 22.18 / ICU 77.1). The grapheme column is well-defined and earns its
  place on Yoruba diacritics; it is not "what a human would count by hand" for Mymr and the
  report may not say so. Amendment 57.

```ts
// packages/core/src/metrics/normalize.ts
import isZawgyi from 'is-zawgyi';
import Rabbit from 'rabbit-node';

export interface ScoreProfile {
  script: string;                                   // 'Mymr'
  blocks: ReadonlyArray<readonly [number, number]>; // [[0x1000,0x109F],[0xAA60,0xAA7F]]
  wordSegmentation: 'space' | 'none' | 'icu';
  zawgyiApplies: boolean;
  zeroWidth: 'strip-all' | 'strip-zwsp' | 'keep';
  nativeDigitBase?: number;         // 0x1040 Mymr, 0x0660 Arab, 0x17E0 Khmr, 0x0ED0 Laoo
  stripWhitespace: boolean;         // Mymr, Khmr, Laoo, Thai
  letterlikePunct: readonly string[]; // "'" Somali glottal, '-' Hausa compounds, 'ʼ' Uzbek
}

export interface ScoreOptions {
  keepPunctuation: boolean;   // false for the ASR metric, TRUE for cleanup
  caseFold: boolean;          // true for the ASR metric, FALSE for cleanup
}

// ZWSP, ZWNJ, ZWJ, and the bidi formatting characters. Directional marks must always go —
// an RTL provider that emits RLM and a reference that doesn't are not different transcripts.
const ZWSP = /​/gu;
const ZWNJ_ZWJ = /[‌‍]/gu;
const BIDI_FMT = /[‎‏؜‪-‮⁦-⁩]/gu;

export function normalizeForScoring(input: string, p: ScoreProfile, o: ScoreOptions): string {
  // 1. NFC first, always.
  let t = input.normalize('NFC');

  // 2. Zawgyi before anything inspects codepoints, or a Zawgyi-emitting provider scores ~100%
  //    error for what is a rendering issue. Conversion is neither length-preserving nor
  //    NFC-stable, so re-normalize. (Scoring may convert whole-string; the *runtime* pipeline
  //    must convert per word — see 00-overview normalize-text.)
  if (p.zawgyiApplies && t.length > 0 && isZawgyi(t)) t = Rabbit.zg2uni(t).normalize('NFC');

  // 6. Zero-width and bidi formatting.
  t = t.replace(ZWSP, '').replace(BIDI_FMT, '');
  if (p.zeroWidth === 'strip-all') t = t.replace(ZWNJ_ZWJ, '');

  // 5. Digit shapes → ASCII, so ၁၉၉၅ and 1995 are the same number.
  if (p.nativeDigitBase !== undefined) t = foldDigits(t, p.nativeDigitBase);

  // Case. Explicit, never derived: the ASR metric folds because FLEURS `transcription` is
  // lowercased; the cleanup metric must NOT, because capitalisation is the thing being scored.
  if (o.caseFold) t = t.toLowerCase();

  // 4. Punctuation.
  if (!o.keepPunctuation) t = stripPunct(t, p.letterlikePunct);

  // 3 + whitespace collapse. Last, so a removed punctuation mark leaves no double space.
  t = p.stripWhitespace ? t.replace(/\s+/gu, '') : t.replace(/\s+/gu, ' ').trim();
  return t;
}

function foldDigits(t: string, base: number): string {
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    out += c >= base && c <= base + 9 ? String(c - base) : ch;
  }
  return out;
}

/**
 * `\p{P}` and `\p{S}`, minus the characters a given orthography uses as letters. Somali's
 * apostrophe and Hausa's hyphen are not punctuation; stripping them merges words and inflates
 * every WER for that language.
 */
function stripPunct(t: string, keep: readonly string[]): string {
  const keepSet = new Set(keep);
  let out = '';
  for (const ch of t) {
    if (keepSet.has(ch)) { out += ch; continue; }
    if (/[\p{P}\p{S}]/u.test(ch)) continue;
    out += ch;
  }
  return out;
}
```

`ScoreProfile` is derived from the registry by `toScoreProfile(resolveLanguage(code))` in
`packages/languages`. The harness never hand-writes one, and neither does the editor — one
function, two callers, no drift.

### 5.7 Parity against `jiwer` and `sacrebleu`

Generated once by hand, committed, asserted forever.

```
packages/core/scripts/requirements-dev.txt   jiwer==<pinned>  sacrebleu==<pinned>
packages/core/scripts/gen-parity.py          reads cases.json, writes __fixtures__/parity.json
```

**Generated for real on 2026-08-12** under CPython 3.11.8 with **jiwer 4.0.0** and
**sacrebleu 2.6.0** (signature `nrefs:1|case:mixed|eff:yes|nc:6|nw:0|space:no`). The cases
are embedded in `gen-parity.py` rather than read from a separate `cases.json`, which is what
the deliverables table asks for — it lists three files, and a fourth would be one more thing
to keep in step.

```json
{
  "generatedAt": "2026-08-12",
  "jiwer": "4.0.0",
  "sacrebleu": "2.6.0",
  "cases": [
    { "id": "ascii-basic", "hyp": "the cat sat", "ref": "the cat sit",
      "divergence": null,
      "sacrebleu": { "chrf2": 68.66402116402116, "chrfPlusPlus": 66.08134920634922 },
      "jiwer": { "cer": 0.09090909090909091, "wer": 0.3333333333333333,
                 "refChars": 11, "refWords": 3, "charEdits": 1, "wordEdits": 1 } }
  ],
  "corpus": { "pairs": [...], "jiwer": {...}, "sacrebleu": {...} }
}
```

Two additions to what this section originally specified, both amendment 58:

- **Counts, not only rates.** A rate can match for the wrong reason — compensating errors in
  the numerator and the denominator — which is exactly what a parity fixture is for.
- **A `corpus` block.** `corpusCer`, `corpusWer` and `corpusChrf2` are ratio-of-sums and
  aggregate-then-score. A drift to the mean of the sentence values would pass every
  sentence-level assertion, look harmless, and move every language in the tier table. Four
  committed pairs, with jiwer's and sacrebleu's corpus answers, are frozen alongside.

The fixture stores **raw, un-normalized** strings and the expectations of the Python libraries
on those exact strings. Our normalizer is *not* in the loop — it is tested separately, by
snapshot. Mixing the two would let a normalizer bug hide inside a metric assertion.

Required cases, minimum:

| Case id | Why |
|---|---|
| `ascii-basic` | Sanity |
| `identical` | 0.0, both metrics |
| `empty-hyp` | CER 1.0, chrF2 0.0 |
| `empty-ref` | Our `null`; asserted as our documented divergence, not against jiwer |
| `hyp-longer` | Insertions dominate |
| `single-char` | Off-by-one in the DP seed row |
| `burmese-spaced` / `burmese-unspaced` | The scriptio-continua pair |
| `burmese-zawgyi` | Normalizer test only — excluded from the fixture entirely; it lives in `normalize.test.ts` |
| `burmese-mangled` | **Added.** The Groq `language=my` output from 2026-07-30: Myanmar script, not Burmese words. Script integrity scores it 1.00 and only CER can call it wrong, so the number that makes that argument is frozen |
| `chrf-asymmetric-short` | **Added.** A one-character hypothesis against a long reference — the `hyp_count if ref_ngrams else 0` branch |
| `punct-heavy` | **Added.** Exercises chrF++'s punctuation-splitting word tokenizer, which is reproduced faithfully so an unused path cannot rot |
| `padded-whitespace` | **Added.** Documented divergence: jiwer applies `Strip()` first, we do not |
| `tab-separated` | **Added.** Documented divergence: jiwer splits words on `' '` alone, so `the\tcat` is one token to it and two to us — WER 1.0 against our 1/3 |
| `amharic` | Ethiopic, BMP, own punctuation (`።` `፣`) |
| `pashto-with-latin-acronym` | RTL with an embedded LTR run |
| `combining-marks` | Yoruba `ọ́` — codepoint vs grapheme CER must differ here |
| `astral-emoji` | Catches any accidental `.length` / `charAt` usage |
| `chrf-short` / `chrf-long` | chrF2's effective-order logic when n-grams run out |

Tolerances: CER and WER are exact rationals — assert to `1e-12`. chrF2 accumulates floats in a
different order in Python; assert to `1e-6` and state the reason in the test file.

CI runs only the TS assertions. Python is never installed in CI. Regenerating is a deliberate
act with a diff in the PR.

### 5.8 Sampling, caching and cost control

**Sampling.**

| Eval | Strategy |
|---|---|
| ASR | Tar order. Pull N entries from the byte prefix, join to the TSV by `filename`. Deterministic with no seed; the report says so |
| cleanup / translate | No audio. Dedupe rows by `id`, sort by `id`, then `mulberry32(seed)` shuffle and take N. `--seed` defaults to `1` |

`id` dedupe keeps the first row per id in file order. Without it a 30-clip sample can contain 30
readings of 11 sentences and the CI is nonsense.

**Three cache layers.**

| Layer | Key | Path |
|---|---|---|
| TSV | HF blob `oid` | `<cacheDir>/fleurs/<cfg>/<split>.<oid>.tsv` |
| Audio | FLEURS filename (already a content hash) | `<cacheDir>/wav/<cfg>/<split>/<filename>` |
| Every provider and LLM response | `sha256(provider\|model\|lang\|clipHash\|paramsHash)` | `<cacheDir>/resp/<key>.json` |

```ts
// packages/eval/src/cache.ts
export function responseKey(i: {
  provider: string; model: string; lang: string; clipHash: string; paramsHash: string;
}): string {
  return createHash('sha256')
    .update([i.provider, i.model, i.lang, i.clipHash, i.paramsHash].join('|'))
    .digest('hex');
}

/** Audio: sha256 of the wav bytes, so a re-download or a manifest copy is still a hit. */
export const clipHashOf = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
/** Text (LLM evals): sha256 of the exact input string. */
export const textHashOf = (s: string) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * paramsHash covers everything that could change the response and nothing that couldn't.
 * For LLM calls it MUST include promptId + promptVersion — that is what makes a bumped prompt
 * a genuine cache miss, and it is the single line that stops the CI gate passing on stale
 * numbers from the previous prompt.
 */
export const paramsHashOf = (o: unknown) =>
  createHash('sha256').update(canonicalJson(o), 'utf8').digest('hex');
```

`--no-cache` bypasses reads but still writes. `--cache-dir` is read by the **CLI** and passed
into the harness; the engine never reads `process.env`.

**Dry run.** Costs nothing and downloads nothing: `num_samples ÷ 16000` gives exact audio
seconds straight from the TSV.

```
$ thibi eval asr --languages ha-NG,jv-ID,yo-NG --n 30 --dry-run
language  clips   audio    provider/model    est. usd   cached
ha-NG     30      9m 42s   google/chirp_2    $0.155     0
jv-ID     30     10m 05s   google/chirp_2    $0.161     30  (free)
yo-NG     30      9m 18s   google/chirp_2    $0.149     0
────────────────────────────────────────────────────────────
TOTAL     90     29m 05s                     $0.304 to spend, $0.161 avoided by cache
```

**Budget.** `--budget-usd 25` keeps a running ledger, checks *before* each billable call, and on
exhaustion flushes the runlog, writes a partial report and exits `3`. A partial run never writes
`tiers.json`.

**Concurrency.** `p-limit` at `min(--concurrency, provider.capabilities().limits.maxConcurrentRequests)`,
plus a token bucket for provider RPM and a second for LLM tokens-per-minute. Both are in-process
here — the Postgres-backed bucket from Phase 9 is for the worker, and the harness is a
single process by design.

**The runlog.** `results/runs/<runId>.jsonl`, append-only, one JSON object per line, written as
work completes so a crashed run is still analysable.

```jsonl
{"t":"run","runId":"2026-08-09T10-04-11Z-a7f3","argv":["eval","asr","--languages","ha-NG"],"engineVersion":"0.5.0","seed":1,"startedAt":"…"}
{"t":"clip","lang":"ha-NG","id":1615,"filename":"3332…wav","clipHash":"sha256:…","durationMs":19080,"gender":"FEMALE"}
{"t":"asr","lang":"ha-NG","id":1615,"provider":"google","model":"chirp_2","cacheHit":false,"latencyMs":2210,"usd":0.0051,"hyp":"…","rawKey":"resp/9c1e…json"}
{"t":"score","lang":"ha-NG","id":1615,"edits":31,"refLen":168,"cer":0.1845,"cerGrapheme":0.1802,"wer":0.402,"werKind":"space","scriptIntegrity":0.998}
{"t":"llm","eval":"cleanup","lang":"yo-NG","arm":"restraint","promptId":"cleanup.restraint","promptVersion":3,"model":"…","in":210,"out":198,"usd":0.0011,"cacheHit":true}
{"t":"budget","spentUsd":4.12,"limitUsd":25}
{"t":"summary","lang":"ha-NG","n":30,"cer":0.184,"ci":[0.151,0.221],"scriptIntegrity":0.998,"tier":"beta"}
```

`thibi eval report --run <runId>` regenerates both reports **and** `tiers.json` from this file
alone. Changing a threshold, a report layout or the tier logic costs zero API calls — which is
the property that makes it safe to argue about thresholds.

### 5.9 Tiering

```ts
// packages/eval/src/tier.ts
export const THRESHOLDS = {
  verifiedCer: 0.20,
  verifiedRatio: 1.15,
  verifiedMinN: 30,
  betaCer: 0.35,
  betaRatio: 2.0,
  unsupportedCer: 0.60,
  minScriptIntegrity: 0.80,
} as const;
```

```
verified      ratio ≤ 1.15 AND cer ≤ 0.20 AND n ≥ 30
              AND the 95% bootstrap CI is clear of the beta line
              AND humanReview present
beta          ratio ≤ 2.0 AND cer ≤ 0.35
experimental  correct script, worse
unsupported   code rejected, OR script integrity < 0.8, OR cer > 0.6
```

Checks run in that order, `unsupported` first: a language with CER 0.1 and script integrity 0.3
is unsupported, not verified. The order is the whole point of the integrity check.

**"Clear of the beta line" is the CI upper bound, not the point estimate.** The beta line is the
boundary above which a language becomes beta — i.e. the verified thresholds themselves. So:
`ciHi ≤ 0.20 && ciHi / baseline ≤ 1.15`. Stated explicitly because it is the one ambiguous
phrase in the spec, and because at n=30 the point estimate clears the line long before the
interval does.

**The Burmese baseline is measured every run, never hardcoded.**

```ts
const BASELINE_CODE = 'my-MM';
```

- If `my-MM` is not in `--languages`, the harness adds it and prints one line saying so. Thirty
  extra clips is ~$0.16 and it is not optional.
- The baseline must be measured with the **same provider, model and params** as the languages it
  calibrates. A run mixing `google/chirp_2` languages against an OpenAI baseline is rejected.
- If the baseline's own `cer_nospace` has moved more than 25% from the previous run's baseline,
  the run is marked `baselineSuspect: true`, the reports render a banner, and **`tiers.json` is
  not written.** A drifting baseline silently re-tiers 107 languages in one commit; catching it
  is worth a hard stop.
- `ratio = cer_nospace(lang) / cer_nospace(my-MM)`.

```ts
// packages/core/src/metrics/script-integrity.ts
/**
 * Fraction of script-bearing characters that fall in the language's expected Unicode blocks.
 * This is what catches the Groq autodetect failure — `ASEAN YAK SOMPHA CHHA KOO…` for Burmese
 * audio scores ~0.0 here while a naive reader might see plausible-looking output. CER catches
 * it too, but only by accident: romanization happens to be far from the reference. Integrity
 * catches it on purpose, and reports *why*.
 *
 * Note the division of labour with CER. Groq `language=my` returns Myanmar-script non-words
 * (`လာက္းကေက် ရိုရ်းသဲ့ထါတ်`): integrity ~1.0, CER ~1.0. Groq autodetect returns romanization:
 * integrity ~0.0, CER also high. You need both metrics; neither alone names both failures.
 */
export function scriptIntegrity(text: string, blocks: ReadonlyArray<readonly [number, number]>): number {
  // SUPERSEDED — see below.
}
```

**This sketch is not what shipped (amendment 54).** Phase 4a had already built the metric as
`packages/core/src/metrics/script.ts`, and Phase 5's contribution is the rename to
`script-integrity.ts` — the filename this table names — and nothing else. The sketch above is
the weaker of the two on four counts, so it is the one that gave way:

- it returns a bare `number` and scores an empty transcript **0**, as though "nothing to
  measure" were a measurement. The built version returns `fraction: number | null`;
- it takes one block list, where the built version takes a script **and its `altScripts`** —
  without which a correct Cyrillic Serbian transcript scores 0 and the harness reports a
  provider failure that did not happen. `sr-RS` is 93% Latin / 7% Cyrillic across the FLEURS
  dev set;
- it reports no stray characters, so a failure prints as `0.02` rather than
  `0.02 (stray: A S E N Y K)` — the difference between a number and a diagnosis;
- it excludes `\p{M}`, dropping combining marks from the denominator, which is most of what a
  Burmese cluster is.

Two implementations of the metric that decides `tier: unsupported` is exactly the drift the
harness cannot afford, so there is one. Its measured Groq cases — romanized output below 0.1,
Myanmar-script non-words at 1.00 — travelled with it unchanged.

Integrity is computed on the **un-normalized** hypothesis, before punctuation stripping and
digit folding, on the concatenation of all clips for the language. `blocks` comes from the
registry: Latin-script languages need Basic Latin + Latin-1 Supplement + Latin Extended-A/B +
Latin Extended Additional (Yoruba's `ọ́`, `ẹ̀`), which is why combining marks are skipped
rather than counted.

```ts
// packages/core/src/metrics/bootstrap.ts
/**
 * Percentile bootstrap over CLIPS, resampling the (edits, refLen) pairs and recomputing the
 * ratio-of-sums each time — the same estimator as the point value. Seeded, so the interval in
 * the report is reproducible from the runlog.
 */
export function bootstrapCi(
  perClip: ReadonlyArray<EditStats>, b = 2000, seed = 1, alpha = 0.05,
): readonly [number, number] | null {
  const n = perClip.length;
  // CORRECTED, amendment 59: `null`, not `[NaN, NaN]`. NaN compares false against every
  // threshold, so a language with no clips would sail straight through `ciHi <= 0.20` and
  // land in the tier table with an interval that prints as `NaN`. Every other metric in this
  // layer answers "undefined" with null.
  if (n === 0) return null;
  const rnd = mulberry32(seed);
  const samples = new Float64Array(b);
  for (let k = 0; k < b; k++) {
    let e = 0, r = 0;
    for (let i = 0; i < n; i++) {
      const p = perClip[(rnd() * n) | 0];
      e += p.edits; r += p.refLen;
    }
    samples[k] = r === 0 ? 0 : e / r;
  }
  samples.sort();
  return [
    samples[Math.floor((alpha / 2) * b)],
    samples[Math.min(b - 1, Math.ceil((1 - alpha / 2) * b) - 1)],
  ] as const;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

**The hard rule: the harness can award `beta` and `experimental`. It can never award
`verified`.** `assignTier` takes `humanReview: HumanReview | null`; with `null` the best it can
return is `beta`, and it records `blockedFromVerifiedBy: ["humanReview"]`. There is no flag, no
env var and no config key that changes this. `verified` is a claim a newsroom will rely on, and
at n=30 the interval is wide enough that no automated rule should be allowed to make it.

Human review lives in `results/human-review/<code>.json`, committed:

```json
{
  "code": "ha-NG",
  "reviewer": "Name <email>",
  "reviewedAt": "2026-08-14",
  "evalRunId": "2026-08-09T10-04-11Z-a7f3",
  "clipsReviewed": 12,
  "verdict": "pass",
  "nativeSpeaker": true,
  "notes": "Two clips lose a clause-final particle. No name errors. Usable for quotation with normal checking."
}
```

`assignTier` accepts it only if `evalRunId` matches the *current* run — a sign-off is against a
measurement, not against a language. Re-running the harness invalidates every review and the
report lists them under "sign-off stale, re-review needed". That is intentional friction.

### 5.10 The LLM evals

Zero audio, TSVs only. A full 15-language sweep is a few dollars uncached and free cached, so
they run in CI on every prompt change.

**`thibi eval cleanup`**

| | |
|---|---|
| Input | column 3 `transcription` — lowercased, unpunctuated |
| Reference | column 2 `raw_transcription` — punctuated, cased |
| Arms | `{do-nothing control} × {current, restraint} × {models}` |
| Normalizer | `keepPunctuation: true, caseFold: false` — punctuation is the thing being measured |

The `do-nothing` control is a real arm that makes no API call: hypothesis = input. Every other
arm is scored against it, per language, and a table without the control column is not a valid
report.

Three metrics:

```ts
// 1. cer_punct — CER with punctuation retained. The headline, comparable to the research table.

// 2. length_delta — (len(hyp) - len(input)) / len(input), codepoints.
//    A cleanup pass should be slightly positive (punctuation added). Strongly negative means
//    deletion; strongly positive means the model wrote something.

// 3. entity_drift — the acronym / numeral / foreign-token metric.
const ENTITY = /\p{Lu}{2,}|\d[\d.,:/٫٬]*|(?<=^|\s)\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]*(?=$|\s)/gu;
/**
 * Extract from input and hypothesis the multiset of: ALL-CAPS runs, digit strings, and — when
 * the language's script is not Latin — Latin-script tokens. Drift is the symmetric difference
 * over max(1, |input tokens|).
 *
 * This is the metric that names `UN tún ní ìrètí… → Wọ́n tún ní ìrètí…`: "UN" leaves the
 * multiset, drift jumps, and the report can print the token that vanished. Raw CER moves by two
 * characters for that edit and under-weights it relative to how badly it damages a quote.
 */
```

And a fourth, which is the strongest of the set:

```ts
// 4. content_delta — a CONTRACT CHECK, not a quality score.
//    Normalize both the input and the hypothesis with { keepPunctuation: false, caseFold: true }
//    and stripWhitespace forced on. A compliant cleanup pass changes punctuation, case and
//    whitespace and nothing else, so the two strings must be IDENTICAL and content_delta must
//    be exactly 0.000. Any non-zero value is a rewrite, by definition, with no argument
//    available about whether the rewrite was an improvement.
//
//    This is what names the Pashto and Somali failures, which entity_drift cannot see because
//    both substitutions are in-script: د اغیزو → د نړیوالې تودوخې, and ay…saameeyay → uu…saameeyay.
//    It is also, deliberately, exactly the property the restraint prompt asks the model to
//    self-check (Phase 6 §6.3).
```

Report per language: `control`, then per arm `cer_punct`, `content_delta`, `entity_drift`,
`length_delta`, and the count of segments where `content_delta > 0` with two examples rendered
in full. A reviewer reading the LLM report should see the actual damaged strings, not only rates.

**The CI gate.**

```
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,candidate --gate
```

Exits non-zero if, for any language:

| Condition | Meaning |
|---|---|
| `cer_punct(arm) > cer_punct(control)` | The pass is worse than doing nothing. The exact regression the research found in **every** language tested |
| `content_delta(arm) > 0.005` | The pass rewrote content. Tolerance is not 0 only because Unicode normalization differences across providers are real; 0.005 is ~1 character in 200 |
| `entity_drift(arm) > 0.02` | Named entities moved |

Output on failure names the language, the metric, both numbers and the delta, and prints the
worst offending pair. Without `--gate` the same run reports and exits 0, so local iteration is
not a fight.

The gate is only real because of one line in §5.8: **`paramsHash` includes `promptId` and
`promptVersion`.** A bumped prompt is a cache miss and must be re-measured. Without that the
gate passes on the previous prompt's cached numbers and the whole mechanism is theatre.

The second thing that keeps it real: `packages/eval/src/cleanup.ts` imports
`buildCleanupPrompt` from `packages/engine` and renders it with the same registry vars the
worker uses. It never contains a prompt string of its own.

**`thibi eval translate --target en`**

- Load `<cfg>/dev.tsv` and `en_us/dev.tsv`. Dedupe both by `id`. Inner-join on `id`. Report `n`
  after the join, which is smaller than either side.
- Source and reference are both column 2 `raw_transcription` — chrF is punctuation-sensitive and
  the research numbers are against punctuated English.
- Score `corpusChrf2`.
- Two controls, printed in every table: **English → English = 87.0**, the metric ceiling, so
  nobody reads 72 as "72% correct"; and **Burmese = 65.6**, the shipping bar, because that is
  the quality already in production.
- Default `--n 30`. `--reproduce-research` pins `n=10` and the research doc's language list so
  the first run can be diffed against the published table once; after that, 30.
- Expect the table to reproduce the shape: Cebuano 80.4, Javanese 77.1, Xhosa 72.2, Zulu 71.8,
  Uzbek 71.6, Lao 71.6, Amharic 70.2, Somali 66.2, Khmer 65.7 at or above the bar; Odia 64.1,
  Hausa 63.3, Pashto 62.3, Igbo 60.3, Yoruba 51.6 below it. Magnitudes will move — different
  models, n=30 not 10 — the ordering should not.
- No gate on translate. Translation quality is a language property, not a regression surface;
  the gate belongs on cleanup, where a prompt edit silently damages text.

Cost sanity: 15 languages × 30 sentences × 2 arms × 2 models ≈ 1800 calls at ~200 in / 200 out
tokens. Under $10 uncached, ~$0 thereafter.

### 5.11 Outputs

**`results/tiers.json`** — imported by `packages/languages` at build time, rendered by
`/settings/languages`, overridden per-instance by the `language_support` table.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T10:41:02Z",
  "runId": "2026-08-09T10-04-11Z-a7f3",
  "engineVersion": "0.5.0",
  "sampling": { "strategy": "tar-order", "split": "dev", "n": 30, "deterministic": true },
  "baseline": {
    "code": "my-MM", "provider": "google", "model": "chirp_2",
    "cerNospace": 0.121, "n": 30, "ci95": [0.098, 0.147], "suspect": false
  },
  "languages": {
    "ha-NG": {
      "tier": "beta",
      "reason": "measured",
      "provider": "google", "model": "chirp_2",
      "n": 30, "clipSeconds": 582, "genderSplit": { "MALE": 14, "FEMALE": 16 },
      "cer": 0.184, "cerNospace": 0.184, "cerGrapheme": 0.180, "cerCi95": [0.151, 0.221],
      "wer": 0.402, "werKind": "space",
      "ratio": 1.52,
      "scriptIntegrity": 0.998,
      "evalRunId": "2026-08-09T10-04-11Z-a7f3", "evalDate": "2026-08-09",
      "humanReview": null,
      "blockedFromVerifiedBy": ["ratio>1.15", "ciHi>0.20", "humanReview"],
      "notes": ""
    },
    "si-LK": {
      "tier": "experimental", "reason": "no-eval-set",
      "cer": null, "cerNospace": null, "wer": null, "werKind": null,
      "ratio": null, "scriptIntegrity": null, "n": 0,
      "humanReview": null,
      "blockedFromVerifiedBy": ["no-eval-set"],
      "notes": "One of five non-FLEURS Google languages. Supply --manifest to measure."
    },
    "my-MM-groq": {
      "tier": "unsupported", "reason": "script-integrity",
      "provider": "groq", "model": "whisper-large-v3",
      "cer": 0.97, "scriptIntegrity": 0.02,
      "example": { "ref": "အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက်…", "hyp": "ASEAN YAK SOMPHA CHHA KOO…" }
    }
  }
}
```

`reason` is an enum — `measured | no-eval-set | code-rejected | script-integrity | not-run` — and
the UI branches on it. "Not yet measured" and "measured and bad" must never render the same.

**`results/reports/asr-YYYY-MM-DD.md`**, in this order:

1. **Tier changes since last run**, first, before anything else. `code · from → to · cer before
   → after · why`. Empty is a one-line "no tier changes". A reader who only reads the top of the
   file must still learn the thing that matters.
2. Run metadata: provider, model, n, split, engine version, baseline CER + CI, sampling note.
3. The full table, grouped by tier then sorted by ratio: code, name, endonym, n, CER, CI, ratio,
   WER (or `—`), script integrity, tier.
4. **Blocked from verified** — every language that met the point estimates and lists exactly what
   it still needs. This is the work queue for human review.
5. **Script integrity failures** — with the hypothesis rendered verbatim next to the reference.
   Seeing `ASEAN YAK SOMPHA CHHA KOO NEPI ROKKA TONGPYAN KE BHA REUU` on the page is what makes
   the check comprehensible to somebody who did not write it.
6. Methodology and caveats, boilerplate every time: FLEURS is read Wikipedia sentences — clean
   audio, single careful speakers, no crosstalk, no code-switching; the sample is the first N
   tar entries; at n=30 the interval is wide; benchmark numbers overstate newsroom performance,
   more so for the long tail.

**`results/reports/llm-YYYY-MM-DD.md`** reproduces the research doc's table shape so the two can
be compared by eye:

```
| Language | Do nothing | Current prompt | Restraint prompt |
|---|---|---|---|
| Burmese  | 0.016      | 0.033          | 0.019            |
```

with a second table per arm for `content_delta` / `entity_drift` / `length_delta`, a
translation-chrF2 table carrying both controls in every row group, and a "damage examples"
section quoting the worst `content_delta` pairs in full.

### 5.12 CLI surface

| Command | Notes |
|---|---|
| `thibi eval asr --languages <codes\|@tier\|all> [--provider] [--model] [--n 30] [--split dev]` | `--dry-run`, `--budget-usd`, `--concurrency`, `--no-cache`, `--max-duration` |
| `thibi eval asr --manifest ./local.tsv --config <cfg> [--audio-dir ./clips]` | The non-FLEURS door |
| `thibi eval cleanup --languages <codes> [--arms control,current,restraint] [--models a,b] [--gate]` | No audio |
| `thibi eval translate --target en --languages <codes> [--n 30] [--reproduce-research]` | No audio |
| `thibi eval report --run <runId>` | Recomputes reports and `tiers.json` from the runlog. Zero API calls |
| `thibi eval init-manifest ./clips/ --config <cfg>` | Scaffolds a manifest with durations filled |

Exit codes: `0` ok · `1` error · `2` gate failed · `3` budget exhausted · `4` baseline suspect.

## Porting notes

Almost nothing ports; the old repo has no harness. What travels:

| From | To | Verbatim? |
|---|---|---|
| `lib/myanmar.ts:13-19` `normalizeMyanmarText` | Steps 1–2 and the whitespace collapse of `normalizeForScoring` | **Changed.** Generalised by `ScoreProfile`; conversion followed by a second `.normalize('NFC')`, which the original omits |
| `lib/myanmar.ts` deps `is-zawgyi`, `rabbit-node` | `packages/core` | Verbatim, including the comment that Google's `myanmar-tools` npm package ships unbuilt source and cannot be required — it will otherwise be re-attempted |
| `research/language-expansion-recommendations.md:118-136` | The harness spec | This document is the executable form of that section |
| `research/…:174-181` cleanup table | `results/reports/llm-*.md` shape | The report is deliberately diffable against it |

Must **not** survive:

- Any hardcoded `my-MM` outside `BASELINE_CODE`.
- Whole-string Zawgyi conversion in the **runtime** pipeline. It is fine for scoring, where
  whitespace is stripped anyway and nothing is aligned; the runtime path converts per word
  because conversion is not length-preserving and would desynchronise word timings.
- In-place normalization. Scoring never mutates stored text — `segments.text_raw` keeps the exact
  provider bytes and the harness normalizes a copy.
- Any notion that "the API accepted the code" is a support signal. `provider-matrix.json` records
  acceptance; `tiers.json` records support; they are different files for a reason.

## Tests

`packages/core/src/metrics/__tests__/` — **all written and green: 213 tests, 2026-08-12.**

| File | Cases |
|---|---|
| `parity.test.ts` | 121 tests. Every case in `__fixtures__/parity.json`, CER/WER at 1e-12, chrF2 at 1e-6, plus the corpus block and the three documented jiwer divergences asserted rather than skipped |
| `levenshtein.test.ts` | Empty/empty, empty/non-empty both directions, identical, single substitution, pure insertion, pure deletion, transposition costs 2, symmetry over 100 random pairs |
| `cer.test.ts` | `corpusCer` ≠ mean of sentence CERs on a deliberately skewed length distribution; grapheme vs codepoint differ on `yoruba-combining`; `null` on empty reference |
| `wer.test.ts` | `null` for `wordSegmentation: 'none'`; `kind: 'icu'` never labelled `'space'`; Hausa hyphen retained by `letterlikePunct` |
| `chrf.test.ts` | `corpusChrf2` ≠ mean of sentence chrF2; effective-order handling when the hypothesis is shorter than 6 characters; identical strings score 100 |
| `normalize.test.ts` | Snapshot per script: `mymr-unicode`, `mymr-zawgyi`, `khmr`, `laoo`, `thai`, `ethi`, `arab-rtl`, `latn-yoruba`, `sinh-zwj-preserved`, `deva-zwnj-preserved`. Plus: NFC idempotence; digit folding `၁၉၉၅ → 1995`; ZWSP always gone; RLM/LRM always gone; `keepPunctuation: true` preserves `။` and `።` |
| `script-integrity.test.ts` | `groq-romanized-burmese` → < 0.1; `google-burmese` → > 0.99; `yoruba-diacritics` → 1.0 (Latin Extended Additional in blocks); pure-digit string → 0 counted, returns 0; mixed Burmese with an English acronym → > 0.9 |
| `bootstrap.test.ts` | Same seed → same interval; interval contains the point estimate; n=1 gives a degenerate interval; width shrinks as n grows |

`packages/eval/src/__tests__/`

| File | Cases |
|---|---|
| `tsv.test.ts` | `parseTsv` on `__fixtures__/my_mm_dev_head.tsv` (first 20 real rows, committed): 7 fields per row, the quoted `raw_transcription` on row 1 comes back with **no** stray `"` and doubled quotes collapsed; a row with a trailing `\r\n`; a final line with no newline |
| `tsv-cache.test.ts` | Second `loadTsv` with an unchanged oid performs zero `resolve` fetches (mocked fetch counter); a changed oid re-downloads and leaves the old file on disk |
| `audio.test.ts` | Against `__fixtures__/mini.tar.gz` served by a local range-capable server: takes exactly N; skipped entries do not stall; a truncated prefix that yields ≥ N resolves; one that yields < N rejects and the retry doubles the range; the `dev/` directory entry is skipped |
| `manifest.test.ts` | Empty `plain` derived from `raw`; `num_samples: 0` triggers ffprobe (stubbed); `--audio-dir` resolution; the loader's output is structurally identical to `loadTsv`'s |
| `sample.test.ts` | Duplicate `id`s deduped keeping first; same seed → same sample; different seed → different sample; tar-order sampling is seed-independent |
| `cache-key.test.ts` | Key changes when any of provider/model/lang/clipHash/paramsHash changes; **key changes when `promptVersion` changes** — the gate's load-bearing assertion; key is stable across key-order permutations of the params object |
| `tier.test.ts` | Table-driven over the boundary matrix below |
| `gate.test.ts` | A synthetic runlog where `yo-NG` candidate CER exceeds control → exit 2 with `yo-NG` named; `content_delta` 0.004 passes, 0.006 fails; all-clear → exit 0 |
| `report.test.ts` | `thibi eval report` on a committed runlog fixture reproduces a committed markdown snapshot byte for byte; tier-changes section is first; empty tier-changes renders the one-liner |

Tier boundary matrix (`tier.test.ts`), baseline 0.120 throughout:

| cer | ratio | n | ciHi | integrity | review | expect |
|---|---|---|---|---|---|---|
| 0.13 | 1.08 | 30 | 0.19 | 0.99 | present | `verified` |
| 0.13 | 1.08 | 30 | 0.19 | 0.99 | **null** | `beta` + `blockedFromVerifiedBy: ["humanReview"]` |
| 0.13 | 1.08 | 30 | **0.24** | 0.99 | present | `beta` — the CI, not the point estimate |
| 0.13 | 1.08 | **20** | 0.19 | 0.99 | present | `beta` |
| 0.10 | 0.83 | 30 | 0.14 | **0.30** | present | `unsupported` — integrity beats everything |
| 0.30 | 2.5 | 30 | 0.38 | 0.99 | null | `experimental` |
| **0.70** | 5.8 | 30 | 0.80 | 0.99 | null | `unsupported` |
| n/a | n/a | 0 | n/a | n/a | null | `experimental` + `reason: "no-eval-set"` |

## Verification

```bash
# 1. Metrics parity. Must be green before anything else is trusted.
pnpm -F @thibi/core test
#    → parity.test.ts  38 passed   (jiwer 3.x, sacrebleu 2.x, frozen 2026-08-09)

# 2. Data access, no spend.
thibi eval asr --languages ha-NG,jv-ID,yo-NG --n 30 --dry-run
#    → the table in §5.8, TOTAL ~29m of audio, ~$0.30, and NO wav files fetched

# 3. A real three-language run.
thibi eval asr --languages ha-NG,jv-ID,yo-NG --n 30 --provider google --budget-usd 5
#    → adds my-MM automatically, one line saying so
#    → results/runs/<runId>.jsonl, results/tiers.json, results/reports/asr-<date>.md
#    → every language has a tier, a CI, and scriptIntegrity > 0.95
#    → NO language is `verified` (no human review exists yet)

# 4. Caching is real.
time thibi eval asr --languages ha-NG --n 30 --provider google
#    → second run: 0 HTTP requests to the provider, "30/30 cached", wall time < 2s, $0.00

# 5. Reports recompute with no network.
thibi eval report --run <runId>
#    → byte-identical reports and tiers.json; run it with the network off to prove it

# 6. The non-FLEURS case.
thibi eval asr --languages si-LK --n 30
#    → exits 0; si-LK appears as experimental / no-eval-set / cer: null, not as an error

thibi eval init-manifest ./clips/shan --config shn_mm > shan.tsv
#    → 7-column file, durations filled; fill in the transcriptions, then:
thibi eval asr --manifest ./shan.tsv --config shn_mm --provider google --lang my-MM
#    → a CER and a CI for a language that is in no provider's list

# 7. The LLM evals and the gate.
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,current
#    → reproduces the research direction: `current` above `control` in EVERY language
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,current --gate; echo $?
#    → 2, naming yo-NG first with the largest delta
thibi eval cleanup --languages my,yo,ps,so,ha,xh --arms control,restraint --gate; echo $?
#    → 0   (this is Phase 6's acceptance test, run from here)
#    NOTE: the research doc's own table has Burmese restraint at 0.019 against a 0.016
#    control — i.e. ABOVE it — while its prose claims restraint beats the control in every
#    language. The table and the prose disagree. The gate is written to believe the table:
#    Burmese is expected to fail on first run, and closing that gap is Phase 6 work, not a
#    number to be excused. See phase-06 risk 1.

thibi eval translate --target en --languages ceb,jv,so,ha,yo --reproduce-research
#    → chrF2 table with the 87.0 ceiling and 65.6 bar in every row group;
#      ordering matches the research doc even where magnitudes differ

# 8. Budget enforcement.
thibi eval asr --languages @all --n 30 --budget-usd 0.50; echo $?
#    → 3, partial runlog written, tiers.json NOT written

# 9. CI.
gh workflow run eval.yml   # parity + cleanup gate, both green, no Python installed
```

Full-sweep cost, for planning: 107 languages × 30 clips × ~20 s ≈ 18 h of audio ≈ **$17** at
Google's $0.016/min. Cheap enough to re-run whenever a provider changes; the cache makes a
re-run of unchanged languages free.

## Risks and open questions

1. **Hugging Face availability and rate limits.** `q=3000; w=300` on resolvers. A 107-language
   sweep is ~214 resolve requests plus 107 tree calls — comfortable, but a parallel CI matrix
   could trip it. Mitigation: serialise tree calls, respect `Retry-After`, and cache
   aggressively. If HF ever gates the dataset, the manifest path is the escape hatch and the
   cached TSVs remain valid.
2. **Tar-order sampling is deterministic but not stratified.** FLEURS dev has no speaker id, so
   a single speaker could dominate a 30-clip sample and nothing would reveal it. Mitigation:
   report the gender split, and offer `--sample-strategy id-seeded` which downloads a larger
   prefix and selects by seeded shuffle over `id`. Default stays tar-order because it is free.
   **Open:** whether id-seeded sampling materially moves any language's CER. Measure once on
   three languages and record the answer here.
3. **n=30 gives a wide interval.** That is not a flaw, it is the honest mechanical reason
   `verified` requires human sign-off. Raising n is cheap ($0.16 per 30 clips) and the harness
   supports `--n 100`; the thresholds do not change, the CI just narrows.
4. **FLEURS is read Wikipedia sentences.** Clean audio, careful single speakers, no crosstalk,
   and — critically — no code-switching, when real Hausa, Javanese and Cebuano usage is heavily
   mixed with English, Indonesian and Tagalog. Every number overstates newsroom performance.
   This belongs in the report boilerplate, in the UI tier tooltip, and in any external claim.
5. **The cleanup eval's input is correct text with punctuation removed**, so the metric penalises
   every edit including ones that would be genuine corrections on real ASR output. That inflates
   the penalty against any editing prompt. The direction of the result is solid — substituting a
   pronoun for `UN` is a fabrication on any input — but the magnitudes are approximate. The
   restraint prompt is designed around this by not attempting error correction at all.
6. **chrF2 float parity.** Python and JS accumulate in different orders. 1e-6 tolerance is
   generous for the corpus sizes here but would need revisiting at corpus scale.
7. **`is-zawgyi` on short strings.** Detection is unreliable below a sentence. Scoring always
   operates on full sentences, so this is safe here; the runtime pipeline, which sees short
   segments, must not naively reuse the same threshold. Flagged for Phase 1.
8. **Column 4 is an unexploited word-boundary reference.** FLEURS ships a grapheme string with
   `|` at word boundaries for exactly the scripts where we return `wer: null`. That is a free
   Burmese word segmentation, and a genuine WER could be computed against it. **Open:** whether
   its segmentation is consistent enough to be worth it. Do not ship a WER derived from it
   without a separate check — a plausible-looking WER for Burmese is worse than `null`.
9. **`language_support` overrides `tiers.json` at runtime.** An admin can promote a language in
   the DB. That is intended — a newsroom that has validated Hausa on its own material should be
   able to say so — but the UI must show the tier's provenance (`measured` vs `admin override`)
   or the whole measurement discipline leaks.

## Definition of done

- [x] `pnpm -F @thibi/core test` passes, including every case in `__fixtures__/parity.json`.
      **Done 2026-08-12: 213 metrics tests, 859 across the repo, nothing skipped.**
- [x] `packages/core/src/metrics` has zero runtime dependencies ~~beyond `is-zawgyi` and
      `rabbit-node`~~ **at all** — Zawgyi conversion is injected through
      `ScoreOptions.convertZawgyi` (amendment 56) — and imports cleanly from a React client
      component.
- [x] `gen-parity.py` is committed with pinned requirements and is **not** invoked by CI.
      **Run for real 2026-08-12: jiwer 4.0.0, sacrebleu 2.6.0, CPython 3.11.8.**
- [ ] `loadTsv` performs one tree call and zero resolve calls when the cached oid matches.
- [ ] `fetchClips` returns exactly N wavs from a byte prefix, aborts the request, and treats
      truncated-gzip as success.
- [ ] `thibi eval asr --dry-run` prints exact audio minutes and estimated USD with no audio
      downloaded.
- [ ] `--budget-usd` aborts mid-run with exit 3, writes the runlog, and does not write
      `tiers.json`.
- [ ] A second identical run makes zero provider calls.
- [ ] `thibi eval report --run <id>` reproduces both reports and `tiers.json` with the network
      disabled.
- [x] Every one of the eight normalization rules has a named snapshot test. **Done** —
      `mymr-unicode`, `mymr-zawgyi`, `khmr`, `laoo`, `thai`, `ethi`, `arab-rtl`,
      `latn-yoruba`, `sinh-zwj-preserved`, `deva-zwnj-preserved`, plus NFC idempotence,
      `၁၉၉၅ → 1995`, both Arabic digit sets, ZWSP, the seven bidi marks, and `keepPunctuation`
      preserving `။` and `።`.
- [x] `scriptIntegrity` scores the recorded Groq romanized-Burmese string below 0.1 and the
      Google output above 0.99, both from committed fixtures. **Done in Phase 4a; the test
      moved to `metrics/__tests__/script-integrity.test.ts` with the rename.**
- [ ] The Burmese baseline is measured in every run; a >25% baseline move sets `baselineSuspect`,
      blocks `tiers.json` and exits 4.
- [ ] `assignTier` cannot return `verified` with `humanReview: null`, asserted by a test.
- [ ] The five non-FLEURS languages appear as `experimental / no-eval-set / cer: null`, and the
      command exits 0.
- [ ] `--manifest` runs the full pipeline on a hand-built 7-column file with local audio.
- [ ] `thibi eval cleanup --arms control,current` reproduces the research finding: worse than
      the control in every language tested.
- [ ] `--gate` exits 2 on a CER regression, on `content_delta > 0.005`, and on
      `entity_drift > 0.02`, naming the language and the numbers.
- [ ] The cache key changes when `promptVersion` changes, asserted by a test.
- [ ] `packages/eval` imports the prompt builders from `packages/engine`; a grep for a prompt
      string literal in `packages/eval` returns nothing.
- [ ] `thibi eval translate --target en` prints both controls in every table.
- [ ] `results/tiers.json` validates against its schema and is consumed by
      `packages/languages/src/tiers.ts` at build time, with an all-experimental fallback when
      absent.
- [ ] The ASR report opens with tier changes since the last run.
- [ ] `.github/workflows/eval.yml` runs parity + the cleanup gate on every PR touching
      `packages/core/src/metrics`, `packages/eval`, or `packages/engine/src/llm/prompts`.
