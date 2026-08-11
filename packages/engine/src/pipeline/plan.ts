import type { RunMode } from '@thibi/core';
import type { ProviderCapabilities } from '../providers/types.js';

/**
 * Which mode a run uses, and why.
 *
 * **There is no duration threshold, and that is the finding this file encodes.** The design
 * originally routed files over fifteen minutes to `batchRecognize`, on the reasoning that
 * batch amortises its queue latency on long audio while short files finish faster as
 * parallel sync chunks. Spike S3 measured it and the premise is false:
 *
 * | input | batchRecognize   | chunked sync, concurrency 8 | sync advantage |
 * |-------|------------------|-----------------------------|----------------|
 * | 30 min| 305 s (5.9x RT)  | 43 s                        | 7.1x           |
 * | 2 h   | 1211 s (5.94x RT)| 338 s                       | 3.6x           |
 *
 * Batch throughput is flat at 5.9x realtime, so the two curves never cross. There is no
 * duration at which batch is faster, therefore no duration at which the engine should pick
 * it on its own. What batch *is* worth is money — $0.003/min against $0.016, confirmed from
 * the Cloud Billing Catalog (spike S5) — and only a human knows whether this particular job
 * wants five hours less latency or five times less cost.
 *
 * So `batch` is reachable **only** through `force`. `--mode batch` is that human today;
 * Phase 8's overnight importer and Phase 11's "cheaper, slower" checkbox are the same seam.
 */

export interface PlanInput {
  /** `null` when ffprobe could not determine it — which routes conservatively. */
  durationMs: number | null;
  bytes: number;
  caps: ProviderCapabilities;
  stagingConfigured: boolean;
  force?: RunMode;
}

export interface PlanWarning {
  code: 'duration_unknown';
  message: string;
}

export interface PlanDecision {
  mode: RunMode;
  /**
   * Printed by the CLI on every run and stored in `runs.pipeline.planReason`. "Why did it
   * pick this?" should never require reading code.
   */
  reason: string;
  warnings: PlanWarning[];
}

/** Not retryable: the operator asked for something this configuration cannot do. */
export class ModeUnavailableError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ModeUnavailableError';
  }
}

export function planMode(input: PlanInput): PlanDecision {
  const { caps, durationMs, bytes } = input;
  const warnings: PlanWarning[] = [];

  const syncMaxMs = caps.limits.syncMaxSeconds * 1000;
  const seconds = durationMs === null ? null : Math.round(durationMs / 1000);

  if (durationMs === null) {
    warnings.push({
      code: 'duration_unknown',
      message:
        'ffprobe could not determine the duration, so the file is chunked rather than sent ' +
        'as a single request. Cost estimates for it are unavailable.',
    });
  }

  // ---- forced --------------------------------------------------------------------------
  if (input.force !== undefined) {
    const mode = input.force;

    if (!caps.modes.includes(mode)) {
      throw new ModeUnavailableError(
        `This provider does not support --mode ${mode}. It supports: ${caps.modes.join(', ')}.`,
      );
    }

    if (mode === 'batch') {
      if (!input.stagingConfigured) {
        // A hard error, not a downgrade. Nothing about duration selects batch any more, so
        // there is nothing to fall back *from* — and quietly substituting a mode the user
        // did not ask for, at 5.3x the price, is worse than saying no.
        throw new ModeUnavailableError(
          '--mode batch needs a GCS staging bucket. Set google_gcs_staging_bucket (see\n' +
            '`thibi settings set google_gcs_staging_bucket <name> --check`), or drop\n' +
            '--mode batch: chunked sync handles any length and spike S3 measured it 3.6-7x\n' +
            'faster. It costs 5.3x more.',
        );
      }
      return {
        mode,
        reason: 'requested explicitly; 5.3x cheaper than sync and about 5.9x realtime',
        warnings,
      };
    }

    if (mode === 'sync' && (durationMs === null || durationMs > syncMaxMs)) {
      throw new ModeUnavailableError(
        `--mode sync sends the whole file in one request, and this provider's limit is ` +
          `${caps.limits.syncMaxSeconds}s. ` +
          (durationMs === null
            ? 'The duration could not be determined.'
            : `This file is ${seconds}s. Use --mode sync_chunked, or omit --mode.`),
      );
    }
    if (mode === 'sync' && bytes > caps.limits.syncMaxBytes) {
      throw new ModeUnavailableError(
        `--mode sync exceeds this provider's ${mb(caps.limits.syncMaxBytes)} request limit ` +
          `(${mb(bytes)}). Use --mode sync_chunked, or omit --mode.`,
      );
    }

    return { mode, reason: `requested explicitly with --mode ${mode}`, warnings };
  }

  // ---- automatic: only ever sync or sync_chunked ----------------------------------------
  const fitsOneRequest =
    durationMs !== null && durationMs <= syncMaxMs && bytes <= caps.limits.syncMaxBytes;

  if (fitsOneRequest) {
    return {
      mode: 'sync',
      // A provider with no request ceiling gets a sentence rather than the number, because
      // the number is `Infinity` and `"11s fits one Infinitys request"` is what a user saw
      // the first time faster-whisper ran — it takes the whole file, so there is no limit to
      // quote. Found by running it, 2026-08-12.
      reason: Number.isFinite(caps.limits.syncMaxSeconds)
        ? `${seconds}s fits one ${caps.limits.syncMaxSeconds}s request`
        : `${seconds}s in one request — this provider takes the whole file`,
      warnings,
    };
  }

  // Name batch without recommending it. An operator reading this should be able to tell
  // another mode exists and that not choosing it was deliberate, not an oversight.
  const why =
    durationMs === null
      ? 'the duration is unknown'
      : durationMs > syncMaxMs
        ? `${seconds}s exceeds the ${caps.limits.syncMaxSeconds}s sync limit`
        : `${mb(bytes)} exceeds the ${mb(caps.limits.syncMaxBytes)} request limit`;

  return {
    mode: 'sync_chunked',
    reason: `${why}; batch was not requested`,
    warnings,
  };
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
