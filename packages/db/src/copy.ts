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

function field(value: string | number | boolean | null | undefined): string {
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
      field(row.segmentId),
      field(row.runId),
      field(row.idx),
      field(row.startMs),
      field(row.endMs),
      field(row.text),
      field(row.confidence),
      field(row.speakerId ?? null),
      field(row.isEstimated ?? false),
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
  if (rows.length === 0) return 0;

  const stream = client.query(
    copyFrom.from(`copy words (${COLUMNS.join(', ')}) from stdin with (format text)`),
  );

  await pipeline(
    Readable.from(
      (function* () {
        for (const row of rows) yield wordRowToCopyLine(row);
      })(),
    ),
    stream,
  );

  return rows.length;
}
