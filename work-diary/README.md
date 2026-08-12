# Work diary

One file per working day, `YYYY-MM-DD.md`, covering every commit made that day.

Each entry answers *what was worked on, what materially changed, and why* — and links the
commit to the plan document it executes against, so a phase plan and the code that
implemented it can be read together months later. Commit messages carry the reasoning;
this is the day-level narrative that connects them and records what the plans got wrong.

Written after the commits, not instead of them. If a day produced no commits it gets no
file.

| Date | Covers |
|---|---|
| [2026-08-09](./2026-08-09.md) | Repo created · 16 plan documents · Phase 0 spikes · Phase 0 monorepo, language registry, CLI and live provider probe |
| [2026-08-10](./2026-08-10.md) | Phase 1 engine: core primitives, storage port, database schema, audio stages, seam merge, Google provider, pipeline and `thibi transcribe` · Phase 2 batch: the staging port, `batchRecognize`, routing corrected against spike S3, and the 192 kHz normalize bug |
| [2026-08-11](./2026-08-11.md) | Phase 8 merged and the session-handoff convention · Phase 4a: the shared Whisper HTTP transport, OpenAI and Groq, script integrity, `chooseProvider`, and four defects that only running it found · Phase 3 begun: spike S7 kills the hosted-diarizer alternative, then the reconciler, the Hungarian matcher, the speaker schema and the sidecar · Phase 3's seam and surface: `persist.ts`, the diarize stage, `thibi speakers`, `thibi diarize` — and a rename-survives demo that ran against a stand-in and, as 2026-08-12 found, would not have passed against the real thing |
| [2026-08-12](./2026-08-12.md) | The presigned-URL host gap, and the identity matching it exposed as never having run through any path a user has — plus the plan's own demo, which passed while proving nothing · `thibi transcribe --job <id>` and the guard that makes it safe · the sidecar contract test, run against the real model rather than the canned pipeline the plan asked for · Phase 5's metrics layer: CER, WER, chrF2, the scoring normalizer and the seeded bootstrap, frozen against real `jiwer` 4.0.0 / `sacrebleu` 2.6.0 numbers — and six amendments, including a grapheme cluster that is not a Burmese syllable |
