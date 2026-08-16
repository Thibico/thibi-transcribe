# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-16. **Both ASR shapes and speaker attribution now run through a real
worker.** Twelve of fifteen step kinds have handlers; only `media.peaks`, `editorial.pass` and
`export` are left, and none of them is a new *shape*.

**Read the first item under "Do this next" before anything else: a poll chain stalled for two
hours during a live diarization and I could not explain it.** It cost a diarization that was
64% done and on track to finish. A defensive fix is in, but whether it was *the* cause is not
established.

Two branches are open and stacked:
- **`phase-9/batch-handlers`** → PR **#39**, open against `main`, unmerged.
- **`phase-9/diarize-handlers`** → stacked on it, **not pushed and no PR**. A stacked PR merges
  into its base, not into `main`.

`main` is still at the merge of PR #38.

> **The eval work stays parked.** The CI gate is manual-dispatch only, `thibi eval translate`
> stays unrun, `--manifest` stays unbuilt. **Do not pick those up as "next" unless asked.**

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| 3 — diarization | done. `scribe.ts` descoped (amendment 48) |
| 4 — Whisper providers | built end to end, barely measured. `large-v3` has never been loaded on this box |
| 5 — eval harness | ASR half published; LLM half built and measured once. **Parked by decision** |
| 6–7 | not started. 6 has measured evidence waiting for it |
| 8 — ingest | engine + CLI done; web routes deliberately not built |
| **9 — queue and worker** | **both ASR paths and diarization run on real audio through a real worker.** Editorial and export have no handlers; §10–12 are unbuilt. See the split below |
| 10–15 | not started |

### What Phase 9 has and has not got

**Built, tested, and run against real audio** — the tables and migration `0004`; in
`packages/engine/src/queue/`: `queues.ts`, `retry.ts`, `plan.ts`, `reconcile.ts`, `boss.ts`,
`lease.ts`, `run-step.ts`, `recover.ts`, `start.ts`, `run-context.ts`;
`pipeline/chunk-result.ts`; `diarize/queue-persist.ts`; `@thibi/runtime`; `apps/worker` with
**twelve handlers** — `media.probe`, `media.normalize`, `plan.chunks`, `asr.chunk`,
`normalize.text`, `asr.batch.submit`, `asr.poll`, `asr.fetch`, `staging.cleanup`, `diarize`,
`diarize.poll`, `reconcile.speakers`; and `thibi runs start <jobId> [--mode batch] [--diarize
[--speakers N]]`.

**Not built** — handlers for `media.peaks`, `editorial.pass`, `export`. Also `queue/cancel.ts`
(the NOTIFY listener and `requestCancel`), `queue/rate-bucket.ts` (`takeTokens`),
`withGlobalSlot` for `asr.local`, the SSE route, `/api/admin/queue`, `thibi run
status|retry|cancel`, and the compose services. `apps/web` is still a stub.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **1283 tests across 83
files, nothing skipped**, with Postgres, MinIO and the sidecar up. Was 1256 across 81.

### What was actually measured

- **Batch, 16m37s Burmese, chirp_2, `asia-southeast1`**: one operation, `dynamicBatching: true`,
  5 polls, **317761 ms latency**, 35 segments, 2364 words, no placeholders,
  `wordTimingQuality=full`, staging swept (2 objects), **$0.04985** at the `batch_minute` SKU
  against Google's reported `totalBilledDuration` of `997s`.
- **`kill -9` at 63% of the operation**: restart logged `reclaimed=0 nudged=1` — the poll step
  correctly *not* reclaimed as a stale lease — and the same operation resumed and finished.
  **`submitBatch` called once.**
- **Chunked, same recording, 20 chunks** (first sitting): 40 segments, 2553 words, 19 seams
  merged, $0.2719.
- **Per-step retry with no re-billing**, both paths: `normalize.text` alone reassembled the
  whole transcript from the stored chunk artifacts, no provider call.
- **Drain**: SIGTERM mid-run, `graceful stop complete`, exit 0.
- **Diarization, 30 s clip, real sidecar**: 6 polls at a clean 16 s cadence, 13 turns, 2
  speakers persisted as `speaker-00`/`speaker-01`, 66 words attributed, run `done`.
- **Diarization with no `SIDECAR_URL`**: all three kinds `skipped`, run `done` with its
  transcript. Phase 3's founding invariant, demonstrated by accident.
- **Diarization, 2-minute clip: FAILED, and see the first item below.** 23 polls at 16 s
  reaching 63.6%, then no poll for 1 h 56 m, then the 24-minute deadline fired. The handler
  cancelled the sidecar task correctly and the run still finished with its transcript — but a
  diarization that was on track to succeed was lost.
- **Throughput is not measured.** Two contaminated probes that disagree in the wrong direction
  (0.44 on 30 s, ~0.14 on 2 min against a busy box), and S6's 0.6× was pyannote **3.1** where
  the sidecar now runs **4.0.7**. Quote none of them.

---

## Do this next

**First, and before any new feature: work out why the poll chain stalled.** During a live
2-minute diarization, `diarize.poll` ran 23 polls at a clean 16-second cadence over 9.3 minutes,
reached 63.6%, and then **nothing rang it for 1 hour 56 minutes**. When a poll finally arrived
the 24-minute deadline had passed; the handler cancelled the sidecar task (correctly) and the
step went `skipped`. The run still produced its transcript, so nothing is *wrong* with the
run — but a diarization that would have finished was thrown away, and the same mechanism would
throw away a two-hour `batchRecognize`.

What is established: both workers stayed alive, nothing logged an error, and no pg-boss job for
that step exists after the last poll — though v12 deletes completed jobs, so that table is not a
complete record. One send before the stall got a `start_after` 3m43s out where the handler
always asks for 15 s, which is unexplained on its own. The 30-second reconcile tick re-rings
`awaiting_external` steps and evidently did not.

`unstrandExternalWork` (new, runs every tick, sets `poll_after = now()` only where it is null)
closes the one mechanism I could *prove* would produce exactly this symptom. **Whether that was
the mechanism here is not established.** It did not reproduce on a 30-second clip. Suggested
approach: a long-running poll with the doorbell instrumented — log every `sendStep` and its
pg-boss return value, since `sendStep` currently discards it and a dropped send is therefore
invisible. **Making `sendStep` log when pg-boss returns null is probably the single highest-value
half-hour in this phase.**

**Then push and open the stacked PR** for `phase-9/diarize-handlers` against
`phase-9/batch-handlers`, and ask the user to merge #39 first.

Then, in this order: `queue/cancel.ts` and the `runs.cancel_requested_by` migration;
`withGlobalSlot` for `asr.local` only (see below); `rate-bucket.ts`; the SSE route and
`/api/admin/queue`, where `apps/web` stops being a stub. `editorial.pass` and `export` are the
only step kinds left and neither is a new shape.

### The alternative that was considered

Building the SSE route next, or `editorial.pass`. Both rejected for the same reason this time,
and it is a stronger one than the previous two sittings': **there is a known, unexplained defect
that silently discards hours of provider work.** Everything built on top of the queue inherits
it, and a progress bar over a run that has quietly stopped polling is worse than no progress bar,
because it makes the stall look like slowness. Fix the foundation first.

---

## What you would otherwise rediscover

**`reconcile` is the only thing that sends a step, and it must send `awaiting_external` ones
too.** Until this sitting it sent only `pending` (promoted) and `ready` (re-rung) steps, so
`awaiting_external` was a state a step could enter and never leave — while `runStep` claimed
`state in ('ready','awaiting_external')`, `run_steps` indexed `poll_after` for exactly that
predicate, and `StepResult` had the variant. All of it written for a caller that did not exist.
**Ask of any new step state: what sends it?** Amendment 97.

**A self-rescheduling step must always return a `pollAfter`.** The re-ring is predicated on it
precisely because a re-ring with no `startAfter` polls instantly, returns `awaiting_external`,
and is rung again — a tight loop against a provider.

**A step that another step depends on cannot end in `awaiting_external`.** Only `done` or
`skipped` satisfies a dependency. That is why `asr.batch.submit` ends `done` and the wait lives
on `asr.poll`, against what §7 sketched. Amendment 97.

**The boot nudge does not make the next poll immediate, and the plan says it does.** Measured:
after a `kill -9`, `run_steps.poll_after` was 35 s in the past while the queued pg-boss job
still started 27 s in the future. Polling never bumps `attempt`, so every poll shares one
singleton key, `reconcile` had already queued the next poll before the crash, and the boot
re-ring was dropped by the `short` policy. **The row says "poll now", the queue says "poll
later", and the queue wins.** The nudge is a repair for a doorbell the queue *lost*, not an
accelerator. Latency only. Amendment 98.

**`nudgeExternalWork` is boot-only.** `least(poll_after, now())` on a 60-second tick pulls every
scheduled poll back to now once a minute, flattening a 30 s → 300 s backoff to a flat 60 s.
`recoverTick(ctx, { nudgeExternal: true })` on boot; plain `recoverTick(ctx)` on the interval.

**Two correct fixes can leave a hole between them.** The boot-only nudge and the
`poll_after`-guarded re-ring are each right, and together they stranded any `awaiting_external`
step with a **null** `poll_after` — rung by nothing until a restart. `unstrandExternalWork` runs
every tick and sets `poll_after = now()` *only where it is null*, which is not a pull-forward and
so cannot flatten a backoff. **A non-zero `unstranded` in the boot log names a handler that
returned `awaiting_external` without a `pollAfter`.**

**`sendStep` discards pg-boss's return value, so a dropped send is invisible.** Under the `short`
policy `send` returns null when a job with that singleton key is already queued. That is usually
correct dedup — and it is also the shape of the unexplained stall above. Log it.

**§6's advisory-lock slots cannot bound `diarize`, and §7 is why.** `withGlobalSlot` is a session
lock held for the duration of the work it wraps; a step waiting on someone else's computer holds
no worker slot, so a lock around the submit releases while the GPU runs for hours, and no session
lock spans two steps in two processes. The sidecar's own 429 → `no_slot` is the mechanism that
works. **`GPU_SLOTS` is parsed and unused and should be deleted.** `LOCAL_ASR_SLOTS` is different
— `asr.chunk` on `asr.local` blocks its worker for the whole transcription — and is worth
building. Amendment 101.

**The diarize idempotency key is derived from the run id, not the step id.**
`diarizeStepKey(runId)`, because it must be reconstructible by a process that never saw the
submit response. §7 says `step.id`, which re-planning invalidates — and a resubmit under a new
key starts a second job on the only GPU. Amendment 99.

**A source reporting `progress: 0` used to score worse than one reporting nothing.**
`stepFraction` now floors at 0.1 rather than defaulting to it. The sidecar reports 0 for the
first minutes of every pyannote run, which is exactly when a user has least other evidence the
run is alive. Amendment 100.

**`SIDECAR_URL` is not in `.env`**, even though the sidecar container is up on 8081. Export it
explicitly for any diarization work: `export SIDECAR_URL=http://localhost:8081`.

**`diarize` is a `worker-heavy` queue, and the default worker does not subscribe to it.** A
diarized run needs a second process: `WORKER_QUEUES="diarize,asr.local" WORKER_HEALTH_PORT=8091`.
Without it `diarize` sits `ready` forever and nothing says why.

**`diarize` is planned in the second pass on a chunked run**, because the early return for an
unknown chunk count precedes it. It depends only on `media.normalize`, so nothing about it needs
the count — it just starts one short step later than the DAG implies. Left alone deliberately;
see the comment in `planRun`.

**`provider.costModel(mode)` ignores the mode it is handed.** Google's is literally
`costModel(_mode)` returning $0.016/min for every mode, where a Dynamic Batch minute is $0.003
— so a batch run's `runs.cost_usd` was 5.3× the truth, sitting beside a correct
`usage_records` row. **`runs.cost_usd` now comes from `recordUsage`'s resolved rate**, never
from the summed handler estimates. The `rates` table carries the SKU and the read date; the
provider carries a literal. **Any new cost number should come from the ledger.**

**`normalize.text` is not idempotent per run.** Re-running it over a run that still has segments
violates `segments_run_idx_live`. The `superseded_at` / `superseded_by` columns exist for this
and `writeTranscript` does not use them. Delete the segments first, or fix it properly.

**`progressPercent` is absent on the first two polls of a Google batch operation** and populated
from the third (31%, 63% measured). §7's "measured 26/52/78" is not the whole story and the 0.2
fallback is load-bearing, not decorative.

**A wildcard dependency over a kind with no shards yet is vacuously satisfied**, and it made the
first real chunked run transcribe nothing and report success. `planRun` takes `number | null`;
`null` stops the plan at `plan.chunks`. **The reconciler cannot defend against this.** Amendment 94.

**Replanning must renumber ordinals.** `DO UPDATE SET ordinal` with a `WHERE ordinal IS DISTINCT
FROM` guard, which is what keeps planning a no-op. Amendment 95.

**Where the seam merge lives decides where persistence lives.** `asr.chunk` writes
`runs/{id}/results/{idx}.json`; `normalize.text` writes the segments once, in order. **The
artifact is also the re-billing guard.** `asr.fetch` writes the *same* artifact at `idx 0`, so
one persistence path serves both ASR shapes. Amendment 96.

**A JSON `null` is not a SQL NULL.** Anything asking "was this ever populated" of a jsonb column
needs `<> 'null'::jsonb` too.

**`reconcile` is the only writer of `jobs.status`**, for terminal runs, predicated on
`primary_run_id`.

**`WORKER_HEALTH_PORT` is 8090, not the plan's 8081** — 8081 is the sidecar's published port.
**`EADDRINUSE` on 8090 means a worker is already running**, and it arrives as a raw stack trace.

**A handler that builds its own provider is a handler no test can reach.** `HandlerDeps` injects
`providerFor`. Amendment 75's question, asked of new code.

**A handler must never name a region.** `regionOf(providerId, config)` in
`handlers/shared.ts` reads it off the built provider config; `apps/runtime/src/config.ts` is the
only file in source permitted to write one down, and CI greps for a second.

**The three DB suites that kept timing out had no `beforeAll` budget at all.** All three now say
`60_000`. **If a DB suite fails at exactly 5000ms or 10000ms, it is a missing budget, not a bug.**

### Older findings that still hold

**pg-boss's default queue policy makes the re-ring design silently wrong**, and the library is
two majors past what the plan assumes (v12.27.0, not v10). Every queue is declared `short` and a
test asserts the policy. `PgBoss` is a named export; `StopOptions.wait` is gone; `stop()` returns
early on a second call, so `stop({close:false})`-then-close leaks every connection.

**`reconcile` must return early on a run with no steps.** CLI-created runs have zero
`run_steps`, and the tick reconciles every live run.

**`partial` was unreachable, twice over.** `CASUALTY_KINDS` in `reconcile.ts` is the whole
mechanism: a `dead` step of a casualty kind satisfies its dependents and does not fail the run,
**provided a sibling shard succeeded**.

**A queue nothing subscribes to is a run that never finishes.** `queues.test.ts` asserts every
queue has a subscriber. **Ask this of any new queue name.**

**`array_agg` without `ORDER BY` makes idempotence intermittent.** The idempotence tests assert
on `xmin`, which advances on any UPDATE including one writing what was already there.

**A test can assert the opposite of the design and still look right.** Three sittings running.

**Node and undici report connection failures on `err.code`, not in the message.**

**`step_state` is a real Postgres enum**, deliberately against this schema's convention.

**Phase 1 already shipped `runs.state = 'partial'` and `cancel_requested_at`.**
**`cancel_requested_by` does not exist** and §10's `requestCancel` writes it — that needs a
migration.

**`reconcile` is exported as `reconcileRun`.** The package already exports a `reconcile`: the
word↔turn diarization algorithm from Phase 3.

**A pooled client must never keep a `LISTEN`.** Which is why the real listener needs
`DATABASE_URL_DIRECT`.

**A `spikes/*.mjs` or scratch script that imports `@thibi/*` cannot be run from outside the
package.** Write it inside `packages/<x>/` and `cd` there.

**A check that cannot distinguish "clean" from "did not run" is not a check.** Amendment 83.

**A metric that tokenises the text it scores must tokenise it the same way after the edit as
before.** Amendment 83.

**A prompt-version guard has to be a digest file, not a snapshot.**

**The eval must traverse the code the user traverses.**

**A wrong number derived from real bytes is the hardest kind to see, and regularity is the
signal.** Amendment 77.

**Every FLEURS dev split is single-gender in its entirety.** Amendment 76.

**At n=30 the ratio is noisier than the CER it is computed from.** Amendment 81.

**`tiers.json` separates the evidence from the claim, and only the evidence merges.** Amendment 79.

**Turbo will replay a cached `gen` and leave a generated file stale.**

**Every throughput number in this project was measured on a clip too short to mean anything.
Weight by duration.** Amendment 56.

**Real audio is where the reconcile thresholds fail**, `purityReviewBelow: 0.6` worst. Amendment 57.

**A high per-word confidence is not evidence the words are real.** Amendment 53.

**One probe is not a measurement.** 1 in 21.

**Run it. Build it. Start it.** Every defect in the last seven sittings came from doing that.
This sitting: the code passed 1269 tests, `pnpm lint`, `pnpm typecheck` and a full build, and
the first real operation it saw produced a run cost 5.3× too high and disproved a claim the
plan makes about restart latency.

**Ask what shape the real caller passes, not what shape is convenient to construct.**

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`; the house pattern is a spread of a conditional object.
**`noUncheckedIndexedAccess` is on too**; the house pattern is `!`.

**`resolveJsonModule` is off repo-wide.** Read fixtures with `readFileSync`.

**A test that hard-codes a seeded tier breaks the day that language is measured.** Registry
tests use `af-ZA`.

**`hookTimeout` and `testTimeout` in `vitest.config.ts` do nothing** once `test.projects` is
used. Put the timeout on the individual `beforeAll`/`afterAll`/`it`.

**Script integrity is a screen, not a guarantee.** It scores in-script non-words 1.00.

**`SettingsPort` is a flat key/value port.** **Test-DB templates are per process**, named
`thibi_test_template_${pid}`.

**A merge must retire a speaker from identity matching.** **Speaker keys never reuse a gap.**
**Diarization must never gate the transcript.** **Reconcile sorts words itself, and must.**

---

## Open questions the user has to answer

1. **Does anyone sign off `my-MM`?** Nothing is `verified` until a person writes
   `results/human-review/my-MM.json` against run `2026-08-13T15-17-34-278Z-google` with
   `verdict: "pass"`. The alternative is accepting that the product ships with no verified
   language and saying so in the UI. Costs nothing to resolve. Amendment 78.
2. **Which LLM provider and model should the editorial passes actually use?** `openai/gpt-oss-20b`
   on Groq was measured because those keys exist here. Nothing has compared it against anything.
3. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether a
   1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a requirement.
4. **Is there a real multi-speaker recording in a long-tail language** to use as a diarization
   reference? `testdata/` has a 16.6-minute Burmese recording and the pipeline has run on it, but
   **there is no reference RTTM**. Hand-labelling a few minutes is still the cheapest unblock.
5. **Is a hosted diarization service worth evaluating?** Long-tail coverage, then data residency,
   then whether it re-transcribes, then cost, then quality — which needs question 4 first.
6. **Phase 9 open question 5: should `editorial.pass` steps live on the run's DAG at all?**
   **Decide before phase 12 wires the UI.**
7. **Phase 9 open question 6: should exporting a `partial` run require acknowledgement?**
   Recommendation: a warning in the response, and a visible note in docx/md.
8. **Risk 8, from Phase 2**: nothing proves a `DYNAMIC_BATCHING` submission is billed against the
   Dynamic Batch SKU. **A live run has now recorded `dynamicBatching: true` and a
   `usage_records` row of $0.04985 at `batch_minute` for 997 billed seconds — the invoice is the
   only thing left to check it against.** Phase 14.

---

## Known debt, recorded not hidden

### Phase 9

- **A poll chain stalled for 1 h 56 m on a live diarization and the cause is not established.**
  The top item under *Do this next*. It discarded a diarization that was 64% done. A defensive
  fix is in; whether it addresses the actual cause is unknown, and it did not reproduce on a
  30-second clip.
- **Three of fifteen step kinds have no handler**: `media.peaks`, `editorial.pass`, `export`. A
  step routed to one lands `dead` naming the kind (or `skipped` when optional). `thibi runs
  start` plans none of them, so this is currently invisible rather than dangerous.
- **`GPU_SLOTS` is parsed and ignored, and should be deleted rather than implemented.** See
  amendment 101 — the sidecar's 429 is what bounds diarization.
- **`reconcile.speakers` depends on the ASR leaves, not on `normalize.text`.** On a chunked run
  those are siblings, so it can be promoted before the segments exist; it returns `skipped` with
  `reason: 'no-segments'` rather than attributing nothing to nobody. The honest fix is a planner
  change — depend it on `normalize.text` — not a handler one.
- **A diarized run needs two worker processes**, because `diarize` is a `worker-heavy` queue.
  Nothing warns you when only the light worker is up; the step just sits `ready`.
- **`runs.cost_usd` and a step's `cost_usd` are different kinds of number, deliberately.** The
  run's comes from `recordUsage`'s resolved rate; a step's is `costModel`'s estimate, which is
  **5.3× high on the batch path** because `costModel` ignores its `mode` argument. Either make
  `costModel` mode-aware, or price steps from `rates` too — but do not leave a caller assuming
  the two agree.
- **`normalize.text` is not idempotent per run.** `writeTranscript` inserts without superseding,
  so a retry over existing segments violates `segments_run_idx_live`. The supersede columns
  exist and are unused.
- **The boot nudge cannot beat an already-queued poll job.** Making a restart genuinely
  immediate needs `Doorbell` to reschedule or cancel a queued job — new interface surface.
- **A failed batch operation cannot be re-submitted.** `status.retryable` says re-submitting
  would be worth something; nothing acts on it, because `asr.batch.submit` is already `done` with
  the failed operation persisted. Needs a re-plan mechanism.
- **`asr.chunk` downloads the whole normalized FLAC per shard.** Twenty chunks means twenty
  downloads of the same file from MinIO.
- **`media.probe` downloads the source to probe it** when the asset was not probed at ingest.
- **`runs.cancel_requested_by` does not exist** and §10's `requestCancel` writes it.
- **The advisory-lock global slots are unbuilt**, so `GPU_SLOTS` and `LOCAL_ASR_SLOTS` are parsed
  and ignored. `--scale worker-heavy=3` on a one-GPU box would OOM the card.
- **`MAX_BUCKET_WAIT_MS` is parsed and ignored** — `rate-bucket.ts` does not exist.
- **The worker's error path for an unexpected startup failure is a raw stack trace.**
- **`infra/compose.yml` has no `worker` or `worker-heavy` service**, and no
  `stop_grace_period: 120s`. Docker's default grace is 10 s, which turns a graceful drain into
  the crash path on every deploy.
- **The chunk-result artifacts are never swept.** `runs/{id}/results/*.json` stays in the bucket
  after `normalize.text` has consumed it. `staging.cleanup` **cannot** own this — it is a
  sibling of `normalize.text`, not a successor, so it would race the read. Needs a new step
  depending on `normalize.text`.
- **The fourth routing rule is still unbuilt and undesigned** ("sync quota exhausted → batch").
  If it is not worth it, **delete the rule from the overview rather than leaving an
  unimplemented promise.**
- **`thibi runs start` has no `--diarize`, no `--peaks`, no `--max-duration`.** Deliberate: each
  would plan a step nothing can execute.

### Phase 5 / 6

- **The LLM runlog has no reader.** `thibi eval report --run <id>` handles ASR only.
- **`rates` carries no LLM token units**, so every LLM run reports `$0.0000`.
- **`.github/workflows/eval.yml` is manual-dispatch only, by decision.** `GROQ_API_KEY` **is** set.
- **`thibi eval translate` has never been run** against a real model.
- **The cleanup run is n=10, not 30.** Read every number in it as a direction.
- **An arm is scored over the segments that came back, and the control over all of them.** Score
  every arm over the **intersection**. Any row with a non-zero `failed` count is approximate.
- **The dry run overstates a cached run.** **The ASR sweep's recorded spend is wrong** — $0.146
  against a real ~$0.49. Amendment 77.
- **A runlog carries provider transcript text.** A `--manifest` run over newsroom audio would put
  `/testdata/` transcripts into a public repo, and nothing enforces the distinction.
- **Only four languages have an ASR measurement.** A 107-language sweep is ~$17 and nothing
  blocks it.
- **`yo-NG`'s 0.305 is 75% diacritics** and must not be quoted as a word-accuracy number.
  Amendment 80.
- **`my-MM` is no longer `verified` and `listLanguages({tier:['verified']})` is empty.**
  Amendment 78.
- **The baseline language can essentially never clear its own `ciHiRatio > 1.15` gate.**
  Amendment 82.

### Elsewhere

- **Phase 4b is built and barely measured.** `large-v3` has never been loaded on this box; do not
  try, S9 explains why (~6.7 GB against a 7.65 GB VM).
- **`thibi models pull` works by transcribing one second of silence.** The contract test costs
  ~40 s whenever the sidecar is up.
- **The container's 0.51× realtime is a macOS artifact.**
- **`persistDiarization` is not idempotent per run.** **`thibi speakers merge` has no unmerge.**
  Now reachable from the queue: re-running `reconcile.speakers` on a run that already has
  speakers goes through the same path.
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
- **`pyannote.contract.test.ts` takes ~125 s of real CPU** and runs concurrently with 80 other
  files. On a loaded machine it starves the Postgres suites into hook timeouts. If a full run
  goes red across many DB suites at once, check whether the sidecar is up before believing it.
- **`GENERATED_AT` is misnamed.** It means "the date of the freshest input".
- **`ProviderCapabilities.limits.rpm` cannot express Groq's limits.**
- **`transcribe` logs `plan: mode=…` twice.** Cosmetic, pre-existing since Phase 1.
- **`research/language-support-whisper-vs-google.md` is cited in four places and is not in this
  repo.** Either import it or stop citing it.
- **Phase 8's web routes are not built**; a live URL *download* has never been run end to end.
- **pyannote's GPU figure (8–20×) is inherited and unmeasured**, marked do-not-publish.
- **A storage test flakes.** `contract.test.ts > 's3' > accepts a stream exactly at maxBytes`
  failed once at 21.5 s against MinIO and passed on re-run. Seen once.

---

## Environment notes

- **The worker's health port is 8090.** 8081 is the sidecar.
- **Start a worker with** `set -a && source .env && set +a && node apps/worker/dist/main.js`.
  `pnpm build` first — it runs from `dist`, not from source. **`kill` the shell wrapper and the
  node process survives**: kill the pid from `pgrep -f "worker/dist/main.js"`, not the job.
- **The full loop, end to end**, and it works today for both modes:
  `thibi ingest <file> --lang my-MM -y` → `thibi runs start <jobId> -p google [--mode batch]` →
  start the worker → `thibi runs show <runId>`.
- **`psql` into the dev database**: `docker exec thibi-dev-postgres-1 psql -U thibi -d thibi`.
  The role is `thibi`, **not** `postgres`.
- **`Db` is a Drizzle handle over a `pg.Pool` exposed as `$client`**, and `@thibi/db` exports
  `DbClient` so callers need not depend on `pg` for the type. `connect` is overloaded with a
  callback form, so `Awaited<ReturnType<…>>` resolves to `void` — do not re-derive it.
- **Groq's free tier caps `openai/gpt-oss-20b` at 8000 tokens per minute**, and one cleanup
  segment costs about 2000. Only *successful* responses are cached.
- **`openai/gpt-oss-20b` is a reasoning model.** `max_completion_tokens` is 4000 in
  `apps/cli/src/llm.ts`. **Check this before choosing any new model.**
- **A `Retry-After` is believed only up to 60 seconds in the LLM path**, and up to 15 minutes in
  the step policy. The difference is deliberate.
- **Groq returns HTTP 400 `json_validate_failed` on a minority of calls**, more often on Burmese,
  Yoruba, Somali and Xhosa than on Hausa.
- **The chat models this key can reach** (checked 2026-08-14): `llama-3.1-8b-instant`,
  `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`,
  `groq/compound`.
- **This machine ran out of disk on 2026-08-13, and the way it presented is worth knowing.** At
  99% full the `rates` query *hung* rather than failing, and so did `docker ps`. Freeing space is
  not enough: `osascript -e 'quit app "Docker Desktop"'`, then `pkill -f com.docker.backend`
  (and `kill -9` the survivors), then `open -a Docker`. **`Docker.raw` reading 60 GB in `ls` is
  sparse.** **If a database hangs rather than refusing, check `df` before anything else.**
- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
  The sidecar is behind a profile and needs the repo-root `.env` passed explicitly:
  `docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar`.
- On macOS prefix docker commands with
  `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`. There is no `timeout` here.
- **`SIDECAR_URL` unset means this box does no diarization**, which is supported — and it *is*
  unset in `.env` even though the container runs. `export SIDECAR_URL=http://localhost:8081`.
- **A diarized run needs a second worker**:
  `WORKER_QUEUES="diarize,asr.local" WORKER_HEALTH_PORT=8091 node apps/worker/dist/main.js`.
- **`GOOGLE_GCS_STAGING_BUCKET` is set** and the batch path works from this box.
- **`thibi eval asr` and the LLM evals cache into `.thibi-cache`**, gitignored.
- **`/testdata/` is gitignored and holds real recordings.** Third-party, some editorially
  sensitive, and this repo is public. Do not `git add -f` in there and do not name a source in
  any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it.**
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`
  and `GROQ_API_KEY`. **A CLI run needs it exported** — `set -a && source .env && set +a`.
- **Run `pnpm test` with the services up**, and **re-run before believing a red DB suite**.
- **`git` leaves a stale `.git/index.lock`, and it is now routine.** Run `ps aux | grep "[g]it"`
  — the bracket matters — and remove the lock when nothing is there.
- **A stacked PR merges into its base, not into `main`.**
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then ask
  the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
