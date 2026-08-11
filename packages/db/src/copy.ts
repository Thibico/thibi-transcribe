import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import copyFrom from 'pg-copy-streams';
import type pg from 'pg';

/**
 * Bulk word insert via `COPY … FROM STDIN`.
 *
 * A three-hour file is roughly 30,000 word rows per run. Individual inserts are ~40× slower
 * and hold the chunk's transaction open long enough to matter when eight chunks are in
 * flight. The `id` column is omitted so the identity sequence assigns it.
 */

export interface WordRow {
  segmentId: string;
  runId: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  /** NULL, never 0, when the provider does not measure confidence. */
  confidence: number | null;
  speakerId?: string | null;
  isEstimated?: boolean;
}

/**
 * COPY text format escaping.
 *
 * Backslash, tab, newline and carriage return are the delimiters and escapes; `\N` is NULL.
 * A transcript containing a literal tab or backslash is not hypothetical — provider output
 * is arbitrary text — and getting this wrong shifts every subsequent column silently.
 */
function escape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

export function copyField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Refusing to COPY a non-finite number: ${value}`);
    }
    return String(value);
  }
  return escape(value);
}

const COLUMNS = [
  'segment_id',
  'run_id',
  'idx',
  'start_ms',
  'end_ms',
  'text',
  'confidence',
  'speaker_id',
  'is_estimated',
] as const;

export function wordRowToCopyLine(row: WordRow): string {
  return (
    [
      copyField(row.segmentId),
      copyField(row.runId),
      copyField(row.idx),
      copyField(row.startMs),
      copyField(row.endMs),
      copyField(row.text),
      copyField(row.confidence),
      copyField(row.speakerId ?? null),
      copyField(row.isEstimated ?? false),
    ].join('\t') + '\n'
  );
}

/**
 * Insert word rows on an existing client.
 *
 * Takes a `PoolClient` rather than the Drizzle instance because COPY needs the raw
 * connection, and because the caller is already inside the per-chunk transaction — the
 * words must land or not land together with their segments.
 */
export async function copyWords(client: pg.PoolClient, rows: readonly WordRow[]): Promise<number> {
  return copyInto(client, 'words', COLUMNS, rows, wordRowToCopyLine);
}

/**
 * `COPY … FROM STDIN` into any table, with the same escaping.
 *
 * Extracted from `copyWords` in Phase 3 rather than written fresh, because the diarization
 * writer needs the *same* escaping for a different table and duplicating `escape()` is how
 * a transcript containing a literal tab eventually shifts a column in one path and not the
 * other. Its main use is the update-via-temp-table pattern: a three-hour file is ~40k
 * `words.speaker_id` updates, and 40k statements is not a write, it is a wait.
 */
export async function copyInto<T>(
  client: pg.PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly T[],
  toLine: (row: T) => string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const stream = client.query(
    copyFrom.from(`copy ${table} (${columns.join(', ')}) from stdin with (format text)`),
  );

  await pipeline(
    Readable.from(
      (function* () {
        for (const row of rows) yield toLine(row);
      })(),
    ),
    stream,
  );

  return rows.length;
}
