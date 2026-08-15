/**
 * Object key naming, in one place, because keys are forever.
 *
 * Renaming a key scheme after a newsroom has a terabyte of audio means a migration that
 * copies every object. These are chosen once, here, and the shape of each says what it is
 * for:
 *
 *   assets/{sha[0:2]}/{sha}/source{ext}        content-addressed ⇒ dedupe is free and a
 *                                              re-upload of the same file costs nothing
 *   derivatives/{assetId}/{kind}/{recipe}{ext} keyed by recipe version, so changing the
 *                                              loudnorm parameters invalidates the cache
 *   runs/{runId}/chunks/{idx}.flac             scratch — deletable by prefix
 *   runs/{runId}/raw/{idx}.json                the untouched provider response
 */

/** Fixed width so `list` returns chunks in numeric order rather than 1, 10, 11, 2. */
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function assetKey(sha256: string, ext = ''): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError(`assetKey needs a lowercase hex sha256, got: ${sha256.slice(0, 16)}…`);
  }
  return `assets/${sha256.slice(0, 2)}/${sha256}/source${ext}`;
}

export function derivativeKey(
  assetId: string,
  kind: string,
  recipeVersion: string,
  ext = '',
): string {
  return `derivatives/${assetId}/${kind}/${recipeVersion}${ext}`;
}

export function chunkKey(runId: string, idx: number, ext = '.flac'): string {
  return `runs/${runId}/chunks/${pad3(idx)}${ext}`;
}

export function rawResponseKey(runId: string, idx: number): string {
  return `runs/${runId}/raw/${pad3(idx)}.json`;
}

/**
 * One `asr.chunk` step's parsed output, waiting for the step that assembles the transcript.
 *
 * Separate from `rawResponseKey` because the two answer different questions and have different
 * lifetimes. The raw response is the audit trail — what the provider actually said, kept so a
 * disputed transcript can be checked rather than argued about. This is the parsed shape the
 * next step consumes, so it is provider-agnostic and deletable the moment the segments exist.
 */
export function chunkResultKey(runId: string, idx: number): string {
  return `runs/${runId}/results/${pad3(idx)}.json`;
}

/** Everything scratch for a run. Swept when the run completes; the chunks are re-cuttable. */
export function runChunksPrefix(runId: string): string {
  return `runs/${runId}/chunks/`;
}

export function runPrefix(runId: string): string {
  return `runs/${runId}/`;
}

/**
 * The extension of a filename, lowercased, or ''.
 *
 * ffmpeg dispatches on extension for some containers, so a temp file copied out of the
 * store needs to keep it. Guards against a key traversing directories.
 */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * Reject keys that could escape their prefix once mapped onto a filesystem path by the fs
 * adapter. S3 would happily store `../../etc/passwd` as a literal key; the fs adapter would
 * write it.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0) throw new TypeError('Empty object key');
  if (key.startsWith('/') || key.includes('\\')) throw new TypeError(`Unsafe object key: ${key}`);
  if (key.split('/').some((part) => part === '.' || part === '..')) {
    throw new TypeError(`Unsafe object key: ${key}`);
  }
  // Control characters in a key are always a bug or an attack, never a filename. The
  // lint rule that objects to them in a regex is the rule this check exists to enforce.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(key)) {
    throw new TypeError('Object key contains a control character');
  }
}
