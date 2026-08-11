/**
 * The pyannote sidecar as a `DiarizationSource`.
 *
 * Submit/poll over HTTP against `services/sidecar`, with the JSON-only handle constraint
 * Phase 2's `BatchOp` established: the handle is persisted between a submit and a poll that
 * may happen in different processes, so it carries no clients and no closures.
 *
 * The one thing worth reading twice is the treatment of a **lost** task. The sidecar
 * distinguishes 404 ("never seen, safe to submit") from `state: "lost"` ("this ran and was
 * killed"), and this client must preserve that distinction rather than collapsing both to
 * "retry": a crash-looping container would otherwise become an infinite retry loop that
 * never counts an attempt.
 */
import type { EngineContext } from '../context.js';
import {
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
} from '../errors.js';
import type {
  DiarizationCapabilities,
  DiarizationResult,
  DiarizeHandle,
  DiarizeRequest,
  DiarizeStatus,
  Turn,
} from './types.js';

export interface SidecarConfig {
  /** e.g. `http://sidecar:8081`. */
  baseUrl: string;
  /**
   * How long a presigned audio URL stays valid. `min(6 h, deadline + 30 min)` — long
   * enough that a queued task does not find its own URL expired, short enough that a leaked
   * one is not a permanent grant.
   */
  presignTtlS?: number;
  /** Control-call timeouts. Deliberately short: these are status calls, not the work. */
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

/** Wire shapes, snake_case, exactly as `services/sidecar/app/schemas.py` emits them. */
interface WireTurn {
  start_ms: number;
  end_ms: number;
  speaker: string;
}
interface WireResult {
  turns: WireTurn[];
  num_speakers: number;
  model: string;
  params: Record<string, unknown>;
  audio_duration_ms: number;
  compute_ms: number;
  realtime_factor: number;
  device: string;
}
interface WireStatus {
  task_id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  progress?: number | null;
  started_at?: number | null;
  finished_at?: number | null;
  result?: WireResult | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

/**
 * The single slot is held by a *different* task.
 *
 * A `RateLimitedError` rather than a bespoke class, because that is exactly what it is and
 * the retry policy already honours `retryAfterMs`. **The engine must not count this as an
 * attempt** — nothing was tried, and spending one of `diarize`'s two retries on a
 * scheduling collision would fail a run because two jobs happened to overlap.
 */
export class DiarizerBusyError extends RateLimitedError {
  constructor(retryAfterS: number) {
    super(`the diarizer is busy; retry in ${retryAfterS}s`, { retryAfterMs: retryAfterS * 1000 });
  }
}

export class PyannoteSource {
  readonly id = 'pyannote';
  readonly label = 'pyannote (self-hosted)';

  constructor(private readonly config: SidecarConfig) {}

  capabilities(): DiarizationCapabilities {
    return {
      mode: 'async-task',
      needsAudioUrl: true,
      // pyannote 3.1 emits overlapping speech as separate turns, which reconcile relies on
      // — same-speaker overlap accumulates rather than competing.
      overlapAware: true,
      speakerCountHint: 'range',
      // No cap. Whole-file diarization is the entire answer to keeping speaker identity
      // across chunk boundaries, and a maxDurationMs here would be the first step toward
      // windowing. The real limit is memory, and the answer to that is memory.
      costModel: { unit: 'audio_minute', usdPerUnit: 0 },
    };
  }

  private url(path: string): string {
    return new URL(path, this.config.baseUrl).toString();
  }

  private async call(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = this.config.readTimeoutMs ?? 30_000, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(this.url(path), { ...rest, signal: timeout });
  }

  async submit(ctx: EngineContext, request: DiarizeRequest): Promise<DiarizeHandle> {
    const ttlS = Math.min(
      this.config.presignTtlS ?? 6 * 3600,
      Math.ceil(request.deadlineMs / 1000) + 1800,
    );
    // Minted with the internal S3 client, not the public one. The sidecar sits on the
    // compose network beside MinIO and has no business traversing the reverse proxy to
    // fetch a file from its neighbour.
    const audioUrl = await ctx.store.presignGet(request.audio.key, ttlS);

    const response = await this.call('/v1/diarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: request.stepId,
        audio_url: audioUrl,
        expected_duration_ms: request.audio.durationMs,
        num_speakers: request.hints.numSpeakers ?? null,
        min_speakers: request.hints.minSpeakers ?? null,
        max_speakers: request.hints.maxSpeakers ?? null,
        // +120 s so the *client* always wins the deadline race and the failure is
        // attributed on our side. The server-side check exists only so a runaway job frees
        // the slot without a container restart.
        deadline_s: Math.ceil(request.deadlineMs / 1000) + 120,
      }),
      timeoutMs: 60_000,
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 60);
      // Not an attempt. Nothing was tried, so the engine reschedules without spending one
      // of `diarize`'s two retries.
      throw new DiarizerBusyError(Number.isFinite(retryAfter) ? retryAfter : 60);
    }
    if (response.status === 503) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; gates?: string[] };
      };
      // NotConfiguredError, not "unavailable": a gated model whose terms nobody accepted is
      // an operator problem, and retrying it for an hour helps no one. The hint carries
      // both gate URLs, because they are accepted separately and accepting only the first
      // still fails at load with an error that never names the second.
      throw new NotConfiguredError(
        body.error?.message ?? 'the diarization model is not loaded',
        body.error?.gates?.length
          ? { hint: `Accept the terms for both models:\n  ${body.error.gates.join('\n  ')}` }
          : undefined,
      );
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      if (response.status >= 500) {
        throw new ProviderUnavailableError(`sidecar returned HTTP ${response.status}: ${text}`);
      }
      throw new ProviderError(`sidecar rejected the request: ${text}`, response.status);
    }

    const body = (await response.json()) as { task_id: string; state: string };
    ctx.logger.info(
      { taskId: body.task_id, state: body.state, existing: response.status === 200 },
      // 200 rather than 202 means this key was already known — a resubmit after a lost
      // response, not a second run.
      response.status === 200 ? 'diarize task already known' : 'diarize task accepted',
    );

    return {
      sourceId: this.id,
      taskId: body.task_id,
      submittedAtMs: ctx.clock.now().getTime(),
      meta: { audioKey: request.audio.key, durationMs: request.audio.durationMs },
    };
  }

  async poll(ctx: EngineContext, handle: DiarizeHandle): Promise<DiarizeStatus> {
    const response = await this.call(`/v1/tasks/${handle.taskId}`);
    if (response.status === 404) {
      // Never seen. Given we hold a handle, the sidecar's journal has been wiped — a fresh
      // volume, not a restart. Retryable, and the resubmit is safe precisely because the
      // task id is derived from the step id.
      return {
        state: 'failed',
        error: {
          code: 'task_unknown',
          message: 'the sidecar has no record of this task; its journal was lost',
          retryable: true,
        },
      };
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(`polling the sidecar returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as WireStatus;
    if (body.state === 'lost') {
      // Counts as an attempt: this ran, consumed the slot, and was killed. Treating it as
      // free would let a crash-looping container retry forever.
      return {
        state: 'lost',
        error: body.error
          ? { code: body.error.code, message: body.error.message, retryable: body.error.retryable }
          : { code: 'lost', message: 'the sidecar restarted mid-task', retryable: true },
      };
    }
    // Built by assignment rather than with `?? undefined`, because
    // `exactOptionalPropertyTypes` makes "the key is absent" and "the key is present and
    // undefined" different types — and here they mean different things too: an absent
    // `progress` is "this source does not report progress", not "zero progress".
    const status: DiarizeStatus = { state: body.state };
    if (body.progress !== null && body.progress !== undefined) status.progress = body.progress;
    if (body.error) {
      status.error = {
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable,
      };
    }
    return status;
  }

  async fetch(_ctx: EngineContext, handle: DiarizeHandle): Promise<DiarizationResult> {
    const response = await this.call(`/v1/tasks/${handle.taskId}`);
    if (!response.ok) {
      throw new ProviderUnavailableError(`fetching the result returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as WireStatus;
    if (body.state !== 'succeeded' || !body.result) {
      throw new ProviderError(`task ${handle.taskId} is ${body.state}, not succeeded`);
    }

    const turns: Turn[] = body.result.turns.map((t) => ({
      startMs: t.start_ms,
      endMs: t.end_ms,
      speakerKey: t.speaker,
    }));

    return {
      turns,
      numSpeakers: body.result.num_speakers,
      model: body.result.model,
      params: body.result.params,
      audioDurationMs: body.result.audio_duration_ms,
      computeMs: body.result.compute_ms,
      realtimeFactor: body.result.realtime_factor,
      raw: body.result,
    };
  }

  async cancel(_ctx: EngineContext, handle: DiarizeHandle): Promise<void> {
    // 204 on anything, including unknown and already-terminal. Cancellation is a statement
    // about a desired end state, so a failure here is not worth propagating.
    await this.call(`/v1/tasks/${handle.taskId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
