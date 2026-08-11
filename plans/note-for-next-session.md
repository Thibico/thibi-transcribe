# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-11, end of Phase 3's build.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **everything buildable is built, and the diarizer has now run on real audio** (S8: DER 0.4%). Two things remain: `scribe.ts` needs an ElevenLabs key, and the contract test needs the presign gap in amendment 43 closed first |
| **4 — Whisper providers** | 4a done (OpenAI + Groq over HTTP); **4b unblocked** — the sidecar image it needed exists |
| 5–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

`main` is at the merge of PR #11. Everything above is merged, nothing in flight.

At that commit, `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **633
tests, nothing skipped**, with Postgres and MinIO up — checked three consecutive times with
the sidecar container also running, because the failure it replaced was intermittent.
`pnpm gen` is idempotent. The sidecar's own suite is **30 pytest tests**, still run
separately (see *Known debt*).

---

## Do this next

**Merge the open PR first**, then choose. The branch is green and self-contained.

Then, in preference order:

1. **Close the presign gap — amendment 43.** SigV4 signs the `Host` header, so a URL minted
   by the CLI on a laptop against `localhost:9000` is rejected 403 when the sidecar fetches
   it as `minio:9000`. Phase 3 §1 assumed the engine runs inside compose; the CLI does not.
   `S3ObjectStore` takes a `signingClient`, but its doc and every caller point it at the
   *public* URL for Phase 10, and `apps/cli/src/context.ts` sets neither. **Until this is
   wired up, a local `thibi transcribe --diarize` cannot reach the audio** — which also
   means the sidecar contract test cannot be written against a real run. Small, and it
   blocks the last unfinished thing in the phase.
2. **The sidecar contract test**, immediately after. `/v1/tasks/by-key/{key}` exists so the
   deterministic-id claim is checkable from outside, and S8's `spikes/s8-run-sidecar.mjs`
   already drives the whole path — it is most of the test with the assertions missing.
3. **Phase 4b.** Now a short hop: the image, the task registry and the single slot are
   built, so faster-whisper is `services/sidecar/app/asr.py` plus `thibi models pull`.
   `asr.py` is a 501 stub waiting for exactly that.
4. **Phase 5, the eval harness.** The alternative, and still reasonable to prefer. It now
   has *two* work queues waiting for it: Phase 4a's 24 Groq codes marked `suspected`, and
   S7's 68 accepted-but-unmeasured language codes. `thibi diarize score` also exists now, so
   Phase 5 can tune `reconcile.ts`'s five chosen-not-measured thresholds the moment somebody
   produces an RTTM — which is open question 3.

**Do not** start windowed diarization, whatever a memory limit suggests. Phase 3 §5 argues it
out: it reintroduces exactly the identity problem whole-file diarization removes. The answer
to memory is memory.

---

## What you would otherwise rediscover

**Run it. Build it. Start it.** Every defect in the last two sittings came from doing that and
none from re-reading code. In this sitting: the dev database was two migrations behind and the
first real `thibi diarize run` died on `relation "speakers" does not exist` — every DB *test*
builds its own database from a migrated template, so the one database nobody migrates is the
one a human uses. Run `thibi db migrate` before believing a CLI failure.

**A timing assertion nobody deliberately chose is a test of the machine.** Three times now:
the 64×64 Hungarian wall-clock bound, the DB teardown against `hookTimeout`, and
`speakers.test.ts > answers the review query from the partial index` — 2.0 s standalone, over
5 s inside the 40-file run once a sixth suite also held a database. If you see a red suite
under a green assertion count, check what else is running.

**`hookTimeout` and `testTimeout` in `vitest.config.ts` do nothing.** Root-level `test`
options are silently ignored once `test.projects` is used. Both were set there anyway, twice,
by two different sessions — the second beside the first, because a wrong precedent invites
copying. Proved inert on 2026-08-11 by setting both to 1 ms and watching every suite pass.
The tell was in the message: `Hook timed out in 10000ms` is vitest's *default*, so a raised
timeout that fires at the old number was never raised. **Put the timeout on the individual
`beforeAll`/`afterAll`/`it`**, which is where these six suites already put their `beforeAll`
budget. `vitest.config.ts` carries a comment saying so, because the next person to hit a slow
teardown will reach for exactly the line that has now failed twice.

**One probe is not a measurement, and S7 is the proof.** `gpt-4o-transcribe-diarize` on
`language=mya` returned correct Myanmar script once and then twenty distinct wrong-script
transcripts over twenty identical requests. **1 in 21.**
[`spikes/s7-mya-stability.mjs`](../spikes/s7-mya-stability.mjs) is the shape any language
claim has to take from now on.

**Plans predate the code — check the deliverables table against the tree first.** Four phases
running. Phase 3 §4 asked for five columns Phase 1 had already shipped; Phase 3's deliverables
table had no entry for the stage that calls the pieces in order, and `run_steps` — which §1's
contract names as the idempotency key — does not exist until Phase 9. Amendments 28–41 in
[`00-overview.md`](./00-overview.md) are the running record. It has been worth the two minutes
every single time.

**A merge must retire a speaker from identity matching.** The non-obvious one from this
sitting. `is_merged_into` plus "unmatched prior speakers are kept, never deleted" are fine
apart and a trap together: a merged-away row still holds the attributed time the next Hungarian
match runs against, so the next diarization matches the same cluster back onto the row a human
retired. `persistDiarization` filters `is_merged_into is null`; a test fails if you drop it.

**Speaker keys never reuse a gap.** `allocateSpeakerKeys` continues past the job's highest
`speaker-NN`. The key appears in exports and in `thibi speakers rename`, so it must not denote
two different people across two runs of one recording.

**Diarization must never gate the transcript.** ASR finishes a 1-hour file in about a minute;
pyannote takes ~1 h 40 m. In `transcribe.ts` the `--diarize` block sits *after* the transcript
is persisted **and** after it is written to stdout or the output file. Keep it there. §6 is an
invariant, not a preference.

**Reconcile sorts words itself, and must.** The moving cursor in `assignWords` and "neighbour"
in `medianSmooth` both mean *temporal* order. Database order is `(segment idx, word idx)`,
which is usually the same and is not guaranteed to be across a merged chunk seam — and the
failure is a wrong answer, not an error.

**`interjection-genuine` cannot protect the median filter's guards on its own.** Both guards
refuse that case, so deleting either still passes. The `-short-but-certain` /
`-long-but-uncertain` pair isolates them.

**`purityReviewBelow: 0.6` lets a real second speaker through.** `interjection-genuine` scores
0.64, just above the threshold. The number was chosen, not measured. Phase 5 tunes it.

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`. Build the object and assign conditionally.
`noUncheckedIndexedAccess` is on too and the house pattern is `!`.

**Nothing in a Whisper response envelope distinguishes a correct transcript from a confident
wrong-language one.** Groq on Burmese returned Khmer for `language=my` and Vietnamese on
autodetect, both HTTP 200, `avg_logprob` ≈ −0.6 — the same numbers as a correct English
control.

**Script integrity is a screen, not a guarantee.** `packages/core/src/metrics/script.ts`
catches wrong-*alphabet* output and scores Myanmar-script non-words 1.00. Phase 5 needs CER.

**`resolveJsonModule` is off repo-wide.** A JSON `import` type-checks under vitest's esbuild
and then fails `tsc -b`. Read fixtures with `readFileSync`.

**`SettingsPort` is a flat key/value port.** Any plan reading `ctx.settings.<ns>.<key>` is wrong.

**Two storage key schemes coexist deliberately.** Phase 1 writes content-addressed
`assets/{sha[0:2]}/{sha}/source.{ext}`; Phase 8 writes `media/{uuid}/source.{ext}`, because a
streamed upload does not know its hash until the last byte. Do not unify them without moving
the `delete` on the dedupe path in `ingest/upload.ts`.

**Test-DB templates are per process.** `packages/db/src/testing.ts` names them
`thibi_test_template_${pid}`. Adding a DB-backed suite is safe; sharing a template name is not.

---

## Open questions the user has to answer

1. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether
   a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell. S7 removed the escape hatch, so this is unavoidable now.
2. **Is there a real multi-speaker recording in one of the long-tail languages** we can use as
   a diarization reference? Now the most valuable open question of the five. `thibi diarize
   score` is built and needs an RTTM. S8 scored two macOS TTS voices with silence between
   turns — a floor on difficulty, not evidence about an interview with crosstalk — and
   nothing has ever measured diarization accuracy on Burmese or on real multi-mic audio.
3. **Is an ElevenLabs Scribe key worth getting?** It is the documented answer to "this box
   cannot run pyannote", and `scribe.ts` is one of the two open Definition-of-done items. Its
   cost and duration cap are also unconfirmed (Phase 3 open question 7). If the answer is no,
   say so and the plan should stop promising it.
4. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed
   against the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Phase 14.
5. **Which Groq tier is this project's key on?** Live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH. A Phase 5 sweep exhausts the
   measured budget long before the documented one.

---

## Known debt, recorded not hidden

- **Phase 3's two open Definition-of-done items**: `scribe.ts` (no ElevenLabs key) and the
  sidecar contract test (blocked on amendment 43's presign gap, not on the gate any more).
  Both are recorded as unchecked in [`phase-03-diarization.md`](./phase-03-diarization.md)
  rather than dropped.
- **The container's 0.51× realtime is a macOS artifact, not a deployment number.** Docker
  Desktop runs every container inside a Linux VM; S6's native 0.74–0.79× on the identical
  file is ~1.5× faster. On the Linux reference box a container is native. S6's ~0.6× planning
  figure stands and still wants re-measuring on the deployment host.
- **Real audio has now been diarized (S8), but not through the CLI.** Two macOS TTS voices
  and one Burmese monologue, both under two minutes, driven straight at the sidecar's HTTP
  API by `spikes/s8-run-sidecar.mjs`. The rename-survives-re-diarization demo is still the
  one run against a stand-in speaking the §1 contract — everything in that sequence is the
  real implementation except the source of the turns, and it stays that way until the
  presign gap above is closed.
- **The estimate shown before a diarization is still S6's 0.6× constant.** Phase 3 §6 item 4
  asks for the mean of the last five `diarization_runs.realtime_factor` on this instance. The
  sidecar now reports a real factor and `/health` medians it, but no run has reached the
  `diarization_runs` table through the CLI yet, so the column the estimate reads is still
  empty. Closing the presign gap closes this too.
- **`persistDiarization` is not idempotent per run.** Calling it twice for the same run
  inserts a second `diarization_runs` row and re-attributes the same segments. That is honest
  — each call *was* an attempt — but nothing dedupes, and Phase 9's retry loop will need to
  decide whether it should.
- **`thibi speakers merge` has no unmerge.** The lineage is kept precisely so it is
  reversible; the command to reverse it is not written.
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
- **S7 has no throughput number at length.** The 23-minute head-to-head was submitted three
  times and never returned. The short-clip rate of 2.3–3.0× realtime does not extrapolate.
- **S7's language sweep is a Phase 5 work queue.** 68 codes accepted, and acceptance proved
  nothing for `mya`.
- **Phase 4b is unbuilt**: `services/sidecar/app/asr.py` is a 501 stub, `thibi models pull`
  does not exist. **No provider returns genuine per-word confidence except Google.**
- **`GENERATED_AT` is misnamed.** It means "the date of the freshest input". The honest name
  is `DATA_AS_OF`, but it is exported from `@thibi/languages`, mirrored in
  `ResolvedRegistry.generatedAt` and printed by `thibi --version`.
- **`ProviderCapabilities.limits.rpm` cannot express Groq's limits** — a daily request bucket
  and an hourly audio-seconds bucket. Both recorded as constants in `groq.ts`, unused.
- **`transcribe` logs `plan: mode=…` twice**, the second time claiming the user passed
  `--mode sync` when they passed nothing. Pre-existing since Phase 1, cosmetic.
- **`research/language-support-whisper-vs-google.md` is cited in four places and is not in
  this repo.** Either import it or stop citing it.
- **Phase 8's web routes are not built.** `/api/uploads`, `/api/ingest/batch`, `/api/imports`
  wait on Phase 10's auth and Phase 11's UI.
- **A live URL *download* has never been run** end to end — only `--resolve-only`.
- **The 2 GB flat-RSS memory test** in Phase 8's Definition of done is not in CI.
- **pyannote's GPU figure (8–20×) is inherited and unmeasured**, marked do-not-publish in
  Phase 15's tier table.
- **A storage test flakes.** `packages/storage` `contract.test.ts > 's3' > accepts a stream
  exactly at maxBytes` failed once at 21.5 s against MinIO and passed on re-run. Seen once.

---

## Environment notes

- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
  The sidecar is behind a profile and needs the repo-root `.env` passed explicitly, because
  compose looks for `.env` beside the compose file:
  `docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar`.
- On macOS prefix docker commands with
  `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` — the credential helper is not
  on a minimal PATH.
- **`SIDECAR_URL` is new** in `apps/cli/src/context.ts`'s exhaustive env list, e.g.
  `http://localhost:8081`. Unset means this box does no diarization, which is a supported
  configuration and prints a remediation rather than a stack trace.
- **Run `thibi db migrate` against the dev database after pulling.** The test suites migrate
  their own databases and will not tell you the dev one is stale.
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`,
  `OPENAI_API_KEY` and `GROQ_API_KEY`. `GROQ_TIER=dev` raises the request cap to 100 MB.
- **Run `pnpm test` with the services up.** With them down, suites skip themselves and one
  file reports as failed rather than skipped, which reads like a real failure.
- **The full run is ~35 s idle and ~65 s with the sidecar container up.** The DB suites'
  teardown is what stretches; the container is worth stopping when iterating on tests.
- **`git` left a stale `.git/index.lock` twice**, both times after a `git mv` that failed. If a
  commit refuses with "Another git process seems to be running", check `ps aux | grep git`
  first and then remove it.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
  The Linux sidecar image is not subject to that and runs torch 2.13.0 / pyannote 4.0.7.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
  [`spikes/s7-make-2spk.mjs`](../spikes/s7-make-2spk.mjs) turns that into a two-speaker clip
  with millisecond-exact reference boundaries.
