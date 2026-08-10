import { IngestError } from './errors.js';

/**
 * Filenames are validated, never rewritten.
 *
 * The old app did this at `app/api/jobs/route.ts:42`:
 *
 *     const safeName = file.name.replace(/[^\w.\-က-႟]+/g, "_");
 *
 * It allows ASCII word characters plus the Myanmar block and replaces everything else, so
 * `مصاحبه با استاد.mp3` becomes `_______.mp3` and `ការសម្ភាសន៍.m4a` becomes `_.m4a`. In a tool
 * whose thesis is the 44 languages nobody else serves, a sanitiser hardcoded to one script
 * destroys the filename of every journalist it was not written for.
 *
 * The fix is not a better sanitiser — it is making sanitisation unnecessary. Storage keys are
 * `media/{uuid}/source.{ext}` with `ext` from a fixed allowlist, so no user-controlled byte
 * ever reaches a path. The filename is then just data, and data columns hold data.
 */

const MAX_FILENAME_BYTES = 255;

export function validateFilename(raw: string): string {
  // Any path component is stripped rather than rejected: browsers send bare names, but
  // `webkitdirectory` uploads and CLI arguments carry directories, and that is not the
  // user doing anything wrong.
  const base = raw.split(/[/\\]/).pop() ?? '';

  // NFC because the same Burmese or Khmer filename can arrive in either normalisation
  // depending on the operating system that produced it, and two spellings of one name would
  // otherwise read as two different files.
  const name = base.normalize('NFC').trim();

  if (name === '' || name === '.' || name === '..') {
    throw new IngestError('bad_filename', 'The filename is empty or refers to a directory.');
  }
  // Control characters break Content-Disposition and terminal output, and no real filename
  // contains them. This is the one class of byte that is rejected rather than kept.
  //
  // Tested by code point rather than by a character-class regex: the regex form is exactly what
  // `no-control-regex` exists to catch, and an eslint-disable here would silence the rule in the
  // one file in the repo that legitimately reasons about control characters.
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) {
      throw new IngestError('bad_filename', 'The filename contains control characters.');
    }
  }
  // Bytes, not code points: the limit is a filesystem and column limit, and one Burmese
  // character is three UTF-8 bytes. Counting characters would let a 255-character Burmese
  // name through at 765 bytes.
  if (Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES) {
    throw new IngestError(
      'bad_filename',
      `The filename is longer than ${MAX_FILENAME_BYTES} bytes.`,
    );
  }
  return name;
}

/**
 * Extension → MIME. Seeded from the old app's `ACCEPTED_EXTENSIONS`
 * (`app/api/jobs/route.ts:10-12`), extended and given types.
 */
export const ALLOWED_EXTENSIONS = new Map<string, string>([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['mp4', 'video/mp4'],
  ['aac', 'audio/aac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['flac', 'audio/flac'],
  ['webm', 'video/webm'],
  ['amr', 'audio/amr'],
  ['mkv', 'video/x-matroska'],
  ['mov', 'video/quicktime'],
  ['3gp', 'audio/3gpp'],
  ['wma', 'audio/x-ms-wma'],
  ['aiff', 'audio/aiff'],
]);

/**
 * The only user-influenced value that reaches a storage key — lowercased, from a fixed set.
 *
 * This is a *first* filter and never the decision: `ffprobe` decides whether the bytes are
 * media (see `probe.ts`). A `.mp3` containing a PDF passes here and is rejected there.
 */
export function allowedExtension(filename: string, contentType: string): string {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] ?? '').toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return ext;

  // Fall back to the declared type, so a file saved without an extension — routine for
  // recordings pulled off a phone — is still accepted when the client knows what it is.
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const byMime = [...ALLOWED_EXTENSIONS].find(([, mime]) => mime === base)?.[0];
  if (byMime) return byMime;

  throw new IngestError(
    'unsupported_type',
    `"${filename}" is not a supported media file.`,
    `Supported extensions: ${[...ALLOWED_EXTENSIONS.keys()].join(', ')}`,
  );
}
