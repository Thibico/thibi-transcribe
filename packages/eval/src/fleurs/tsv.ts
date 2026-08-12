import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * FLEURS TSV fetch, cache and parse.
 *
 * Two facts about this data are load-bearing and neither is guessable from the file
 * extension. Both were re-verified against the live repo on 2026-08-12, against
 * `my_mm/dev.tsv` at oid `15b8e8cc455f214dd11ddb3cfc1ef8298f057eb7`.
 *
 * 1. **It is tab-delimited but CSV-quoted**, and the corruption it causes is silent. 26 of
 *    384 rows (6.8%) parse differently under a correct parser than under `split('\t')` —
 *    but **every row yields 7 fields either way**, because no quoted field in this file
 *    contains a tab. A naive parser therefore looks completely correct: the row count is
 *    right, the column count is right, and only the *contents* of the reference string are
 *    wrong, carrying stray `"` characters into every CER computed against them.
 *
 * 2. **Not every row has 7 fields.** Four rows of `my_mm/dev.tsv` have six: the
 *    `transcription` column is absent, not empty. They are unscoreable as ASR references
 *    and are dropped — but the count is *returned*, never swallowed, because a harness that
 *    silently discards 1% of an eval set is exactly the thing this phase exists to prevent.
 */

const HF = 'https://huggingface.co';
const REPO = 'datasets/google/fleurs';

export type Split = 'dev' | 'test' | 'train';

export interface FleursRow {
  /** Column 0. **Shared sentence key across languages** — the n-way join for translation. */
  id: number;
  /** Column 1. The tar member is `<split>/<filename>`. */
  filename: string;
  /** Column 2 `raw_transcription` — punctuated, cased. Cleanup reference. */
  raw: string;
  /** Column 3 `transcription` — lowercased, unpunctuated. The ASR reference. */
  plain: string;
  /** Column 4 — space-separated units, `|` at word boundaries. Unused in v1. */
  graphemes: string;
  /** Column 5. ÷ 16000 = seconds, so a dry run costs nothing. */
  numSamples: number;
  /** Column 6 — `MALE` / `FEMALE`. Sample-composition reporting. */
  gender: string;
}

export interface ParsedTsv {
  rows: FleursRow[];
  /**
   * Records that were structurally unusable — fewer than seven fields, or no id. Reported
   * rather than filtered into silence: `thibi eval asr` prints this, and a config where it
   * is not a rounding error is a bug in the sampler's denominator, not a curiosity.
   */
  dropped: number;
}

export interface TreeEntry {
  type: 'file' | 'directory';
  oid: string;
  size: number;
  path: string;
}

export class NoEvalSetError extends Error {
  constructor(readonly cfg: string) {
    super(`no FLEURS config '${cfg}'`);
    this.name = 'NoEvalSetError';
  }
}

/**
 * One tree call covers every file in the config and returns `size` as well as `oid`, which
 * is what the budget estimator wants for the tarball. `oid` is also the resolve ETag —
 * verified identical on 2026-08-12 — so `If-None-Match` would work too; the tree is
 * preferred because it is one request for the TSV *and* the audio metadata.
 */
export async function configTree(
  cfg: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, TreeEntry>> {
  const res = await fetchImpl(`${HF}/api/${REPO}/tree/main/data/${cfg}?recursive=true`);
  if (res.status === 404) throw new NoEvalSetError(cfg);
  if (!res.ok) throw new Error(`FLEURS tree ${cfg}: HTTP ${res.status}`);
  const entries = (await res.json()) as TreeEntry[];
  return new Map(entries.map((e) => [e.path, e]));
}

/**
 * The oid goes in the *filename*, not in a sidecar metadata file. A changed oid is then a
 * plain cache miss with no conditional request at all, revalidation costs one tree call for
 * the whole config, and stale files are garbage-collectable by pattern.
 *
 * `fetchImpl` is injected so the cache test can count calls. The default is the global
 * `fetch`; nothing in this package reads `process.env`.
 */
export async function loadTsv(
  cacheDir: string,
  cfg: string,
  split: Split = 'dev',
  fetchImpl: typeof fetch = fetch,
): Promise<{ rows: FleursRow[]; oid: string; dropped: number }> {
  const tree = await configTree(cfg, fetchImpl);
  const entry = tree.get(`data/${cfg}/${split}.tsv`);
  if (!entry) throw new NoEvalSetError(cfg);

  const path = join(cacheDir, 'fleurs', cfg, `${split}.${entry.oid}.tsv`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    const res = await fetchImpl(`${HF}/${REPO}/resolve/main/data/${cfg}/${split}.tsv`);
    if (!res.ok) throw new Error(`FLEURS ${cfg}/${split}.tsv: HTTP ${res.status}`);
    text = await res.text();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  }

  const parsed = parseTsv(text);
  return { rows: parsed.rows, oid: entry.oid, dropped: parsed.dropped };
}

/**
 * Tab-delimited, CSV-quoted, RFC-4180 quoting rules.
 *
 * Written out rather than pulled from a CSV library because the library would have to be a
 * runtime dependency of a package that scores transcripts, and because the quoting is the
 * only part of the format that is not trivial. A quoted field may contain tabs and
 * newlines, so parsing is over the whole text and not line by line — this file has no such
 * row today, and a parser that assumes so would break on the day one appears.
 */
export function parseTsv(text: string): ParsedTsv {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        // RFC 4180: a doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else field += c;
      continue;
    }
    // Only a quote at the *start* of a field opens quoting; one mid-field is a literal.
    if (c === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (c === '\t') {
      record.push(field);
      field = '';
      continue;
    }
    if (c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      continue;
    }
    if (c === '\r') continue;
    field += c;
  }
  // A final line with no trailing newline is a record, not a discard.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const rows: FleursRow[] = [];
  let dropped = 0;
  for (const r of records) {
    if (r.length < 7 || r[0] === '' || !Number.isFinite(Number(r[0]))) {
      dropped++;
      continue;
    }
    rows.push({
      id: Number(r[0]),
      filename: r[1]!,
      raw: r[2]!,
      plain: r[3]!,
      graphemes: r[4]!,
      numSamples: Number(r[5]) || 0,
      gender: r[6]!,
    });
  }
  return { rows, dropped };
}
