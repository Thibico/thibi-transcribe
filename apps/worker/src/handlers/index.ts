import type { HandlerRegistry } from '@thibi/engine';

/**
 * One handler per step kind, each a thin wrapper over a Phase 1–8 stage function.
 *
 * A handler receives `(ctx, step, signal)` and returns a `StepResult`. It never touches
 * pg-boss, never calls `reconcile`, and never decides its own retry — those belong to the
 * doorbell, the reconciler and `runStep` respectively, and mixing them is how a step ends up
 * retried by two mechanisms that disagree about how many times it has run.
 *
 * **Deliberately empty for now.** The registry exists so the shape is real and so the
 * worker's "unknown kind" path is exercised rather than theoretical; a step routed to a kind
 * with no handler lands `dead` with a message naming the kind, which is the right answer for
 * a worker built before that kind existed. Filling it in is the next commit, starting with
 * `media.probe` → `media.normalize` → `plan.chunks` → `asr.chunk`, which together are a
 * complete chunked run.
 */
export function createHandlerRegistry(): HandlerRegistry {
  return {};
}
