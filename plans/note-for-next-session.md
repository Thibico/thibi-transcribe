# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-11, after Phase 8 merged.

---

## Where the build is

`main` is at the merge of PR #6. CI is green. Everything below is merged, not in flight.

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **not started.** Premises measured — see S6 below |
| 4 — Whisper providers | not started |
| 5–7, 9–15 | not started |
| **8 — ingest** | **engine + CLI done; web routes deliberately not built** |

Phase 8 was taken out of build order on purpose: it only needs Phases 0–2, so it fit a single
session while Phase 3 does not.

---

## Do this next

**Recommended: Phase 4a — OpenAI and Groq only.**

[`phase-04-whisper-providers.md`](./phase-04-whisper-providers.md) is really two things sharing
a file. `whisper-http.ts` (multipart + `verbose_json`, pure HTTP) needs nothing but
`OPENAI_API_KEY` and `GROQ_API_KEY`, both already in `.env`. `faster-whisper.ts` runs on Phase
3's sidecar and splits off cleanly. The HTTP half is one session.

Before starting, note the plan's chunk arithmetic was corrected on 2026-08-10: the byte budget
is ~18.9 KB/s measured, **not** the ~110 KB/s the plan originally assumed, so OpenAI's 25 MB cap
binds at about 22 minutes rather than 230 seconds. What binds first has to be chosen
deliberately rather than inherited from that sentence.

**Alternative: Phase 3 — diarization.** Budget two sessions. S6 already answered the hardware
question, so they go on the sidecar image and the reconciliation algorithm rather than on
discovering a product constraint.

---

## What you would otherwise rediscover

**The plans predate the code in places.** Phase 8's plan told us to build four things Phase 1
had already built (`putStream` hashing, `abortMultipart`, a settings namespace that does not
exist, and four `media_assets` columns). **Check the code before implementing a deliverables
table.** Expect the same in Phases 3–7 and amend the plan when you find it.

**`SettingsPort` is a flat key/value port.** Any plan that reads `ctx.settings.<namespace>.<key>`
is wrong. Limits and configuration arrive as explicit input to a stage — the engine's lint rule
forbids reading ambient configuration.

**Two storage key schemes coexist deliberately.** Phase 1 writes content-addressed
`assets/{sha[0:2]}/{sha}/source.{ext}`; Phase 8 writes `media/{uuid}/source.{ext}`, because a
streamed upload does not know its hash until the last byte. Do not unify them without moving
the `delete` on the dedupe path in `ingest/upload.ts` — under content-addressing the loser of a
race writes the same bytes to the same key, so that delete would remove the winner's object.

**Diarization must never gate the transcript.** ASR finishes a 1-hour file in about a minute;
diarization takes ~1 h 40 m. `diarize` is its own `run_steps` row. This is written into
[`phase-03-diarization.md`](./phase-03-diarization.md) §6 as an invariant.

**Test-DB templates are per process.** `packages/db/src/testing.ts` names them
`thibi_test_template_${pid}` and sweeps dead pids. Adding a DB-backed suite is safe; adding one
that shares a template name is not.

**Run the thing, do not only unit-test it.** Every phase so far found defects only by execution:
Phase 1's seam window, Phase 2's 192 kHz normalize bug, Phase 8's estimate showing one filename
twice and promising jobs it would not create. Budget time for a live run against Postgres,
MinIO and the real provider.

---

## Open questions the user has to answer

1. **Typical recording length and deadline pressure** for the target newsrooms. This decides
   whether a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell. Recorded as open in Phase 3 and Phase 15 rather than guessed.
2. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed
   against the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Belongs to
   Phase 14.

---

## Known debt, recorded not hidden

- **`GENERATED_AT` is misnamed.** It now means "the date of the freshest input", not generation
  time. The honest name is `DATA_AS_OF`, but it is exported from `@thibi/languages`, mirrored in
  `ResolvedRegistry.generatedAt` and printed by `thibi --version` — an API change nobody has
  made yet.
- **Phase 8's web routes are not built.** `/api/uploads`, `/api/ingest/batch` and `/api/imports`
  wait on Phase 10's auth and Phase 11's UI. The engine functions they will call are done and
  tested.
- **A live URL *download* has never been run** end to end — only `--resolve-only`.
- **The 2 GB flat-RSS memory test** in Phase 8's Definition of done is not in CI.
- **pyannote's GPU figure (8–20×) is inherited and unmeasured**, and is marked do-not-publish in
  Phase 15's tier table until someone measures it.

---

## Environment notes

- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN` and the provider
  credentials. `.env.example` documents all of them.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check the result
  afterwards, they can see it.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
  The Linux sidecar is not subject to that.
