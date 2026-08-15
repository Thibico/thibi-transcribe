import { chunkResultKey } from '@thibi/storage';
import type { WordTimingQuality } from '@thibi/core';
import type { EngineContext } from '../context.js';
import type { ProviderSegment, TranscribeResult } from '../providers/types.js';

/**
 * What one `asr.chunk` step leaves behind for the step that assembles the transcript.
 *
 * **Why an artifact rather than segment rows.** The old app inserted segments per chunk, and
 * `lib/queue.ts:112-113` explains why: *"Insert per chunk rather than at the end, so a long
 * file shows partial results as it goes and a late failure doesn't discard earlier work."*
 * The second half of that is the important half and it survives here; the first half cannot,
 * and the reason is the seam merge that did not exist in the old app.
 *
 * Chunks overlap by 1200 ms so the LCS merge can de-duplicate the words either side of a cut,
 * and a chunk's *leading* words are therefore not final until its predecessor's are known.
 * Persisting each chunk's segments as they land would mean going back and rewriting rows —
 * deleting duplicated words and renumbering every `segments.idx` after the seam — on a table
 * whose defining rule is that the machine's output is never overwritten. So the chunk's
 * result is written to object storage, where a late failure still discards nothing and a
 * retried chunk still re-bills only itself, and the segments are written once, in order, by
 * `normalize.text`.
 *
 * `raw` is deliberately not part of this. The untouched provider response is archived
 * separately under `runs/{id}/raw/{idx}.json` for the "what did the provider actually say"
 * question; this is the parsed shape, so the assembling step never has to know which provider
 * produced it.
 */
export interface ChunkResult {
  idx: number;
  segments: ProviderSegment[];
  wordTimingQuality: WordTimingQuality;
  usage: { audioMs: number; requests: number; wordsUnattached?: number };
  warnings: Array<{ code: string; message: string }>;
  providerId: string;
  model: string;
  /** What the chunk cost, so the run's total is a sum of facts rather than one estimate. */
  costUsd: number;
}

export async function writeChunkResult(
  ctx: EngineContext,
  runId: string,
  result: ChunkResult,
): Promise<string> {
  const key = chunkResultKey(runId, result.idx);
  await ctx.store.put(key, Buffer.from(JSON.stringify(result)), {
    contentType: 'application/json',
  });
  return key;
}

/**
 * Read one chunk's result back, or null if it was never written.
 *
 * Null is an ordinary answer, not an error: it is what a chunk that died after five attempts
 * leaves behind, and the assembling step turns it into a placeholder segment rather than a
 * hole in the timeline.
 */
export async function readChunkResult(
  ctx: EngineContext,
  runId: string,
  idx: number,
): Promise<ChunkResult | null> {
  const key = chunkResultKey(runId, idx);
  if (!(await ctx.store.head(key))) return null;
  const stream = await ctx.store.get(key);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as ChunkResult;
}

/** The parsed half of a provider response, ready to be stored. */
export function toChunkResult(
  idx: number,
  result: TranscribeResult,
  meta: { providerId: string; model: string; costUsd: number },
): ChunkResult {
  return {
    idx,
    segments: result.segments,
    wordTimingQuality: result.wordTimingQuality,
    usage: result.usage,
    warnings: result.warnings,
    ...meta,
  };
}
