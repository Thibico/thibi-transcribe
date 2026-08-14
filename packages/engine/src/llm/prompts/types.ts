/**
 * What a prompt builder returns.
 *
 * `promptId` and `promptVersion` travel with the text rather than being looked up beside it,
 * because they are what the Phase 5 response cache keys on: `paramsHash` includes both, so a
 * bumped prompt is a genuine cache miss and the CI gate cannot pass on numbers the previous
 * prompt produced. A builder that returned only strings would make that key impossible to
 * compute without a second table to keep in step.
 */
export interface LlmPrompt {
  /** `cleanup.restraint`, `translate.default`. Stable across versions. */
  promptId: string;
  /** Bumped whenever the rendered text changes. A guard test enforces it. */
  promptVersion: number;
  system: string;
  /** The JSON envelope. Always `{"segments":[{"idx":…,"text":…}]}`. */
  user: string;
}

/**
 * One item of work, keyed by `idx`.
 *
 * `idx` is not a position: a response that comes back short or reordered updates only what it
 * actually covered rather than shifting text onto the wrong timestamps. Phase 6's pass runner
 * matches on it, and the eval harness uses the same envelope so that what is measured is the
 * shape the product sends.
 */
export interface PromptSegment {
  idx: number;
  text: string;
}

/**
 * The envelope, built in one place.
 *
 * Compact and key-ordered, because it is hashed into the response cache key: a formatting
 * change here would silently invalidate every cached LLM response in the tree.
 */
export function renderSegments(segments: readonly PromptSegment[]): string {
  return JSON.stringify({ segments: segments.map((s) => ({ idx: s.idx, text: s.text })) });
}
