# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-12, end of the S9 sitting.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **done.** The full path has run on real audio, the rename survives a re-diarization *and* a re-transcription with a different provider, and the contract test runs `PyannoteSource` against the real container. `scribe.ts` was the last item and is **descoped** — the user decided against ElevenLabs on 2026-08-12 (amendment 48), so pyannote is the only diarization source |
| **4 — Whisper providers** | **built, end to end.** 4a (OpenAI + Groq over HTTP) and now 4b: faster-whisper on the sidecar, the only provider with genuine per-word confidence. `thibi transcribe --provider faster-whisper` runs. **What is built and what is measured are different lists** — see below |
| 5–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

`main` is at the merge of **PR #19**. Everything through spike S9 is merged. **In flight: a cloud agent is building Phase 5's metrics layer** on `phase-5/metrics` — `levenshtein`, `cer`, `wer`, `chrf`, `normalize`, `script-integrity`, `bootstrap`, and the frozen jiwer/sacrebleu parity fixture. It was scoped to that boundary deliberately: everything else in Phase 5 needs live provider keys, FLEURS downloads and Postgres, none of which a cloud worker has.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **646 tests, nothing
skipped**, with Postgres, MinIO and the sidecar up. `pnpm gen` is idempotent. The sidecar's
own suite is **41 pytest tests**, still run separately (see *Known debt*).

---

## Do this next

**Phase 3 and Phase 4 are both built.** What is left in Phase 4 is not construction, and the
distinction matters more than usual here:

> **Built:** every item in Phase 4b's Definition of done.
> **Measured:** `tiny`, English, eleven seconds. `large-v3` has never been loaded on this box.

So the next phase is **Phase 5, the eval harness**, and it now arrives with an unusually
sharp first task rather than a menu.

1. **~~Measure faster-whisper on Burmese~~ — done, 2026-08-12, spike S9.** The answer is no:
   `language=my` returns Khmer script or nothing at all, autodetect returns Vietnamese YouTube
   boilerplate at mean word probability 0.892. `my-MM` is `measured-failure`, and
   `exclusiveTo: 'google'` is **21** again. Amendment 52.

   **The finding that outlives Burmese is amendment 53**: genuine per-word confidence was
   *high* on invented words. It measures the decoder's certainty about its own next token, not
   whether the audio contains any of it — so everything Phase 12 builds on it is a guide to
   where the model hesitated, never evidence that the rest is right. Write the UI copy
   accordingly, and note that only Phase 5's CER can make the stronger claim.
2. **Then the rest of Phase 5's queues**: Phase 4a's 24 Groq codes marked `suspected`, the
   same 23 now mirrored onto faster-whisper, S7's 68 accepted-but-unmeasured codes, and
   `reconcile.ts`'s five chosen-not-measured thresholds — `purityReviewBelow: 0.6` in
   particular, which is known to let a real second speaker through.
3. **Do not try to benchmark `large-v3` on this machine.** S9 tried: it needs ~6.7 GB, the
   Docker Desktop VM has 7.65 GB total, and with pyannote also resident the container is
   killed mid-transcription. Even alone it thrashes — a 2-second clip took minutes. A real
   throughput number for this model needs a bigger box, and amendment 54 is the reason the
   deployment memory requirement is pyannote **plus** the ASR model rather than the larger of
   the two.

**Do not** start windowed diarization, whatever a memory limit suggests. Phase 3 §5 argues it
out: it reintroduces exactly the identity problem whole-file diarization removes. The answer
to memory is memory.

---

## What you would otherwise rediscover

**A high per-word confidence is not evidence the words are real.** S9's Vietnamese
hallucination — fabricated YouTube boilerplate over Burmese audio — scored a mean word
probability of **0.892**, from the one provider whose genuine per-word confidence is its
reason for being here. The number is the decoder's certainty about its own next token.
Amendment 53, and it constrains every confidence-shaped feature in Phase 12.

**A `mem_limit` larger than the host's memory is not headroom, it is a disabled limit.**
`mem_limit: 16g` on a 7.65 GB Docker Desktop VM means the cgroup never fires, the VM's kernel
does the killing instead, and Docker reports `exit 0, OOMKilled: false` — a clean exit for an
OOM. If a container dies mid-work with exit 0, compare the limit against
`docker info --format '{{.MemTotal}}'` before believing anything else.

**A comment is not an install line.** The sidecar Dockerfile's header said "one image for both
halves ... pyannote and faster-whisper" from the day it was written, and the `pip install`
three lines below it never contained faster-whisper (amendment 49). Nothing failed, because
nothing had asked. Phase 4's prerequisites table trusted the comment too. **Check the list,
not the prose above the list** — the same habit as checking a deliverables table against the
tree.

**A registry that grows a second workload grows a second unit.** `TaskRegistry` kept one
rolling window of realtime factors and `/health.realtime_factor_estimate` is read *before a
diarization*; adding ASR to the same window would have blended 0.4x with 2.0x into a number
describing neither, with no exception anywhere (amendment 50). Whenever something shared
starts serving two kinds of work, ask what it is averaging.

**Run it. Build it. Start it.** Every defect in the last two sittings came from doing that and
none from re-reading code. In this sitting: the dev database was two migrations behind and the
first real `thibi diarize run` died on `relation "speakers" does not exist` — every DB *test*
builds its own database from a migrated template, so the one database nobody migrates is the
one a human uses. Run `thibi db migrate` before believing a CLI failure.

**Ask what shape the real caller passes, not what shape is convenient to construct.** The
2026-08-12 lesson, promised to this note and now in it. `persist.test.ts` built a *new run*
for every pass because that is the easy fixture to write; the caller that actually reaches
identity matching, `thibi diarize run`, re-diarizes **in place**. The whole feature — the
Hungarian solver, the overlap floor, the property tests — had never once run against a
non-empty prior, and the suite was green throughout.

**A test that the system can answer from cache is not a test.** The sidecar is built so a key
it has already seen returns from its journal in milliseconds. The contract test therefore
mints a **fresh idempotency key on every run**: a stable one makes the test forty seconds
faster and worthless, still passing long after the model stops loading. The same shape will
appear in Phase 9's retry loop and in anything touching `batchRecognize`.

**A race-sensitive assertion belongs in `beforeAll`, not in a test body.** The "second key
gets 429" check is only meaningful while the slot is held. From an `it` it races a
forty-second diarization, and losing the race does not fail loudly — it quietly starts a
second real run. Submitting inside `beforeAll` and asserting on the captured error later
makes the ordering a fact rather than a hope.

**A `spikes/*.mjs` that imports `@thibi/*` cannot be run from anywhere.** ESM resolves bare
specifiers from the importing *file's* directory, not the cwd, so no amount of `cd` helps —
and only `packages/engine` and `apps/cli` have the `@thibi/storage` symlink at all. The file
has to be copied into one of them. `spikes/s8-run-sidecar.mjs`'s header says "run it from
`packages/storage`", which is wrong on both counts.

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
3. **~~Is an ElevenLabs Scribe key worth getting?~~ Answered 2026-08-12: no, not for now.**
   `scribe.ts` is not built and every document that promised a hosted diarization fallback is
   corrected — amendment 48, Phase 3 open question 7, Phase 14's provider table, Phase 15
   §"Why `sidecar` and `worker-heavy` share a profile" and its tier note. **The consequence
   is question 1's, and it got sharper**: pyannote's CPU realtime factor had two honest
   mitigations and now has one, the GPU tier. A newsroom that can run neither does no
   diarization, which is supported and must never be described as a fallback.
4. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed
   against the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Phase 14.
5. **Which Groq tier is this project's key on?** Live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH. A Phase 5 sweep exhausts the
   measured budget long before the documented one.

---

## Known debt, recorded not hidden

- **Phase 4b is built and barely measured.** `tiny`, English, eleven seconds. `large-v3` has
  never been loaded on this box, no long-tail language has been through this provider, and the
  plan's "1-2x realtime on 8 vCPU" is inherited. The Docker Desktop penalty applies here as it
  does to pyannote, so expect worse than the table.
- **`thibi models pull` works by transcribing one second of silence.** The URL it passes is a
  404 by design: the model loads before the audio is fetched, so reaching the fetch proves the
  weights are cached. It is a smaller surface than a `/v1/models/pull` route and it exercises
  the real path — but it does mean a *successful* pull ends in a `bad_audio` task, and
  anything that later tightens that error handling has to keep knowing why.
- **Phase 3 has no open Definition-of-done items.** `scribe.ts` was the last and is descoped,
  not forgotten: the design survives in Phase 3 §2 and amendment 48 says what has to be true
  for it to come back. **The debt it leaves is in the docs, not the code** — every place that
  described a hosted diarization fallback has been corrected, and nothing written from here
  on may reintroduce one.
- **The contract test costs ~40 s** of the suite whenever the sidecar is up, because it runs
  a genuine 11-second diarization (see amendment 47 for why it is not a canned pipeline). It
  skips itself, naming the missing service, when the sidecar is unreachable or its model is
  not loaded — so a clone with no Docker reads as skipped, not failed. If it ever needs to be
  cheaper, the honest lever is a shorter fixture, not a stable idempotency key.
- **The container's 0.51× realtime is a macOS artifact, not a deployment number.** Docker
  Desktop runs every container inside a Linux VM; S6's native 0.74–0.79× on the identical
  file is ~1.5× faster. On the Linux reference box a container is native. S6's ~0.6× planning
  figure stands and still wants re-measuring on the deployment host.
- **The full pipeline has now run end to end on real audio, through the CLI**: OpenAI ASR,
  the real pyannote sidecar, reconcile at mean purity 1.00, and the rename-survives demo
  carrying "Daw Khin" across a re-diarization *and* across a re-transcription into the same
  job with a different provider (9 segments, 124 words). What has *not* been exercised:
  anything longer than 34 s, any long-tail language, any audio with genuine overlap or
  crosstalk, and `--speakers`/`--min-speakers`/`--max-speakers`. **The contract test's
  fixture is 11 s of macOS TTS with no crosstalk** — a contract check, deliberately not an
  accuracy measurement.
- **The estimate shown before a diarization is still S6's 0.6× constant**, even though
  `diarization_runs.realtime_factor` now holds real numbers (0.36-0.51× on this box). Phase 3
  §6 item 4 asks for the mean of the last five on this instance; nothing reads the column
  yet. Small, and now unblocked.
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
- **`git` leaves a stale `.git/index.lock`, and it is now routine** — four times, and the
  2026-08-12 pair followed ordinary `git add`/`git commit` rather than the failed `git mv`
  the first two did, so the earlier theory about `git mv` is wrong. Both times the lock was
  a zero-byte file timestamped at the *previous* successful command. If a commit refuses
  with "Another git process seems to be running", run `ps aux | grep "[g]it"` — the bracket
  matters, or you match your own grep — and remove the lock when nothing is there.
- **A stacked PR merges into its base, not into `main`, and GitHub only retargets it if the
  base branch is deleted.** Cost 2026-08-12: PR #17 was opened with `--base
  phase-3/sidecar-contract-test`, #16 was merged without deleting that branch, and #17 then
  merged Phase 4b *into the already-merged feature branch* while `main` stayed behind. It
  looked like both had landed. Either avoid stacking, or check
  `gh pr view <n> --json baseRefName` before merging the second one.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
  The Linux sidecar image is not subject to that and runs torch 2.13.0 / pyannote 4.0.7.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
  [`spikes/s7-make-2spk.mjs`](../spikes/s7-make-2spk.mjs) turns that into a two-speaker clip
  with millisecond-exact reference boundaries.
