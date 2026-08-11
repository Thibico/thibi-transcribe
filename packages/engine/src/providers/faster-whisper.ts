/**
 * Self-hosted faster-whisper, over the Phase 3 sidecar.
 *
 * **The only provider in the system with genuine per-word confidence.** `word.probability`
 * is a real probability from the decoder, not a length-normalised segment likelihood
 * divided down onto tokens, and it is what makes the low-confidence QA surface a signal
 * rather than a decoration. Google's per-word `confidence` is the only comparable number
 * and it was measured separately (S2); OpenAI and Groq return nothing at word level, and
 * this file is why `wordConfidence` can be `true` anywhere.
 *
 * Two shapes here differ from every other provider and both are deliberate.
 *
 * **`modes: ['sync']`, but the transport is async.** `transcribe()` submits, polls and
 * returns, so the engine sees an ordinary synchronous provider. That is honest at this
 * layer — a one-hour file on CPU takes 30-60 minutes and the *caller* is a worker that is
 * allowed to wait — and it is what lets the whole Phase 1 pipeline use this provider with
 * no new branch. Phase 9 can lift the poll loop out into `run_steps` the way Phase 2's
 * batch path was lifted, and the JSON-only handle below is what will make that a move
 * rather than a rewrite.
 *
 * **The audio is staged, not uploaded, and this file never learns what S3 is.** The sidecar
 * fetches a URL; the engine has a local path. `stageAudio` is handed in by the composition
 * root exactly as `FetchBatchArgs` hands `read`/`list` to the Google batch path, for the
 * same reason: a provider that knows about a bucket cannot be reused by the next
 * deployment. Its `release` runs in a `finally`, because a scratch object left behind on
 * every failed run is a bucket that grows without anybody deciding it should.
 */
import type { RunMode, WordTimingQuality } from '@thibi/core';
import type { ProviderLanguageCapability } from '@thibi/languages';
import { PROVIDER_MATRIX } from '@thibi/languages';
import {
  NotConfiguredError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitedError,
} from '../errors.js';
import { segmentConfidence } from './whisper/parse.js';
import { whisperLanguageCode } from './whisper/language.js';
import type {
  CostModel,
  ProviderCapabilities,
  ProviderConfig,
  ProviderSegment,
  ProviderWord,
  TranscribeRequest,
  TranscribeResult,
  TranscriptionProvider,
} from './types.js';

/**
 * Audio staged somewhere the sidecar can fetch it.
 *
 * `release` is not optional and is not best-effort: the caller runs it in a `finally`.
 */
export interface StagedAudio {
  url: string;
  release: () => Promise<void>;
}

export interface FasterWhisperConfig extends ProviderConfig {
  /** e.g. `http://localhost:8081`. Unset means this instance does no local ASR. */
  baseUrl: string;
  model?: string;
  /**
   * Put the file where the sidecar can GET it and return the URL.
   *
   * **The URL must be signed for the host the *sidecar* will use**, which is not the host
   * this process uses — SigV4 signs `Host`, and getting it wrong is a 403 that looks like a
   * broken model (overview amendment 43).
   */
  stageAudio: (localPath: string) => Promise<StagedAudio>;
  computeType?: string;
  beamSize?: number;
  vadMinSilenceMs?: number;
}

/** Wire shapes, snake_case, exactly as `services/sidecar/app/schemas.py` emits them. */
interface WireWord {
  start_ms: number;
  end_ms: number;
  word: string;
  probability: number;
}
interface WireSegment {
  start_ms: number;
  end_ms: number;
  text: string;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
  words: WireWord[];
}
interface WireResult {
  kind: 'transcribe';
  segments: WireSegment[];
  language: string;
  language_probability?: number | null;
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
  result?: WireResult | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

/**
 * `large-v3` for non-English, and **not `distil-large-v3`**.
 *
 * The overview said to default to `distil-large-v3` and Phase 4 risk 1 corrected it:
 * distil-whisper is a distillation of *English* data, so as the default for a product whose
 * reason to exist is 44 non-English languages it would be actively misleading. English gets
 * it because there it genuinely is the best speed/quality trade.
 */
export const DEFAULT_MODEL = 'large-v3';
export const DEFAULT_ENGLISH_MODEL = 'distil-large-v3';
export const PREFER_SPEED_MODEL = 'large-v3-turbo';

/** Models the sidecar will load. Mirrors `Settings.asr_allowed_models`; see `models pull`. */
export const MODELS: readonly string[] = [
  'large-v3',
  'large-v3-turbo',
  'distil-large-v3',
  'medium',
  'small',
  'base',
  'tiny',
];

/**
 * Zero. Self-hosted means the marginal cost of a minute of audio is electricity.
 *
 * That is not the same as free, and Phase 15's tier table is where the honest comparison
 * lives: `large-v3` int8 on 8 cores runs 30-60 minutes per audio-hour, so the real price is
 * a machine and a wait rather than a per-minute rate.
 */
export const USD_PER_MINUTE = 0;

export function fasterWhisperCapabilities(_model: string = DEFAULT_MODEL): ProviderCapabilities {
  return {
    modes: ['sync'],
    wordTimestamps: true,
    // **The only `true` in the system that means a real per-word probability.** The UI must
    // distinguish "we have per-word confidence" from "this provider gives none" — never by
    // showing zero, which reads as maximum uncertainty.
    wordConfidence: true,
    segmentConfidence: true,
    diarization: 'none',
    adaptation: 'prompt',
    languageDetection: true,
    limits: {
      // No chunking, and none is needed: the model takes the whole normalized file, so word
      // timings are continuous and there is no seam to de-duplicate.
      syncMaxBytes: Number.POSITIVE_INFINITY,
      syncMaxSeconds: Number.POSITIVE_INFINITY,
      // One, and it is the sidecar's single slot rather than a politeness limit. A
      // concurrent request gets 429, which the engine must not count as an attempt.
      maxConcurrentRequests: 1,
      rpm: 0,
    },
    staging: 'none',
  };
}

/** The slot is held by something else — very possibly a diarization of the same file. */
export class SidecarBusyError extends RateLimitedError {
  constructor(retryAfterS: number) {
    super(`the sidecar is busy; retry in ${retryAfterS}s`, { retryAfterMs: retryAfterS * 1000 });
  }
}

export interface FasterWhisperProviderOptions {
  fetchImpl?: typeof fetch;
  prompt?: string;
  /** Overridden by tests; production polls every 5 s. */
  pollIntervalMs?: number;
  /** Injected so the poll loop costs no wall-clock in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** `true` prefers `large-v3-turbo` over `large-v3` for non-English. */
  preferSpeed?: boolean;
}

export function resolveFasterWhisperModel(
  code: string,
  opts: { preferSpeed?: boolean } = {},
): string {
  // `whisperLanguageCode` maps a registry code to what Whisper calls it; English is the one
  // case where a different model is genuinely better rather than merely faster.
  const whisper = whisperLanguageCode(code, 'faster-whisper');
  if (whisper === 'en') return DEFAULT_ENGLISH_MODEL;
  return opts.preferSpeed ? PREFER_SPEED_MODEL : DEFAULT_MODEL;
}

export function createFasterWhisperProvider(
  options: FasterWhisperProviderOptions = {},
): TranscriptionProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return {
    id: 'faster-whisper',
    label: 'faster-whisper (self-hosted)',

    capabilities: (model) => fasterWhisperCapabilities(model),

    supportsLanguage(code: string): ProviderLanguageCapability | null {
      return PROVIDER_MATRIX[code]?.['faster-whisper'] ?? null;
    },

    /**
     * Never `null` for a code Whisper knows.
     *
     * Unlike OpenAI, there is no model here that returns no timestamps, so
     * `requireWordTimestamps` cannot make this unanswerable. Unlike Groq, nothing is marked
     * `measured-failure` yet — **and that is a statement about missing evidence, not about
     * quality.** Every row is `evidence: "assumed"` until Phase 5 measures it, which is
     * exactly the work queue this provider was built to give the harness.
     */
    resolveModel(code: string): string | null {
      const capability = PROVIDER_MATRIX[code]?.['faster-whisper'];
      if (capability && capability.supported === false && capability.verdict === 'measured-failure') {
        return null;
      }
      return resolveFasterWhisperModel(code, { preferSpeed: options.preferSpeed ?? false });
    },

    isConfigured(cfg: ProviderConfig): boolean {
      const config = cfg as FasterWhisperConfig;
      return Boolean(config.baseUrl && config.stageAudio);
    },

    costModel(_mode: RunMode): CostModel {
      return {
        usdPerMinute: USD_PER_MINUTE,
        source: 'self-hosted: no per-minute charge. The cost is the machine — see Phase 15.',
      };
    },

    async transcribe(cfg: ProviderConfig, req: TranscribeRequest): Promise<TranscribeResult> {
      const config = cfg as FasterWhisperConfig;
      if (!config.baseUrl) {
        throw new NotConfiguredError(
          'SIDECAR_URL is not set, so this instance cannot run faster-whisper.',
          { hint: 'Start the sidecar and set SIDECAR_URL, or use --provider google.' },
        );
      }
      const model = req.model ?? config.model ?? DEFAULT_MODEL;
      const url = (path: string): string => new URL(path, config.baseUrl).toString();

      const staged = await config.stageAudio(req.audio.path);
      try {
        const submitted = await fetchImpl(url('/v1/transcribe'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // One transcription per chunk request. There is only ever one chunk, because
            // `syncMaxSeconds` is Infinity — see `capabilities`.
            idempotency_key: `${req.audio.path}:${req.offsetMs}:asr`,
            audio_url: staged.url,
            expected_duration_ms: req.durationMs,
            language: whisperLanguageCode(req.languageCode, 'faster-whisper'),
            model,
            compute_type: config.computeType ?? 'int8',
            beam_size: config.beamSize ?? 5,
            word_timestamps: true,
            vad_filter: true,
            vad_min_silence_ms: config.vadMinSilenceMs ?? 500,
            ...(options.prompt ? { initial_prompt: options.prompt } : {}),
            // 12x realtime with a 10-minute floor, the same shape as diarization's deadline
            // and for the same reason: the alternative to a generous deadline is killing a
            // job at hour six having already paid for all of it.
            deadline_s: Math.max(600, Math.ceil((req.durationMs * 12) / 1000)),
          }),
          ...(req.signal ? { signal: req.signal } : {}),
        });

        if (submitted.status === 429) {
          const retryAfter = Number(submitted.headers.get('retry-after') ?? 60);
          // Very likely a diarization of this same file: one slot serves both workloads, so
          // a `--diarize --provider faster-whisper` run serialises rather than overlapping.
          throw new SidecarBusyError(Number.isFinite(retryAfter) ? retryAfter : 60);
        }
        if (!submitted.ok) {
          const text = (await submitted.text()).slice(0, 300);
          if (submitted.status >= 500) {
            throw new ProviderUnavailableError(`sidecar returned HTTP ${submitted.status}: ${text}`);
          }
          throw new ProviderError(`sidecar rejected the request: ${text}`, submitted.status);
        }

        const { task_id: taskId } = (await submitted.json()) as { task_id: string };
        req.logger.info({ taskId, model }, 'faster-whisper task accepted');

        for (;;) {
          await sleep(pollIntervalMs);
          const polled = await fetchImpl(url(`/v1/tasks/${taskId}`), {
            ...(req.signal ? { signal: req.signal } : {}),
          });
          if (!polled.ok) {
            throw new ProviderUnavailableError(`polling the sidecar returned HTTP ${polled.status}`);
          }
          const status = (await polled.json()) as WireStatus;

          if (status.state === 'succeeded' && status.result) {
            return toTranscribeResult(status.result, req);
          }
          if (status.state === 'succeeded') {
            throw new ProviderError(`task ${taskId} succeeded with no result`);
          }
          if (status.state === 'failed' || status.state === 'lost' || status.state === 'cancelled') {
            const error = status.error;
            const message = error ? `${error.code}: ${error.message}` : status.state;
            // `model_unavailable` is the one an operator can act on, and the action is a
            // command rather than a shrug.
            if (error?.code === 'model_unavailable') {
              throw new NotConfiguredError(`the sidecar could not load ${model}: ${error.message}`, {
                hint: `Pre-download it with: thibi models pull ${model}`,
              });
            }
            if (error?.retryable) {
              throw new ProviderUnavailableError(`faster-whisper ${status.state} — ${message}`);
            }
            throw new ProviderError(`faster-whisper ${status.state} — ${message}`);
          }
          if (status.progress !== null && status.progress !== undefined) {
            req.logger.debug({ taskId, progress: status.progress }, 'faster-whisper progress');
          }
        }
      } finally {
        // Always. A scratch object per failed run is a bucket that grows without anybody
        // deciding it should.
        await staged.release().catch(() => undefined);
      }
    },
  };
}

function toTranscribeResult(result: WireResult, req: TranscribeRequest): TranscribeResult {
  const segments: ProviderSegment[] = result.segments.map((segment) => {
    const words: ProviderWord[] = segment.words.map((word) => ({
      startMs: req.offsetMs + word.start_ms,
      endMs: req.offsetMs + word.end_ms,
      text: word.word,
      // **The real one.** Passed through untouched: it is already a probability in [0,1],
      // and there is no `exp()` or clamp to apply the way there is to `avg_logprob`.
      confidence: word.probability,
    }));
    return {
      startMs: req.offsetMs + segment.start_ms,
      endMs: req.offsetMs + segment.end_ms,
      text: segment.text,
      // Segment level stays `exp(avg_logprob)` clamped, shared with the HTTP Whisper
      // providers so the rule lives in exactly one place.
      confidence: segmentConfidence(segment.avg_logprob ?? undefined),
      words,
    };
  });

  const withWords = segments.filter((s) => s.words.length > 0).length;
  const wordTimingQuality: WordTimingQuality =
    segments.length === 0 || withWords === 0
      ? 'none'
      : withWords === segments.length
        ? 'full'
        : 'partial';

  const warnings: Array<{ code: string; message: string }> = [];
  if (wordTimingQuality !== 'full' && segments.length > 0) {
    warnings.push({
      code: 'no_word_timings',
      message:
        wordTimingQuality === 'none'
          ? 'faster-whisper returned no word offsets; word timings will be interpolated.'
          : `${segments.length - withWords} of ${segments.length} segments came back without word offsets.`,
    });
  }
  // Autodetect returning the wrong language at full confidence is the failure Phase 4a
  // measured on Groq, where Burmese came back as Vietnamese at HTTP 200. It is not
  // detectable from the envelope, so the *disagreement* is what gets surfaced.
  const asked = whisperLanguageCode(req.languageCode, 'faster-whisper');
  if (asked && result.language && result.language !== asked) {
    warnings.push({
      code: 'language_mismatch',
      message:
        `faster-whisper reports the audio is '${result.language}' but '${asked}' was requested. ` +
        'The transcript may be in the wrong language; nothing in the response distinguishes ' +
        'that from a correct one.',
    });
  }

  return {
    segments,
    wordTimingQuality,
    usage: { audioMs: result.audio_duration_ms, requests: 1 },
    raw: result,
    warnings,
  };
}
