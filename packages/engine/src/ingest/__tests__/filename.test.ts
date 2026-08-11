import { describe, expect, it } from 'vitest';
import { allowedExtension, validateFilename } from '../filename.js';
import { IngestError } from '../errors.js';

describe('validateFilename', () => {
  // The point of this phase's filename handling. The old app's
  // `replace(/[^\w.\-က-႟]+/g, "_")` turned each of these into underscores, and it shipped in a
  // product whose thesis is the languages nobody else serves. These are the regression.
  it.each([
    ['Persian', 'مصاحبه با استاد.mp3'],
    ['Khmer', 'ការសម្ភាសន៍.m4a'],
    ['Burmese', 'မင်္ဂလာပါ.wav'],
    ['Amharic', 'ቃለ መጠይቅ.mp3'],
    ['Chinese', '访谈录音.m4a'],
    ['emoji', '🎙️ interview.mp3'],
    ['spaces and punctuation', "Daw Khin — part 2 (final).m4a"],
  ])('keeps a %s filename byte-identical', (_label, name) => {
    expect(validateFilename(name)).toBe(name);
  });

  it('strips a path component without rejecting the name', () => {
    // webkitdirectory uploads and CLI arguments both carry directories; that is not the user
    // doing anything wrong, so it is stripped rather than refused.
    expect(validateFilename('interviews/2026/01-daw-khin.m4a')).toBe('01-daw-khin.m4a');
    expect(validateFilename('C:\\Users\\yan\\ကြားနာမှု.wav')).toBe('ကြားနာမှု.wav');
  });

  it('normalises to NFC so one name is not two files', () => {
    // The same name off a Mac and off Linux can differ only in normalisation. Left alone,
    // the two spellings are two rows.
    const decomposed = 'e\u0301coute.mp3';
    expect(validateFilename(decomposed)).toBe('écoute.mp3');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a dot', '.'],
    ['a double dot', '..'],
    ['a trailing path separator', 'interviews/'],
  ])('rejects %s', (_label, name) => {
    expect(() => validateFilename(name)).toThrow(IngestError);
  });

  it('rejects control characters', () => {
    expect(() => validateFilename('bad\u0000name.mp3')).toThrow(/control characters/);
    expect(() => validateFilename('bad\u001fname.mp3')).toThrow(/control characters/);
    expect(() => validateFilename('bad\u007fname.mp3')).toThrow(/control characters/);
  });

  it('measures the length limit in bytes, not code points', () => {
    // 100 Burmese characters is 300 UTF-8 bytes. Counting characters would accept this and
    // then fail at the column or the filesystem, somewhere far less legible.
    const burmese = 'က'.repeat(100) + '.wav';
    expect(Buffer.byteLength(burmese, 'utf8')).toBeGreaterThan(255);
    expect(() => validateFilename(burmese)).toThrow(/longer than/);

    // The same count in ASCII is well inside the limit — the check is about bytes.
    expect(validateFilename('a'.repeat(100) + '.wav')).toHaveLength(104);
  });
});

describe('allowedExtension', () => {
  it('lowercases and accepts the allowlist', () => {
    expect(allowedExtension('INTERVIEW.M4A', 'application/octet-stream')).toBe('m4a');
    expect(allowedExtension('a.FLAC', '')).toBe('flac');
  });

  it('falls back to the declared content type when there is no extension', () => {
    // Recordings pulled off a phone routinely arrive without one.
    expect(allowedExtension('recording', 'audio/mpeg')).toBe('mp3');
    // …including when the type carries parameters.
    expect(allowedExtension('recording', 'audio/mp4; codecs="mp4a.40.2"')).toBe('m4a');
  });

  it('rejects an unsupported type and names the file', () => {
    expect(() => allowedExtension('notes.pdf', 'application/pdf')).toThrow(/notes\.pdf/);
    expect(() => allowedExtension('notes.pdf', 'application/pdf')).toThrow(IngestError);
  });

  it('is a first filter and not the decision', () => {
    // A PDF renamed to .mp3 passes here by design; ffprobe rejects it in probe.ts. Asserted
    // so nobody later "fixes" this into a content check and assumes it is one.
    expect(allowedExtension('actually-a-pdf.mp3', 'application/pdf')).toBe('mp3');
  });
});
