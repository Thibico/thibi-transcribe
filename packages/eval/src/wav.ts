/**
 * How long is this wav?
 *
 * A RIFF file is a chunk list, and the canonical-44-byte-header shortcut — read `byteRate`
 * at 28 and the data size at 40 — is only correct for the simplest possible layout. **FLEURS
 * wavs are not that layout**, and the first n=30 sweep is what proved it: every one of 120
 * clips was costed at exactly 4.56 s, whatever its real length, so four languages with
 * visibly different total audio all billed $0.0365.
 *
 * Measured on `my_mm/dev`: `fmt ` is 18 bytes rather than 16, a 4-byte `fact` chunk follows
 * it, and `data` therefore begins at byte 50. Offset 40 lands in the middle of that
 * preamble and reads the same 291939 out of every FLEURS file — 291939 / 64000 = 4.56, the
 * constant. It is the worst shape of wrong number: identical across every input, plausible
 * in magnitude, and derived from real bytes.
 *
 * They are also **32-bit IEEE float** (`audioFormat` 3, `blockAlign` 4), 16 kHz mono — so
 * the "16 kHz mono PCM, 32 bytes per ms" assumption was two ways off at once.
 *
 * So: walk the chunks. It is a dozen lines, it cannot be fooled by an extra chunk, and the
 * thing it computes decides what a run reports having spent.
 */

export interface WavDuration {
  ms: number;
  /** False when the header could not be read and the byte-length estimate was used. */
  exact: boolean;
}

/**
 * A last-resort estimate for a file whose header does not parse: 16 kHz mono 32-bit float,
 * which is what every FLEURS clip measured so far is. It is a guess, it says so through
 * `exact: false`, and a caller that cares — costing does — can refuse to bill on it.
 */
const FALLBACK_BYTES_PER_MS = 64;

export function wavDuration(bytes: Buffer): WavDuration {
  const fallback = { ms: Math.round(bytes.length / FALLBACK_BYTES_PER_MS), exact: false };
  if (bytes.length < 44) return fallback;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return fallback;
  }

  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(offset + 16);
    } else if (id === 'data') {
      // Trust the shorter of the declared size and what is actually here: a truncated
      // download must not report the duration the header wishes it had.
      dataSize = Math.min(size, bytes.length - (offset + 8));
      break;
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by a pad byte that is not
    // counted in its size. Miss it and every subsequent chunk id is garbage.
    offset += 8 + size + (size % 2);
  }

  if (byteRate === 0 || dataSize === 0) return fallback;
  return { ms: Math.round((dataSize / byteRate) * 1000), exact: true };
}
