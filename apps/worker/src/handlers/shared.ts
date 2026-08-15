import type { RunStepRow } from '@thibi/db';
import { extensionOf, toTempFile, type TempFile } from '@thibi/storage';
import {
  NotConfiguredError,
  loadRunContext,
  normalizedKeyFor,
  type EngineContext,
  type RunContext,
} from '@thibi/engine';
import { buildProvider, readEnvironment, type BuiltProvider } from '@thibi/runtime';

/**
 * What every handler does before it does anything specific.
 *
 * A handler receives a `run_steps` row, an `EngineContext` and an `AbortSignal`, and the three
 * things it invariably needs next are the same: the run's context, a context carrying the
 * *step's* signal rather than the process's, and — for the ASR kinds — a provider built from
 * the run's `provider_id` and `model`.
 */

/**
 * Re-bind the context to this step's abort signal.
 *
 * `ctx.signal` is the worker's shutdown signal; `withHeartbeat` hands the handler a signal that
 * fires on that **or** on a stolen lease. Every engine stage reads `ctx.signal` — `cutChunk`
 * passes it to ffmpeg, `probe` to ffprobe — so a handler that forgot this would keep grinding
 * on a chunk whose lease another worker already holds, and both copies would write a result.
 */
export function withSignal(ctx: EngineContext, signal: AbortSignal): EngineContext {
  return { ...ctx, signal };
}

export interface StepRun {
  run: RunContext;
  /** The context to pass to every engine stage: it carries the step's signal. */
  ctx: EngineContext;
}

export async function openStep(
  ctx: EngineContext,
  step: RunStepRow,
  signal: AbortSignal,
): Promise<StepRun> {
  const run = await loadRunContext(ctx, step.runId);
  return { run, ctx: withSignal(ctx, signal) };
}

export type ProviderFor = (ctx: EngineContext, run: RunContext) => Promise<BuiltProvider>;

/**
 * What a handler needs that is not on the `EngineContext`.
 *
 * One field today, and it exists to be replaceable. Building a provider means reading
 * `OPENAI_API_KEY` and friends, so a handler that reached for `providerFor` directly would be a
 * handler no test could run without an API key and a network — which is the question amendment
 * 75 says to ask of every dependency that is imported rather than injected: *what can no longer
 * be tested because of it?*
 */
export interface HandlerDeps {
  providerFor: ProviderFor;
}

export function defaultDeps(): HandlerDeps {
  return { providerFor };
}

/**
 * Build the provider this run was created with.
 *
 * `requireWordTimestamps: false` on purpose, and it is not a relaxation of the support gate.
 * The gate ran at run creation, where a user could still be told "OpenAI cannot transcribe this
 * language with timestamps — try google" and choose something else. By the time a worker picks
 * up an `asr.chunk`, `runs.model` records the model that decision produced, and re-resolving it
 * here could quietly pick a *different* model than the one the run was priced and planned
 * against. The run row is the decision; this rebuilds it rather than re-taking it.
 */
export async function providerFor(ctx: EngineContext, run: RunContext): Promise<BuiltProvider> {
  return buildProvider({
    id: run.providerId,
    env: readEnvironment(),
    settings: ctx.settings,
    languageCode: run.languageCode,
    model: run.model,
    requireWordTimestamps: false,
    store: ctx.store,
  });
}

/** The run's source audio, on this box's disk. Disposable — always `await using`. */
export async function fetchAsset(ctx: EngineContext, run: RunContext): Promise<TempFile> {
  return toTempFile(ctx.store, ctx.tmp, run.asset.storageKey, extensionOf(run.asset.filename));
}

/**
 * The normalized derivative, on this box's disk.
 *
 * Its absence is a programming error rather than a provider failure: `media.normalize` is a
 * required dependency of every step that calls this, so a miss means the DAG was violated, and
 * retrying five times will not produce one. Deliberately **not** a re-derive on miss — that
 * would turn one broken dependency into eight concurrent ffmpeg runs over the same hour of
 * audio, which reads as slowness rather than as the error it is.
 */
export async function fetchNormalized(ctx: EngineContext, run: RunContext): Promise<TempFile> {
  const key = await normalizedKeyFor(ctx, run.asset.id);
  if (!key) {
    throw new NotConfiguredError(
      `Run ${run.runId} has no normalized derivative, but a step that needs one was scheduled.`,
      {
        hint:
          'media.normalize did not run, or its media_derivatives row was deleted. Re-plan the ' +
          'run, or check whether RECIPE_VERSION changed under it.',
      },
    );
  }
  return toTempFile(ctx.store, ctx.tmp, key, '.flac');
}
