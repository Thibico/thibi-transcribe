# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-14, third sitting. **Phase 9 is most of the way there.** The DAG,
the doorbell, the execution path and a bootable worker all exist. **What is missing is
handlers** — so the worker runs, and transcribes nothing.

Four commits sit on `phase-9/worker`, pushed with a PR open. The two before them are merged.

> **The eval work stays parked.** The CI gate is manual-dispatch only,
> `thibi eval translate` stays unrun, `--manifest` stays unbuilt. **Do not pick those up as
> "next" unless asked.** The build order is the answer to "what now", and it is now inside
> Phase 9.

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
| **9 — queue and worker** | **the machinery is done; the handlers are not.** See the split below |
| 10–15 | not started |

### What Phase 9 has and has not got

**Built and tested** — the tables (`run_steps`, `run_events`, `rate_buckets`,
`segments.placeholder_reason`, migration `0004`); in `packages/engine/src/`: `queue/queues.ts`,
`queue/retry.ts`, `queue/plan.ts`, `queue/reconcile.ts`, `queue/boss.ts` (pg-boss v12 behind
`Doorbell`), `queue/lease.ts` (heartbeat, stolen-lease detection), `queue/run-step.ts` (claim,
apply, fail), `queue/recover.ts` (the sweep), `events/emit.ts`; `@thibi/runtime` (the shared
composition root, moved out of `apps/cli`); and `apps/worker` — env parsing, health server,
boot recovery, subscriptions, the 30 s and 60 s ticks, SIGTERM drain.

**Not built** — **handlers**, first and most importantly: `createHandlerRegistry()` returns
`{}`, so the worker subscribes to seven queues and any step it picks up lands `dead` naming
its kind. Also missing: `queue/cancel.ts` (the NOTIFY listener and `requestCancel`),
`queue/rate-bucket.ts` (`takeTokens`), the global advisory-lock slots in `lease.ts`, the SSE
route, `/api/admin/queue`, `thibi run status|retry|cancel`, and the compose services.
`apps/web` is still a stub.

`main` is at `dc5fccd` (PR #36 merged). On `phase-9/worker`, awaiting review:

1. `41c370e` the pg-boss v12 adapter behind `Doorbell`
2. `853b973` the execution path — claim, lease, apply, recover
3. `83ee0f5` `@thibi/runtime`, one composition root for the CLI and the worker
4. `2587bf4` `apps/worker` as a real process — and the bug that starting it found

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **1240 tests across 79
files, nothing skipped**, with Postgres, MinIO and the sidecar up. Was 1125 across 71 at the
start of the day. The reconciler suite is stable across six consecutive runs. The sidecar's own
42 pytest tests are still run separately.

**The worker has been started for real** against the dev Postgres: it recovers, declares all
nine queues on the `short` policy, subscribes to seven, answers `/healthz` and `/readyz`,
drains on SIGTERM and exits 0. A typo'd `WORKER_QUEUES` prints two lines and no stack trace.

---

## Do this next

**Write the handlers, then run a real file through the worker.** Everything else in Phase 9
is scaffolding for that, and until it happens the phase's central claim — kill the worker
mid-job and it resumes without re-billing — is a claim.

1. **`apps/worker/src/handlers/`**, one file per kind, each a thin wrapper over an existing
   Phase 1–8 stage function. A handler gets `(ctx, step, signal)`, returns a `StepResult`, and
   never touches pg-boss, `reconcile`, or its own retry. Start with
   `media.probe` → `media.normalize` → `plan.chunks` → `asr.chunk`, which together are a
   complete chunked run. `plan.chunks` is the interesting one: its handler calls `planRun`
   again with the real chunk count, **in the same transaction that writes `run_chunks`**.
2. **Create the run and its DAG.** Something has to call `materialisePlan` and build a
   `PipelineSpec` from a run — today nothing does, so no step exists to be picked up. Probably
   a `thibi run start <jobId>` alongside the existing `transcribe`, or a flag on it.
3. **Then run a real file end to end**, and do the plan's live checklist: `docker kill` the
   worker mid-chunk and watch it resume; restart during `awaiting_external` and assert
   `submitBatch` was called once. **Do this before building anything else.**
4. `queue/cancel.ts`, the advisory-lock slots, `rate-bucket.ts`.
5. The SSE route and `/api/admin/queue`, where `apps/web` stops being a stub.

### The alternative that was considered

Building the SSE route next, so there is something to look at. Rejected for the same reason
the plan gives for putting Phase 9 before the UI: "kill the worker, it resumes" is best proved
with a CLI and `docker kill`, and a progress bar over a worker with no handlers would be a
demo of nothing.

---

## What you would otherwise rediscover

**The phase-09 plan is wrong in eight places, all now corrected inline and recorded as
amendments 86–93.** Read the corrected file, not your memory of it. The three found this
sitting come first, then the five from the sitting before.

**pg-boss's default queue policy makes the re-ring design silently wrong, and the library is
two majors past what the plan assumes** (v12.27.0, not v10). `reconcile` re-rings every `ready`
step on every 30-second pass and the plan says the singleton key makes that free. Under the
default `standard` policy it is not deduplicated at all — dedup there needs `singletonSeconds`,
because it is a throttling feature. Forty ticks would queue forty jobs for one step. Every
queue is declared **`short`** and a test asserts the policy. Three more v10→v12 changes: `PgBoss`
is a named export; `StopOptions.wait` is gone because `stop()` blocks until drained; and
`stop()` returns early on a second call, so the plan's `stop({close:false})`-then-close would
silently leak every connection.

**`reconcile` must return early on a run with no steps, and only starting the worker showed
it.** The CLI drives the same stages in one process and never plans a DAG, so its runs have
zero `run_steps` — and the tick reconciles every live run, those included. It fell through to
the `pending` → `running` transition and marked a run no worker will ever touch as running at
0%, permanently. **Every test in that suite plans a DAG first, which is exactly why none could
have produced it.**

**Two apps needing the same context meant one composition root, not two copies.**
`apps/cli/src/context.ts` is now `@thibi/runtime`, shared with the worker. It is under `apps/`
and not `packages/` on purpose: an ESLint rule bans `process.env` under every package's `src`,
and putting an env reader there would mean carving an exemption into a rule the repo calls
architecture. `runtime` is in the layer rule's app list, so no package may import it.

In summary, from the sitting before:

**`partial` was unreachable, twice over, in the design that exists to deliver it.** §9 is
entirely about a three-hour transcript with one bad chunk still being worth having.
`asr.chunk` is not `optional`, so `hardFailed` was true the instant one shard died and the
terminal branch chose `failed` before it ever tested `partial` — dead code. And independently,
the poisoning rule marked `normalize.text` (which depends on `['asr.chunk','*']`) `failed` the
moment any shard died, so the survivors would never have been assembled either. Both close with
one rule: a `dead` step of a **casualty kind** satisfies its dependents and does not fail the
run, **provided a sibling shard succeeded**. If none did, nothing was transcribed and the run
really has failed. `CASUALTY_KINDS` in `reconcile.ts` is the whole mechanism, and emptying it
fails the partial test while leaving the all-dead one passing.

**A queue nothing subscribes to is a run that never finishes, and the plan contained one.**
The step-kind table routes `normalize.text` and `reconcile.speakers` to `worker`; the queue
table, `SUBSCRIPTIONS` and the default `WORKER_QUEUES` all omitted it. Steps would sit `ready`
forever while the queue reported depth 0 — the exact misconfiguration §12 tells an operator to
watch for. `queues.test.ts` now asserts every queue has a subscriber. **Ask this of any new
queue name.**

**`array_agg` without `ORDER BY` makes idempotence intermittent.** §4's materialise SQL
aggregates a wildcard's matches in unspecified order, so replanning rewrites `depends_on` with
the same uuids in a new sequence and `IS DISTINCT FROM` stops suppressing the update. The
plan's own byte-identical test then fails on *some* runs — the worst failure mode, because it
passes on most. **The idempotence tests assert on `xmin`**, which advances on any UPDATE
including one writing what was already there; comparing column values alone would pass while
the second call rewrote every row.

**A test can assert the opposite of the design and still look right.** §-Tests says twenty
parallel reconciles produce "exactly one send per step". They do not and must not — reconcile
deliberately re-rings anything already `ready` to cover the COMMIT→`sendStep` window. What
prevents double execution is that all those sends carry the **same singleton key**.

**Two tables of retry constants for the same step kinds had already drifted, and neither
number was measured.** `engine/retry.ts` capped `asr.chunk` at 30 s and `diarize` at 60 s;
phase 9 said 120 s and 300 s. The overview never specified a cap, so each file invented one.
One table now (`queue/retry.ts`'s `POLICY`) with the other derived from it under a test.

**Node and undici report connection failures on `err.code`, not in the message.** The old
`isRetryable` regex-matched the message only, so every `UND_ERR_CONNECT_TIMEOUT` and
`UND_ERR_HEADERS_TIMEOUT` — every connect and headers timeout from `fetch` — was treated as
permanent and never retried.

**`step_state` is a real Postgres enum, deliberately against this schema's convention.** Every
other state column is `text(…, { enum })`, which constrains TypeScript and nothing else. This
table is the one whose writes are mostly hand-written SQL, none of which sees a TypeScript
type. `kind` is still `text` so a new kind is a code change. `cost_usd` went the other way —
`double precision`, matching every other money column.

**Ordinal order is a topological order, and `reconcile` relies on it** to promote a whole chain
in one pass. It is an invariant of `planRun`, so `plan.test.ts` asserts it there. Breaking it
makes a run slow, never wrong — the 30 s tick is the backstop.

**Phase 1 already shipped half of what the plan lists as modifications.** `runs.state` already
includes `partial` and `cancel_requested_at` already exists, from migration 0000.
**`cancel_requested_by` does not** and §10's `requestCancel` writes it — that needs a
migration.

**`reconcile` is exported as `reconcileRun`.** The package already exports a `reconcile`: the
word↔turn diarization algorithm from Phase 3.

**A pooled client must never keep a `LISTEN`.** The subscription outlives the checkout and
delivers notifications into whatever unrelated query gets that connection next. The test helper
destroys its client (`release(true)`) rather than returning it. It is the same hazard that
makes PgBouncer in transaction pooling mode unable to carry `LISTEN` at all, which is why the
real listener needs `DATABASE_URL_DIRECT`.

**A `spikes/*.mjs` or a scratch script that imports `@thibi/*` cannot be run from outside the
package.** ESM resolves bare specifiers from the importing *file's* directory. Paid for again
this sitting; write it inside `packages/<x>/` and `cd` there.

### Older findings that still hold

**A check that cannot distinguish "clean" from "did not run" is not a check.** Amendment 83.

**A metric that tokenises the text it scores must tokenise it the same way after the edit as
before.** `entity_drift`'s regex had the same defect in two branches; anything anchored on the
characters a pass is *licensed to change* will fire on the licence. Amendment 83.

**A prompt-version guard has to be a digest file, not a snapshot**, or a prompt edit ships with
a stale `promptVersion` via `vitest -u` and the response cache turns the gate into a re-run of
the previous prompt's numbers.

**The eval must traverse the code the user traverses** — `packages/eval` imports
`buildCleanupPrompt` from `packages/engine` and holds no prompt string of its own.

**A wrong number derived from real bytes is the hardest kind to see, and regularity is the
signal.** The ASR sweep costed all 120 clips at exactly 4.56 s because `wavDurationMs` assumed
a 44-byte header. Amendment 77.

**The one module that spends money was the one module no test could reach.** Ask of any
dependency that is imported rather than injected: what can no longer be tested because of it?
Amendment 75.

**Every FLEURS dev split is single-gender in its entirety**, so "report the gender split"
reports a constant; `distinctIds` is the column doing that work. Amendment 76.

**At n=30 the ratio is noisier than the CER it is computed from, and it moves every language at
once**, because `my-MM` is every ratio's denominator. Amendment 81.

**`tiers.json` separates the evidence from the claim, and only the evidence merges.** A
measurement only sets a tier if it came from the provider `chooseProvider` would use.
Amendment 79.

**Turbo will replay a cached `gen` and leave a generated file stale.** `results/` is a
`globalDependencies` entry — ask the same of any generated file whose source lives outside its
package.

**Every throughput number in this project was measured on a clip too short to mean anything.**
A 16.6-minute recording diarized at 0.656× against 0.36–0.51× for every 11–34 s clip. **Weight
by duration.** Amendment 56.

**Real audio is where the reconcile thresholds fail**, and `purityReviewBelow: 0.6` worst: the
sub-0.7 purities were 0.589, 0.595, 0.60, 0.60, 0.64, then a gap to 0.70. Amendment 57.

**A high per-word confidence is not evidence the words are real.** S9's Vietnamese
hallucination over Burmese audio scored a mean word probability of 0.892. Amendment 53.

**One probe is not a measurement.** `gpt-4o-transcribe-diarize` on `language=mya` returned
correct Myanmar script once and then twenty distinct wrong-script transcripts. 1 in 21.

**Run it. Build it. Start it.** Every defect in the last five sittings came from doing that and
none from re-reading code. This sitting is the clearest case yet in a new way: the defects were
not in code that had been written, they were in a *plan* that had been read several times, and
they surfaced the moment a test was written against it.

**Ask what shape the real caller passes, not what shape is convenient to construct.**

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`; the house pattern for that is a spread of a conditional object.
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
   language and saying so in the UI, which is defensible and is a choice rather than a default.
   Costs nothing to resolve. Amendment 78.
2. **Which LLM provider and model should the editorial passes actually use?** `openai/gpt-oss-20b`
   on Groq was measured because those keys exist here. Nothing has compared it against
   anything, and the gate makes the comparison cheap. A product decision.
3. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether
   a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell.
4. **Is there a real multi-speaker recording in a long-tail language** to use as a diarization
   reference? There is a 16.6-minute Burmese recording in local `testdata/` and the pipeline has
   run on it, but **there is no reference RTTM**. Hand-labelling a few minutes is still the
   cheapest unblock in the project.
5. **Is a hosted diarization service worth evaluating?** In this order, because it kills
   candidates fastest: long-tail coverage, then data residency, then whether it re-transcribes,
   then cost, then quality against pyannote — which needs question 4 first. **An evaluation is
   not a promise.**
6. **Phase 9 open question 5: should `editorial.pass` steps live on the run's DAG at all?**
   Modelled as optional steps on the run, which keeps one timeline; the alternative is a
   lightweight DAG per `editorial_passes` row, cleaner for re-runs but doubling the reconciler.
   **Decide before phase 12 wires the UI.** The current choice is revisitable because
   `optional: true` steps do not affect run terminality.
7. **Phase 9 open question 6: should exporting a `partial` run require acknowledgement?** A
   newsroom exporting subtitles that silently omit 55 seconds is a real editorial hazard.
   Recommendation: a warning in the response, and a visible note in docx/md.
8. **Risk 8, from Phase 2**: nothing proves a `DYNAMIC_BATCHING` submission is billed against
   the Dynamic Batch SKU. Needs a real invoice. Phase 14.

---

## Known debt, recorded not hidden

### Phase 9

- **No step has ever executed.** `createHandlerRegistry()` returns `{}`. The worker boots,
  subscribes and would pick a step up, but every kind lands `dead` for want of a handler. Every
  claim about crash recovery and not re-billing a `batchRecognize` is still a claim.
- **Nothing creates a DAG.** No caller builds a `PipelineSpec` and calls `materialisePlan`, so
  there are no steps for the worker to find. That, not the handlers, is the true first blocker.
- **`runs.cancel_requested_by` does not exist** and §10's `requestCancel` writes it.
- **The advisory-lock global slots are unbuilt**, so `GPU_SLOTS` and `LOCAL_ASR_SLOTS` are
  parsed and ignored. `--scale worker-heavy=3` on a one-GPU box would currently OOM the card.
- **`MAX_BUCKET_WAIT_MS` is parsed and ignored** too — `rate-bucket.ts` does not exist, so the
  `rate_buckets` table is empty and every provider is unthrottled.
- **The worker's error path for an unexpected startup failure is a raw stack trace.** A missing
  table printed a full `DrizzleQueryError` when the dev database was a migration behind; "run
  `thibi db migrate`" would have been the useful sentence.
- **`infra/compose.yml` has no `worker` or `worker-heavy` service**, and no
  `stop_grace_period: 120s`. Docker's default grace is 10 seconds, which turns a graceful drain
  into the crash path on every deploy.
- **The fourth routing rule is still unbuilt and undesigned.** The overview lists "sync quota
  exhausted / sustained 429s → batch"; `planMode` takes no quota input and would have to. The
  rate-bucket table is the only component that knows that state. Two things to settle first: it
  must not be silent (a run that becomes ~5× slower because a *different* run exhausted the
  quota is a support ticket, not graceful degradation), and it only makes sense at submit time.
  If neither is worth it, **delete the rule from the overview rather than leaving an
  unimplemented promise**.
- **pg-boss is v12; the plan's risk 1 is written against v10.** Check `work()`'s signature and
  whether queues must be created explicitly before the adapter is written.
- **The `Doorbell` interface has no implementation**, so `reconcile` is only exercised against
  a recording fake.

### Phase 5 / 6

- **The LLM runlog has no reader.** `thibi eval report --run <id>` handles ASR only. Everything
  needed for a $0.0000 replay is in the file; until it exists, changing a metric means
  re-running the command, which is nearly free only while the cache survives.
- **`rates` carries no LLM token units**, so every LLM run reports `$0.0000` and says the spend
  is UNMEASURED rather than free. `--budget-usd` degrades with it.
- **`.github/workflows/eval.yml` is manual-dispatch only, by decision.** `GROQ_API_KEY` **is**
  set. What still runs free on every push is `ci.yml`, including the parity fixture, the prompt
  snapshots and the **version-bump guard**.
- **`thibi eval translate` has never been run** against a real model.
- **The cleanup run is n=10, not 30**, because of the TPM ceiling. Read every number in it as a
  direction, not a magnitude.
- **An arm is scored over the segments that came back, and the control over all of them.** Groq
  400s cost `yo-NG current` three of ten, and those three are not a random three. Score every
  arm over the **intersection**. Any row with a non-zero `failed` count is approximate, and this
  cuts the way that flatters the arm.
- **The dry run overstates a cached run** — `$0.412` for a run that cost `$0.0000`.
- **The ASR sweep's recorded spend is wrong** — $0.146 against a real ~$0.49. Amendment 77.
- **A runlog carries provider transcript text.** Fine for FLEURS, which is public. A
  `--manifest` run over newsroom audio would put `/testdata/` transcripts into a public repo,
  and nothing enforces the distinction.
- **Only four languages have an ASR measurement**, each on one gender and one provider. S7's 68
  accepted-but-unmeasured codes are the queue; a 107-language sweep is ~$17 at
  `--n 30 --baseline-n 100` and nothing blocks it.
- **`yo-NG`'s 0.305 is 75% diacritics** and must not be quoted as a word-accuracy number.
  Ignoring tone marks it is 0.065. Amendment 80. **A diacritic-blind CER is unbuilt**, and must
  never be published for a script whose marks are not optional.
- **`my-MM` is no longer `verified` and `listLanguages({tier:['verified']})` is empty.**
  Resolution order is seed < measured < `language_support`, and the measurement is good (CER
  0.076 at n=100, ratio 1.00) — the only thing blocking is `humanReview`, which the harness may
  never supply. Amendment 78.
- **The baseline language can essentially never clear its own `ciHiRatio > 1.15` gate**, because
  for the baseline that ratio is the relative width of its own interval (1.160 at n=100) rather
  than a comparison with anything. Not a quality signal. Amendment 82.

### Elsewhere

- **Phase 4b is built and barely measured.** `large-v3` has never been loaded on this box; do
  not try, S9 explains why (~6.7 GB against a 7.65 GB VM).
- **`thibi models pull` works by transcribing one second of silence** at a URL that 404s by
  design. **The contract test costs ~40 s** whenever the sidecar is up.
- **The container's 0.51× realtime is a macOS artifact.** The estimate shown before a
  diarization is still S6's 0.6× constant.
- **`persistDiarization` is not idempotent per run.** **`thibi speakers merge` has no unmerge.**
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
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

- **pg-boss latest is 12.27.0** and its `engines` field wants Node `>=22.12.0`; this box runs
  22.18.0 and the repo declares `>=22.11`. Check before installing — it may need a bump, or an
  older pg-boss.
- **`Db` is a Drizzle handle over a `pg.Pool` exposed as `$client`**, so
  `db.$client.connect()` gives the dedicated client the advisory-lock slot layer needs
  (phase-9 risk 3). Confirmed, not yet used.
- **Groq's free tier caps `openai/gpt-oss-20b` at 8000 tokens per minute, and one cleanup
  segment costs about 2000.** On a GitHub runner it was closer to one call a minute; a 120-call
  run passed three hours without finishing. Only *successful* responses are cached, so a run
  full of failures gets no cheaper on repeat.
- **`openai/gpt-oss-20b` is a reasoning model**, confirmed against the live API.
  `max_completion_tokens` is now 4000 in `apps/cli/src/llm.ts`. **Check this before choosing any
  new model**: a reasoning model with no output cap looks exactly like a rate-limit problem.
- **A `Retry-After` is believed only up to 60 seconds in the LLM path**, and up to 15 minutes in
  the step policy (`MAX_RETRY_AFTER_MS`). The difference is deliberate: a *step* that waits
  fifteen minutes is visibly `pending` with a readable `poll_after` and holds no worker slot,
  where an in-process sleep of the same length is a wedged process.
- **Groq returns HTTP 400 `json_validate_failed` on a minority of calls**, more often on
  Burmese, Yoruba, Somali and Xhosa than on Hausa. Some say
  `max completion tokens reached before generating a valid document`; others come back with
  `failed_generation: ""` and are still unexplained.
- **The chat models this key can reach** (checked 2026-08-14): `llama-3.1-8b-instant`,
  `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`,
  `groq/compound`. `--models` is required and has no default, deliberately.
- **This machine ran out of disk on 2026-08-13, and the way it presented is worth knowing.** At
  99% full the `rates` query *hung* rather than failing, and so did `docker ps`. Docker Desktop
  had quit its VM **leaving `com.docker.backend` resident and holding the socket**. Freeing
  space is not enough: `osascript -e 'quit app "Docker Desktop"'`, then
  `pkill -f com.docker.backend` (and `kill -9` the survivors), then `open -a Docker`.
  **`Docker.raw` reading 60 GB in `ls` is sparse** — `du` says ~7.7 GB. **If a database hangs
  rather than refusing, check `df` before anything else.**
- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
  The sidecar is behind a profile and needs the repo-root `.env` passed explicitly:
  `docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar`.
- On macOS prefix docker commands with
  `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`. There is no `timeout` here.
- **`SIDECAR_URL` unset means this box does no diarization**, which is supported.
- **Run `thibi db migrate` against the dev database after pulling** — there is a new migration.
- **`thibi eval asr` and the LLM evals cache into `.thibi-cache`**, gitignored. Deleting it means
  paying again for LLM evals. `--results-dir` moves the outputs.
- **`/testdata/` is gitignored and holds real recordings.** Third-party, some editorially
  sensitive, and this repo is public. Do not `git add -f` in there and do not name a source in
  any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it.**
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`,
  `OPENAI_API_KEY` and `GROQ_API_KEY`. **A CLI eval run needs it exported** —
  `set -a && source .env && set +a`.
- **Run `pnpm test` with the services up**, and **re-run before believing a red DB suite**: a
  cold run after a big build has twice reported hook timeouts a warm run did not.
- **`git` leaves a stale `.git/index.lock`, and it is now routine.** Run
  `ps aux | grep "[g]it"` — the bracket matters — and remove the lock when nothing is there.
- **A stacked PR merges into its base, not into `main`.**
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
