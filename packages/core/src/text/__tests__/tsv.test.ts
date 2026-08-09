import { describe, expect, it } from 'vitest';
import { parseDelimited, parseFleursTsv, parseTsv } from '../tsv.js';

describe('parseTsv', () => {
  it('splits plain tab-delimited rows', () => {
    expect(parseTsv('a\tb\tc\nd\te\tf\n')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  // This is the whole reason the module exists. `split('\t')` yields `"He said ""hi"""`
  // and every CER computed against it is quietly wrong.
  it('strips CSV quoting and unescapes doubled quotes', () => {
    const line = '1\tx.wav\t"He said ""hi"""\tHe said "hi".\tn\t16000\tFEMALE\n';
    const [row] = parseTsv(line);
    expect(row?.[2]).toBe('He said "hi"');
    expect(row?.[3]).toBe('He said "hi".');
  });

  it('keeps a quote that appears mid-field in an unquoted field', () => {
    expect(parseTsv(`it's 6" long\tb\n`)).toEqual([[`it's 6" long`, 'b']]);
  });

  it('keeps delimiters and newlines inside a quoted field', () => {
    expect(parseTsv('"a\tb"\t"c\nd"\n')).toEqual([['a\tb', 'c\nd']]);
  });

  it('handles CRLF, a lone CR, and a missing final newline', () => {
    expect(parseTsv('a\tb\r\nc\td\re\tf')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('preserves empty fields but drops entirely empty rows', () => {
    expect(parseTsv('a\t\tc\n\n\nd\te\tf\n')).toEqual([
      ['a', '', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('keeps empty rows when asked', () => {
    expect(parseDelimited('a\n\nb\n', { skipEmptyRows: false })).toEqual([['a'], [''], ['b']]);
  });

  it('does not mangle non-Latin scripts', () => {
    const [row] = parseTsv('မင်္ဂလာပါခင်ဗျာ\tپښتو\n');
    expect(row).toEqual(['မင်္ဂလာပါခင်ဗျာ', 'پښتو']);
  });

  it('rejects a delimiter equal to the quote character', () => {
    expect(() => parseDelimited('a', { delimiter: '"', quote: '"' })).toThrow(TypeError);
  });
});

describe('parseFleursTsv', () => {
  const tsv =
    '1615\t8697.wav\tsannu duniya\tSannu, duniya!\ts a n u\t32000\tFEMALE\n' +
    'truncated\trow\n' +
    '1616\t8698.wav\tban sani ba\tBan sani ba.\tb a n\t48000\tMALE\n';

  it('names the seven columns and skips short rows', () => {
    const rows = parseFleursTsv(tsv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: '1615',
      fileName: '8697.wav',
      transcription: 'sannu duniya',
      rawTranscription: 'Sannu, duniya!',
      numSamples: 32000,
      gender: 'FEMALE',
    });
  });

  // numSamples is what makes `--dry-run` costing possible with zero audio downloaded.
  it('gives exact duration at 16 kHz from numSamples', () => {
    const rows = parseFleursTsv(tsv);
    expect(rows.map((r) => r.numSamples / 16000)).toEqual([2, 3]);
  });
});
