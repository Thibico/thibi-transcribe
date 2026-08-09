/**
 * Quote-aware delimited-text parsing.
 *
 * This exists because of a specific, silent data corruption. FLEURS `dev.tsv` files are
 * tab-*delimited* but CSV-*quoted*: a field containing a quote character is wrapped in
 * `"` and its internal quotes are doubled. `line.split('\t')` therefore leaves stray `"`
 * characters attached to the reference transcription, and every CER computed against that
 * reference is wrong by a small, plausible-looking amount — the worst kind of wrong,
 * because nothing crashes and the number still looks like a number.
 *
 * Used by `scripts/infer-scripts.ts` (Phase 0) and the eval harness (Phase 5). Both must
 * use the same parser; that is the point of it living in `core`.
 */

export interface ParseDelimitedOptions {
  /** Single character. Default tab. */
  delimiter?: string;
  /** Single character. Default `"`. Doubled inside a quoted field to escape itself. */
  quote?: string;
  /** Drop rows that are entirely empty. Default true — trailing newlines are not data. */
  skipEmptyRows?: boolean;
}

/**
 * Parse delimited text into rows of fields.
 *
 * Handles quoted fields containing the delimiter, newlines, and doubled quotes; CRLF and
 * LF line endings; and a final row with no trailing newline. A quote that appears in the
 * middle of an *unquoted* field is kept verbatim rather than treated as an error — real
 * corpora contain apostrophes and inch marks, and refusing to parse them would be worse
 * than the corruption this function exists to prevent.
 */
export function parseDelimited(input: string, options: ParseDelimitedOptions = {}): string[][] {
  const delimiter = options.delimiter ?? '\t';
  const quote = options.quote ?? '"';
  const skipEmptyRows = options.skipEmptyRows ?? true;

  if (delimiter.length !== 1) throw new TypeError('delimiter must be a single character');
  if (quote.length !== 1) throw new TypeError('quote must be a single character');
  if (delimiter === quote) throw new TypeError('delimiter and quote must differ');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // True only at the very start of a field, which is the only position where an opening
  // quote is meaningful. `it"s fine` must survive with its quote intact.
  let atFieldStart = true;

  const endField = (): void => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };

  const endRow = (): void => {
    endField();
    if (!skipEmptyRows || row.some((f) => f.length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === quote) {
        if (input[i + 1] === quote) {
          field += quote;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === quote && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      continue;
    }

    if (ch === delimiter) {
      endField();
      continue;
    }

    if (ch === '\n') {
      endRow();
      continue;
    }

    if (ch === '\r') {
      // CRLF: consume the pair as one terminator. A lone CR is also a terminator.
      if (input[i + 1] === '\n') i++;
      endRow();
      continue;
    }

    field += ch;
    atFieldStart = false;
  }

  // A file that does not end in a newline still has a final row.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

/** `parseDelimited` with the FLEURS default: tab-delimited, CSV-quoted. */
export function parseTsv(input: string): string[][] {
  return parseDelimited(input, { delimiter: '\t' });
}

/**
 * The seven FLEURS TSV columns, named. Column 5 (`numSamples`) gives exact duration at
 * 16 kHz, which is what lets `--dry-run` cost an eval run without downloading any audio.
 *
 * `id` is a sentence key *shared across languages* — `ha_ng` 1615 and `en_us` 1615 are the
 * same sentence — which is the n-way join the translation harness needs. It is not unique
 * within a file: multiple rows can share one id.
 */
export interface FleursRow {
  id: string;
  fileName: string;
  /** Lowercased, unpunctuated. The *input* for the cleanup eval. */
  transcription: string;
  /** Punctuated and cased. The *reference* for the cleanup eval. */
  rawTranscription: string;
  /** Space-separated phonemic/romanized form. Unused so far. */
  narrowTranscription: string;
  /** Sample count at 16 kHz. Duration in seconds = numSamples / 16000. */
  numSamples: number;
  gender: string;
}

/** Parse a FLEURS `dev.tsv`/`train.tsv`/`test.tsv` into named rows, skipping malformed lines. */
export function parseFleursTsv(input: string): FleursRow[] {
  const out: FleursRow[] = [];
  for (const cols of parseTsv(input)) {
    if (cols.length < 7) continue;
    const numSamples = Number.parseInt(cols[5] ?? '', 10);
    out.push({
      id: cols[0] ?? '',
      fileName: cols[1] ?? '',
      transcription: cols[2] ?? '',
      rawTranscription: cols[3] ?? '',
      narrowTranscription: cols[4] ?? '',
      numSamples: Number.isFinite(numSamples) ? numSamples : 0,
      gender: cols[6] ?? '',
    });
  }
  return out;
}
