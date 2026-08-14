/**
 * The LLM layer.
 *
 * Phase 5 builds only the prompts, and builds them *here* rather than in `packages/eval` for
 * one reason, stated in §6.5: **the harness imports the real prompt and never holds a string
 * of its own.** A copy would drift within a month and the gate would be measuring text that
 * nobody ships. This is why the dependency direction is `engine ← eval`.
 *
 * The gateway (§6.1), the pass runner (§6.2) and the entities and document prompts are Phase
 * 6 and are not here. What Phase 6 replaces is the prompt *text*, not this interface.
 */

export {
  buildCleanupPrompt,
  CLEANUP_CURRENT,
  CLEANUP_RESTRAINT,
  CLEANUP_VERSIONS,
  type BuildCleanupInput,
  type CleanupVariant,
} from './prompts/cleanup.js';

export {
  buildTranslatePrompt,
  TRANSLATE_DEFAULT,
  TRANSLATE_VERSION,
  type BuildTranslateInput,
} from './prompts/translate.js';

export {
  casingRule,
  marksLine,
  promptVars,
  spacingRule,
  UnknownLanguageError,
  type PromptLanguageVars,
} from './prompts/vars.js';

export { renderSegments, type LlmPrompt, type PromptSegment } from './prompts/types.js';
