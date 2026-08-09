// Providers, audio, pipeline, diarize+reconcile, LLM passes, glossary, ingest, queue
// handlers, settings/secrets. Every stage is (ctx, input) => Promise<output> and the
// engine never reads process.env. Phase 1 onward.
//
// Placeholder: this package exists now so the dependency graph — and the ESLint
// rule that enforces its direction — is real from the first commit.

export {};
