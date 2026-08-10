import { formatClock, type Segment, type Warning, type WordTimingQuality } from '@thibi/core';
import type { ChunkPlan, SeamRecord } from '@thibi/engine';

/**
 * The transcript output shape — **frozen and versioned**.
 *
 * Tests parse it, Phase 11's UI parses it, and any newsroom's script will parse it. The
 * `schema` field is what lets all three detect a change rather than silently mis-read one.
 */
export const TRANSCRIPT_SCHEMA = 'thibi.transcript/1';

export interface TranscriptJson {
  schema: typeof TRANSCRIPT_SCHEMA;
  run: {
    id: string;
    provider: string;
    model: string;
    language: string;
    mode: string;
    engineVersion: string;
    wordTimingQuality: WordTimingQuality;
    startedAt: string;
    finishedAt: string;
    costUsd: number;
    state: 'done' | 'partial';
  };
  media: {
    filename: string;
    sha256: string | null;
    durationMs: number | null;
    format: string | null;
  };
  chunks: Array<{
    idx: number;
    offsetMs: number;
    contentStartMs: number;
    endMs: number;
    overlapLeadMs: number;
    status: 'done' | 'failed';
  }>;
  seams: SeamRecord[];
  segments: Array<{
    idx: number;
    startMs: number;
    endMs: number;
    chunkIdx: number | null;
    confidence: number | null;
    hasWords: boolean;
    text: string;
    textRaw: string;
    words: Array<{
      idx: number;
      startMs: number;
      endMs: number;
      text: string;
      confidence: number | null;
    }>;
  }>;
  warnings: Warning[];
}

export interface BuildTranscriptInput {
  runId: string;
  provider: string;
  model: string;
  language: string;
  mode: string;
  engineVersion: string;
  wordTimingQuality: WordTimingQuality;
  startedAt: Date;
  finishedAt: Date;
  costUsd: number;
  partial: boolean;
  filename: string;
  sha256: string | null;
  durationMs: number | null;
  format: string | null;
  plans: readonly ChunkPlan[];
  failedChunks: ReadonlySet<number>;
  seams: readonly SeamRecord[];
  segments: readonly Segment[];
  warnings: readonly Warning[];
}

export function buildTranscript(input: BuildTranscriptInput): TranscriptJson {
  return {
    schema: TRANSCRIPT_SCHEMA,
    run: {
      id: input.runId,
      provider: input.provider,
      model: input.model,
      language: input.language,
      mode: input.mode,
      engineVersion: input.engineVersion,
      wordTimingQuality: input.wordTimingQuality,
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      costUsd: input.costUsd,
      state: input.partial ? 'partial' : 'done',
    },
    media: {
      filename: input.filename,
      sha256: input.sha256,
      durationMs: input.durationMs,
      format: input.format,
    },
    chunks: input.plans.map((p) => ({
      idx: p.idx,
      offsetMs: p.offsetMs,
      contentStartMs: p.contentStartMs,
      endMs: p.endMs,
      overlapLeadMs: p.overlapLeadMs,
      status: input.failedChunks.has(p.idx) ? ('failed' as const) : ('done' as const),
    })),
    seams: [...input.seams],
    segments: input.segments.map((s) => ({
      idx: s.idx,
      startMs: s.startMs,
      endMs: s.endMs,
      chunkIdx: s.chunkIdx ?? null,
      confidence: s.confidence,
      hasWords: s.hasWords,
      text: s.text,
      textRaw: s.textRaw,
      words: s.words.map((w) => ({
        idx: w.idx,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        confidence: w.confidence,
      })),
    })),
    warnings: [...input.warnings],
  };
}

/** `[00:00:01.120] text`, using the same clock function the editor will use. */
export function formatText(transcript: TranscriptJson): string {
  return transcript.segments
    .map((s) => `[${formatClock(s.startMs, { alwaysHours: true })}] ${s.text}`)
    .join('\n');
}

/**
 * Exit codes.
 *
 * **4 still prints the transcript.** A three-hour transcript with one bad 55-second chunk
 * is still valuable, and this is the CLI's face of that principle.
 */
export const EXIT = {
  ok: 0,
  usage: 1,
  notConfigured: 2,
  languageRejected: 3,
  partial: 4,
  aborted: 5,
} as const;
