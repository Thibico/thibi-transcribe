import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTsv } from '../fleurs/tsv.js';

// `resolveJsonModule` is off repo-wide and a fixture read is a runtime read anyway — the
// point of this fixture is that it is the bytes FLEURS actually serves.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const head = readFileSync(join(FIXTURES, 'my_mm_dev_head.tsv'), 'utf8');

describe('parseTsv against the first 20 real rows of my_mm/dev.tsv', () => {
  it('parses every structurally complete row into seven fields', () => {
    const { rows } = parseTsv(head);
    expect(rows).toHaveLength(17);
    for (const r of rows) {
      expect(Number.isFinite(r.id)).toBe(true);
      expect(r.filename).toMatch(/\.wav$/u);
      expect(typeof r.raw).toBe('string');
      expect(typeof r.plain).toBe('string');
      expect(r.numSamples).toBeGreaterThan(0);
      expect(['MALE', 'FEMALE']).toContain(r.gender);
    }
  });

  /**
   * The whole reason this parser is hand-written. In this file no quoted field contains a
   * tab, so `split('\t')` yields the right *number* of fields on every row and looks
   * correct — it just leaves `"` characters inside the reference string, silently
   * corrupting every CER scored against it.
   */
  it('strips the CSV quoting that a tab split would leave behind', () => {
    const { rows } = parseTsv(head);
    const naive = head
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));

    // The trap is real in this fixture...
    const naiveWithQuotes = naive.filter((f) => f.some((v) => v.includes('"')));
    expect(naiveWithQuotes.length).toBeGreaterThan(0);

    // ...and the field count is identical either way, which is what makes it silent.
    for (const f of naive) expect(f.length === 7 || f.length === 6).toBe(true);

    // No parsed field may carry a stray quote character.
    for (const r of rows) {
      expect(r.raw.startsWith('"')).toBe(false);
      expect(r.raw.endsWith('"')).toBe(false);
      expect(r.plain).not.toContain('""');
    }
  });

  /**
   * Four rows of the full file — three of these twenty — have six fields: `transcription`
   * is absent, not empty. They cannot serve as an ASR reference, so they are dropped; the
   * count is returned so a caller can print it rather than lose 1% of an eval set in
   * silence.
   */
  it('reports rows it drops rather than swallowing them', () => {
    const { rows, dropped } = parseTsv(head);
    expect(dropped).toBe(3);
    expect(rows.length + dropped).toBe(20);
  });
});

describe('parseTsv line-ending and quoting edge cases', () => {
  const row = (id: string) => `${id}\tf${id}.wav\traw\tplain\tg r a\t16000\tMALE`;

  it('collapses a doubled quote inside a quoted field to one literal quote', () => {
    const tsv = `1\ta.wav\t"he said ""hello"" once"\tplain\tg\t16000\tMALE\n`;
    const { rows } = parseTsv(tsv);
    expect(rows[0]!.raw).toBe('he said "hello" once');
  });

  it('treats a quote that is not at the start of a field as a literal', () => {
    const tsv = `1\ta.wav\t12" pipe\tplain\tg\t16000\tMALE\n`;
    expect(parseTsv(tsv).rows[0]!.raw).toBe('12" pipe');
  });

  it('handles CRLF line endings', () => {
    const { rows, dropped } = parseTsv(`${row('1')}\r\n${row('2')}\r\n`);
    expect(dropped).toBe(0);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0]!.gender).toBe('MALE');
  });

  it('keeps a final line that has no trailing newline', () => {
    const { rows } = parseTsv(`${row('1')}\n${row('2')}`);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('parses a tab and a newline inside a quoted field', () => {
    // No row in today's file does this. One appearing is exactly the case a line-by-line
    // parser would split down the middle without erroring.
    const tsv = `1\ta.wav\t"two\tparts\nand a line"\tplain\tg\t16000\tMALE\n`;
    const { rows, dropped } = parseTsv(tsv);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toBe('two\tparts\nand a line');
  });

  it('returns nothing, and drops nothing, for empty input', () => {
    expect(parseTsv('')).toEqual({ rows: [], dropped: 0 });
  });
});
