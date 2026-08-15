// @thibi/runtime — the composition root the apps share.
//
// Not an app: it is what `apps/cli`, `apps/worker` and `apps/web` compose *with*. It lives
// under `apps/` rather than `packages/` because reading the environment is an application
// concern by construction here — an ESLint rule bans `process.env` throughout
// `packages/*/src`, and the right response to needing an env reader in two apps was to give
// them one to share, not to carve an exemption into an architectural rule.

export {
  buildContext,
  createLoggingEvents,
  createRuntimeLogger,
  readEnvironment,
  resolveServiceAccountJson,
  resolveTempRoot,
  serviceAccountEmailOf,
  type BuildContextOptions,
  type EnvKey,
  type RuntimeContext,
} from './context.js';
