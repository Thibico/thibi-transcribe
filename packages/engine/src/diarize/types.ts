/**
 * The diarization seam.
 *
 * There is exactly one reason this is an interface rather than a pyannote client: so that
 * `reconcile.ts` has one input type. pyannote returns turns; ElevenLabs Scribe returns
 * diarized *words*; a hosted diarizing ASR (see spike S7) returns speaker-labelled
 * segments. Collapsing all three to `Turn[]` at the edge is what stops the reconciler from
 * growing a branch per source, and the reconciler is the hardest correctness problem in the
 * product.
 */

/**
 * A span of time attributed to one speaker.
 *
 * `speakerKey` is the source's own anonymous label — `SPEAKER_00`, `A`, `speaker_2`. It is
 * meaningless across runs and is mapped to a durable `speakers` row by `identity.ts`.
 *
 * **Turns may overlap.** pyannote 3.1 emits overlapping speech as separate turns, and two
 * turns from the *same* speaker can overlap too. Nothing downstream may assume they are
 * disjoint or that a timestamp belongs to at most one turn.
 */
export interface Turn {
  startMs: number;
  endMs: number;
  speakerKey: string;
}

export interface DiarizationCapabilities {
  mode: 'async-task' | 'sync';
  /** pyannote takes a presigned URL; Scribe uploads bytes. */
  needsAudioUrl: boolean;
  /** pyannote 3.1 marks overlapping speech; most hosted sources do not. */
  overlapAware: boolean;
  speakerCountHint: 'exact' | 'range' | 'none';
  maxDurationMs?: number;
  costModel: { unit: 'audio_minute'; usdPerUnit: number };
}

export interface DiarizeRequest {
  runId: string;
  stepId: string;
  audio: { key: string; uri?: string; durationMs: number };
  hints: { numSpeakers?: number; minSpeakers?: number; maxSpeakers?: number };
  deadlineMs: number;
}

/**
 * JSON-only, and for the same reason `BatchOp` is in Phase 2: Phase 9 persists this
 * between a submit and a poll that may happen in different processes. No clients, no
 * closures, no class instances.
 */
export interface DiarizeHandle {
  sourceId: string;
  taskId: string;
  submittedAtMs: number;
  meta: Record<string, unknown>;
}

export interface DiarizeStatus {
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  /** 0–1 where the source reports it. Absent is not zero. */
  progress?: number;
  error?: { code: string; message: string; retryable: boolean };
}

export interface DiarizationResult {
  turns: Turn[];
  numSpeakers: number;
  model: string;
  params: unknown;
  audioDurationMs?: number;
  computeMs?: number;
  realtimeFactor?: number;
  raw: unknown;
}
