import { describe, expect, it } from 'vitest';
import { wavDuration } from '../wav.js';

/**
 * The regression these exist for: the first n=30 sweep costed all 120 clips at exactly
 * 4.56 s each, because the old reader took the data size from offset 40 and FLEURS wavs put
 * something else there.
 */

interface Chunk {
  id: string;
  body: Buffer;
}

/** Build a RIFF file out of chunks, so a test can express a layout rather than a byte dump. */
function riff(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const header = Buffer.alloc(8);
    header.write(c.id, 0, 'ascii');
    header.writeUInt32LE(c.body.length, 4);
    parts.push(header, c.body);
    if (c.body.length % 2 === 1) parts.push(Buffer.alloc(1)); // word-align pad
  }
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length + 4, 4);
  head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, payload]);
}

/** `fmt ` for 16 kHz mono 32-bit float — the FLEURS shape, 18 bytes with the cbSize field. */
function fmtFloat18(): Buffer {
  const b = Buffer.alloc(18);
  b.writeUInt16LE(3, 0); // IEEE float
  b.writeUInt16LE(1, 2); // mono
  b.writeUInt32LE(16_000, 4);
  b.writeUInt32LE(64_000, 8); // byteRate
  b.writeUInt16LE(4, 12); // blockAlign
  b.writeUInt16LE(32, 14); // bits
  return b;
}

/** `fmt ` for 16 kHz mono 16-bit PCM — the canonical 16-byte chunk. */
function fmtPcm16(): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(1, 0);
  b.writeUInt16LE(1, 2);
  b.writeUInt32LE(16_000, 4);
  b.writeUInt32LE(32_000, 8);
  b.writeUInt16LE(2, 12);
  b.writeUInt16LE(16, 14);
  return b;
}

describe('wavDuration', () => {
  /**
   * The exact FLEURS layout, measured 2026-08-13: an 18-byte `fmt `, a 4-byte `fact`, and
   * `data` at byte 50. The old reader took offset 40 — inside the `fact` preamble — and
   * returned the same 4.56 s for every file in the dataset.
   */
  it('reads a FLEURS wav: 18-byte fmt, a fact chunk, data at 50', () => {
    const seconds = 21.6;
    const file = riff([
      { id: 'fmt ', body: fmtFloat18() },
      { id: 'fact', body: Buffer.alloc(4) },
      { id: 'data', body: Buffer.alloc(64_000 * seconds) },
    ]);
    // The layout the constant came from, asserted so a future edit cannot drift off it.
    expect(file.toString('ascii', 38, 42)).toBe('fact');
    expect(file.toString('ascii', 50, 54)).toBe('data');
    expect(wavDuration(file)).toEqual({ ms: 21_600, exact: true });
  });

  it('gives different answers for different lengths, which is the whole bug', () => {
    const of = (seconds: number) =>
      wavDuration(
        riff([
          { id: 'fmt ', body: fmtFloat18() },
          { id: 'fact', body: Buffer.alloc(4) },
          { id: 'data', body: Buffer.alloc(64_000 * seconds) },
        ]),
      ).ms;
    expect(of(11.6)).toBe(11_600);
    expect(of(27.6)).toBe(27_600);
    expect(of(11.6)).not.toBe(of(27.6));
  });

  it('still reads the canonical 16-bit PCM layout', () => {
    const file = riff([
      { id: 'fmt ', body: fmtPcm16() },
      { id: 'data', body: Buffer.alloc(32_000 * 3) },
    ]);
    expect(wavDuration(file)).toEqual({ ms: 3000, exact: true });
  });

  it('skips the pad byte after an odd-sized chunk instead of reading garbage', () => {
    const file = riff([
      { id: 'fmt ', body: fmtPcm16() },
      { id: 'LIST', body: Buffer.from('odd') }, // 3 bytes, so one pad byte follows
      { id: 'data', body: Buffer.alloc(32_000 * 2) },
    ]);
    expect(wavDuration(file)).toEqual({ ms: 2000, exact: true });
  });

  it('trusts the bytes present over a header that claims more', () => {
    const file = riff([
      { id: 'fmt ', body: fmtPcm16() },
      { id: 'data', body: Buffer.alloc(32_000) },
    ]);
    // A download cut short: the declared data size outlives the file.
    const truncated = file.subarray(0, file.length - 16_000);
    expect(wavDuration(truncated).ms).toBe(500);
  });

  it('falls back, and says it is falling back, on anything that is not a wav', () => {
    expect(wavDuration(Buffer.from('not audio at all'))).toEqual({ ms: 0, exact: false });
    const noData = riff([{ id: 'fmt ', body: fmtPcm16() }]);
    expect(wavDuration(noData).exact).toBe(false);
  });
});
