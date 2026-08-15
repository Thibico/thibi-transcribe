# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-15. **Phase 9's central claim is no longer a claim.** A sixteen-minute
Burmese interview went through a real worker end to end, and a `kill -9` mid-run resumed without
re-billing two chunks that had already been paid for. What is missing is everything the *other*
ten step kinds need, plus cancellation, rate buckets, the SSE route and the compose services.

**PR #38 is open and unmerged** — branch `phase-9/handlers`, three commits. Ask the user to run
`! gh pr merge 38 --merge` and do not re-check afterwards.

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
| **9 — queue and worker** | **a chunked run works end to end, on real audio, through a real worker.** The batch, diarize, editorial and export kinds have no handlers; §10–12 are unbuilt. See the split below |
| 10–15 | not started |

### What Phase 9 has and has not got

**Built, tested, and run against real audio** — the tables and migration `0004`; in
`packages/engine/src/queue/`: `queues.ts`, `retry.ts`, `plan.ts`, `reconcile.ts`, `boss.ts`,
`lease.ts`, `run-step.ts`, `recover.ts`, `start.ts` (new), `run-context.ts` (new);
`pipeline/chunk-result.ts` (new); `@thibi/runtime` (now also the home of `buildProvider` and the
Google defaults); `apps/worker` with **five handlers** — `media.probe`, `media.normalize`,
`plan.chunks`, `asr.chunk`, `normalize.text`; and `thibi runs start <jobId>`.

**Not built** — handlers for `media.peaks`, `asr.batch.submit`, `asr.poll`, `asr.fetch`,
`diarize`, `diarize.poll`, `reconcile.speakers`, `editorial.pass`, `export`, `staging.cleanup`.
Also `queue/cancel.ts` (the NOTIFY listener and `requestCancel`), `queue/rate-bucket.ts`
(`takeTokens`), the global advisory-lock slots in `lease.ts`, the SSE route,
`/api/admin/queue`, `thibi run status|retry|cancel`, and the compose services. `apps/web` is
still a stub.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **1256 tests across 81
files, nothing skipped**, with Postgres, MinIO and the sidecar up. Was 1240 across 79.

### What was actually measured

- **16m37s Burmese, 20 chunks, chirp_2**: 40 segments, 2553 words, 19 seams merged, no
  placeholders, `wordTimingQuality=full`, **$0.2719**.
- **Per-step retry with no re-billing**: `normalize.text` alone was reset and reassembled the
  whole transcript from the stored chunk artifacts. Cost unchanged.
- **Crash recovery**: 5-minute clip, `kill -9` with one chunk done and five running. All five
  reclaimed at attempt 1; **chunks 0 and 5 logged `chunk already transcribed; not re-sending`**
  because their provider call had completed before the kill. Run finished `done`, 12 segments,
  724 words, $0.0816.
- **Drain**: SIGTERM mid-run, `graceful stop complete`, exit 0.

---

## Do this next

**Pick one of two, and they are genuinely different bets.**

1. **Finish the ASR paths — `asr.batch.submit` / `asr.poll` / `asr.fetch`.** This is where the
   phase's *other* headline claim lives: "restart during `awaiting_external` and assert
   `submitBatch` was called once". Phase 2 already has `submitBatch`, `pollBatch`,
   `fetchBatchResult`, `persistOperation` and `resumeBatchRun` built and live-tested, so these
   three handlers are genuinely thin. **Recommended**, because `awaiting_external` is the only
   state in the machine that has never been exercised, and it is the one where getting it wrong
   costs money rather than time.
2. **`diarize` + `diarize.poll` + `reconcile.speakers`**, which is the other long-async shape and
   the one that makes `worker-heavy` mean something. Needs the advisory-lock slots to be honest
   about a one-GPU box.

Then, in this order: `queue/cancel.ts` and the `runs.cancel_requested_by` migration; the
advisory-lock slots; `rate-bucket.ts`; the SSE route and `/api/admin/queue`, where `apps/web`
stops being a stub.

### The alternative that was considered

Building the SSE route next, so there is something to look at. Still rejected, and now for a
better reason than last sitting's: the CLI plus `psql` proved crash recovery and the no-re-bill
guarantee *this sitting*, which a progress bar could not have. The UI's turn comes when there is
a run shape it can show that the CLI cannot.

---

## What you would otherwise rediscover

**A wildcard dependency over a kind with no shards yet is vacuously satisfied, and it made the
first real run transcribe nothing and report success.** `startRun` planned with
`chunkCount = 0`, so `normalize.text`'s `['asr.chunk','*']` resolved to an empty array — and a
step with no dependencies is a root. It ran on the first tick, wrote zero segments, and the run
hit `done` at progress 1 while twenty chunks were still queued. `planRun` now takes
`number | null`; `null` stops the plan at `plan.chunks`. **The reconciler cannot defend against
this**: by then `depends_on` is `uuid[]` and a collapsed wildcard looks exactly like a root.
**Ask this of any new wildcard dependency.** Amendment 94.

**Replanning must renumber ordinals.** The second pass inserts the shards *between*
`plan.chunks` and `normalize.text`, and `ON CONFLICT DO NOTHING` left the earlier rows on the
first pass's numbering — `normalize.text` at ordinal 3 beside `asr.chunk` shard 0. Ordinal order
is a topological order and `reconcile` walks it. Now `DO UPDATE SET ordinal` with a
`WHERE ordinal IS DISTINCT FROM` guard, which is what keeps planning a no-op. Amendment 95.

**Where the seam merge lives decides where persistence lives, and the plan had it wrong.**
Segments are **not** written per chunk. Chunks overlap by 1200 ms so the LCS merge can drop the
words said twice, so a chunk's *leading* words are not final until its predecessor's are known.
`asr.chunk` writes its parsed result to `runs/{id}/results/{idx}.json`; `normalize.text` writes
the segments once, in order, and inserts the placeholders. **The artifact is also the re-billing
guard** — committed before the step row, so a worker killed between the provider answering and
the step being marked done does not pay twice. Amendment 96.

**A JSON `null` is not a SQL NULL.** `createRun` wrote `JSON.stringify(x ?? null)` into a jsonb
column, so `probe_raw is not null` was true for every asset ever inserted. Anything asking "was
this ever populated" of a jsonb column needs `<> 'null'::jsonb` too.

**`reconcile` is now also the only writer of `jobs.status`**, for terminal runs, predicated on
`primary_run_id`. Without it every queue-driven run left its job listed as `running` forever.

**`WORKER_HEALTH_PORT` is 8090, not the plan's 8081** — 8081 is the sidecar's published port in
this repo's own `infra/compose.dev.yml`.

**A handler that builds its own provider is a handler no test can reach.** `HandlerDeps` injects
`providerFor`. Amendment 75's question, asked of new code.

**The three DB suites that kept timing out had no `beforeAll` budget at all**, and
`constraints.test.ts` carried a comment claiming they did. All three now say `60_000`. **If a DB
suite fails at exactly 5000ms or 10000ms, it is a missing budget, not a bug.**

**The layer rule now lists `@thibi/runtime` as an app**, and it owns `buildProvider`,
`readEnvironment` and `DEFAULT_GOOGLE_REGION`/`MODEL`. `apps/runtime/src/config.ts` is the only
file in source permitted to name a region, and CI enforces it — **check that grep before adding
a second app**.

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
The two-stage-plan test checked only that no `asr.chunk` shards were emitted — true throughout,
and satisfied by the bug that made the first real run useless.

**Node and undici report connection failures on `err.code`, not in the message.**

**`step_state` is a real Postgres enum**, deliberately against this schema's convention, because
most writes to that table are hand-written SQL no TypeScript type constrains.

**Phase 1 already shipped `runs.state = 'partial'` and `cancel_requested_at`.**
**`cancel_requested_by` does not exist** and §10's `requestCancel` writes it — that needs a
migration.

**`reconcile` is exported as `reconcileRun`.** The package already exports a `reconcile`: the
word↔turn diarization algorithm from Phase 3.

**A pooled client must never keep a `LISTEN`.** Same hazard that stops PgBouncer in transaction
pooling mode carrying `LISTEN` at all, which is why the real listener needs `DATABASE_URL_DIRECT`.

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

**Run it. Build it. Start it.** Every defect in the last six sittings came from doing that. This
sitting is the strongest case yet: the code passed 1250 tests, `pnpm lint`, `pnpm typecheck` and
a full build, and the very first real file it saw produced an empty transcript labelled `done`.

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
   **Decide before phase 12 wires the UI.** Revisitable because `optional: true` steps do not
   affect run terminality.
7. **Phase 9 open question 6: should exporting a `partial` run require acknowledgement?**
   Recommendation: a warning in the response, and a visible note in docx/md.
8. **Risk 8, from Phase 2**: nothing proves a `DYNAMIC_BATCHING` submission is billed against the
   Dynamic Batch SKU. Needs a real invoice. Phase 14.

---

## Known debt, recorded not hidden

### Phase 9

- **Ten of fifteen step kinds have no handler.** A step routed to one lands `dead` naming the
  kind (or `skipped` when optional). `thibi runs start` plans none of them, so this is currently
  invisible rather than dangerous — **but the moment `peaks`, `diarize`, `editorial` or `exports`
  is put in a spec, that run stops.**
- **`awaiting_external` has never been exercised.** No handler returns it yet, so the state, its
  recovery nudge and the "`submitBatch` called once" guarantee are all still theory.
- **`asr.chunk` downloads the whole normalized FLAC per shard.** Twenty chunks means twenty
  downloads of the same file from MinIO. Fine locally, wasteful in production; a byte-range fetch
  or a presigned URL handed to ffmpeg would fix it.
- **`media.probe` downloads the source to probe it** when the asset was not probed at ingest.
  Unavoidable for a URL import, wasteful otherwise.
- **`runs.cancel_requested_by` does not exist** and §10's `requestCancel` writes it.
- **The advisory-lock global slots are unbuilt**, so `GPU_SLOTS` and `LOCAL_ASR_SLOTS` are parsed
  and ignored. `--scale worker-heavy=3` on a one-GPU box would OOM the card.
- **`MAX_BUCKET_WAIT_MS` is parsed and ignored** — `rate-bucket.ts` does not exist, so the
  `rate_buckets` table is empty and every provider is unthrottled.
- **The worker's error path for an unexpected startup failure is a raw stack trace.**
- **`infra/compose.yml` has no `worker` or `worker-heavy` service**, and no
  `stop_grace_period: 120s`. Docker's default grace is 10 s, which turns a graceful drain into
  the crash path on every deploy.
- **The chunk-result artifacts are never swept.** `runs/{id}/results/*.json` stays in the bucket
  after `normalize.text` has consumed it. `staging.cleanup` is the natural owner and is unbuilt.
- **The fourth routing rule is still unbuilt and undesigned** ("sync quota exhausted → batch").
  It must not be silent, and it only makes sense at submit time. If neither is worth it, **delete
  the rule from the overview rather than leaving an unimplemented promise.**
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
  `pnpm build` first — it runs from `dist`, not from source.
- **The full loop, end to end**, and it works today:
  `thibi ingest <file> --lang my-MM -y` → `thibi runs start <jobId> -p google` → start the worker
  → `thibi runs show <runId>`.
- **`Db` is a Drizzle handle over a `pg.Pool` exposed as `$client`**, and `@thibi/db` now exports
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
- **`SIDECAR_URL` unset means this box does no diarization**, which is supported.
- **`thibi eval asr` and the LLM evals cache into `.thibi-cache`**, gitignored.
- **`/testdata/` is gitignored and holds real recordings.** Third-party, some editorially
  sensitive, and this repo is public. Do not `git add -f` in there and do not name a source in
  any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it.**
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`
  and `GROQ_API_KEY`. **A CLI run needs it exported** — `set -a && source .env && set +a`.
- **Run `pnpm test` with the services up**, and **re-run before believing a red DB suite**.
- **`git` leaves a stale `.git/index.lock`, and it is now routine.** Run `ps aux | grep "[g]it"`
  — the bracket matters — and remove the lock when nothing is there. Hit twice this sitting.
- **A stacked PR merges into its base, not into `main`.**
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then ask
  the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
