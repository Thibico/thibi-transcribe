import {
  buildContext as buildRuntimeContext,
  type BuildContextOptions,
  type RuntimeContext,
} from '@thibi/runtime';
import { DEFAULT_GOOGLE_MODEL, DEFAULT_GOOGLE_REGION } from './config.js';

/**
 * The CLI's flavour of the shared composition root.
 *
 * The builder itself moved to `@thibi/runtime` when Phase 9 needed a worker that assembles
 * the same `EngineContext`. This file is what stops that move from touching a dozen command
 * modules: it supplies the two things that are genuinely CLI-specific — the Postgres
 * `application_name` and the Google region/model defaults — and re-exports the rest under the
 * names those modules already import.
 */
export {
  createRuntimeLogger as createCliLogger,
  createLoggingEvents as createCliEvents,
  readEnvironment,
  resolveServiceAccountJson,
  resolveTempRoot,
  serviceAccountEmailOf,
  type EnvKey,
} from '@thibi/runtime';

export type CliContext = RuntimeContext;

/** Everything `buildContext` needs except what makes it the CLI rather than the worker. */
export type CliBuildOptions = Omit<BuildContextOptions, 'appName' | 'googleDefaults'>;

export function buildContext(options: CliBuildOptions): Promise<RuntimeContext> {
  return buildRuntimeContext({
    ...options,
    appName: 'thibi-cli',
    googleDefaults: { region: DEFAULT_GOOGLE_REGION, model: DEFAULT_GOOGLE_MODEL },
  });
}
