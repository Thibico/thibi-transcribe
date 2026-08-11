# thibi-transcribe — implementation plans

**Picking up after a break? Read
[note-for-next-session.md](./note-for-next-session.md) first** — where the build actually is,
what to do next, and the traps already paid for once. It is rewritten at the end of every
session and is the only document here that is allowed to delete what stopped being true.

Then **[00-overview.md](./00-overview.md)** — context, confirmed decisions, architecture,
data model, and the build order. Everything below is a detailed execution plan for one phase of
that order.

Phases 0–9 build the engine and are fully exercised by the `thibi` CLI. Phases 11–14 add the UI
on top. Phase 15 makes it deployable.

| # | Plan | Ends with |
|---|---|---|
| 0 | [Spikes and registries](./phase-00-spikes-and-registries.md) | Three de-risking questions answered; `thibi lang list` |
| 1 | [Engine core, Google sync, CLI](./phase-01-engine-core.md) | `thibi transcribe f.m4a --lang my` → JSON with word timings |
| 2 | [batchRecognize + GCS staging](./phase-02-batch-recognize.md) | `thibi transcribe 2hr.mp3 --mode batch` |
| 3 | [Diarization and reconciliation](./phase-03-diarization.md) | `thibi transcribe interview.wav --diarize` |
| 4 | [Whisper providers](./phase-04-whisper-providers.md) | `thibi transcribe --provider faster-whisper` |
| 5 | [FLEURS eval harness](./phase-05-eval-harness.md) | `tiers.json`; CI gate on the cleanup control |
| 6 | [LLM editorial passes](./phase-06-llm-passes.md) | Cleanup measurably better than doing nothing |
| 7 | [Export, reflow, bidi](./phase-07-export.md) | `thibi export <run> --format srt --layer translated` |
| 8 | [Ingest: batch and URL](./phase-08-ingest.md) | `thibi ingest --url`, `thibi ingest ./dir` |
| 9 | [Queue, worker, progress](./phase-09-queue-and-worker.md) | Kill the worker mid-run; it resumes |
| 10 | [Auth, settings, secrets](./phase-10-auth-and-settings.md) | `/setup` → admin → keys in the browser |
| 11 | [UI shell, upload, language picker](./phase-11-ui-shell.md) | Upload → run → watch progress |
| 12 | [UI segment editor](./phase-12-ui-editor.md) | Edit a 90-minute transcript without lag |
| 13 | [UI speakers, glossary, export](./phase-13-ui-speakers-glossary.md) | Rename a speaker; add a term from the editor |
| 14 | [UI settings and admin](./phase-14-ui-settings-admin.md) | Configure the instance without a terminal |
| 15 | [Deployment and operations](./phase-15-deployment.md) | `./thibi init && ./thibi up -d` on a clean VPS |

## Reference material

The existing app being generalised lives at `~/Coding_work/myanmar-transcription`. Its
`research/` directory holds three documents that these plans depend on and that are not
reproduced in full here:

- `language-expansion-recommendations.md` — the strategic case, the cleanup-prompt regression,
  the FLEURS tiering methodology, and the Burmese calibration numbers.
- `language-support-whisper-vs-google.md` — the raw provider/language probe results.
- `deep-research-report-GPT-myanmar-transcription.md` — pipeline and QA background.

## Conventions used in the phase plans

- **Port verbatim** means copy the code and adjust imports only; the comments in the original
  encode real operational findings and should travel with it.
- File paths given as `lib/foo.ts:123` refer to the old repo; paths given as
  `packages/foo/src/bar.ts` refer to this one.
- Each plan ends with a **Definition of done** that is checkable without reading the code.
