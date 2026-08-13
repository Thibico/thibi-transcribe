# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-13, end of the runner sitting — the first measured CER.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **done.** The full path has run on real audio, the rename survives a re-diarization *and* a re-transcription with a different provider, and the contract test runs `PyannoteSource` against the real container. `scribe.ts` was the last item and is **descoped** — the user decided against ElevenLabs on 2026-08-12 (amendment 48), so pyannote is the only diarization source |
| **4 — Whisper providers** | **built, end to end.** 4a (OpenAI + Groq over HTTP) and now 4b: faster-whisper on the sidecar, the only provider with genuine per-word confidence. `thibi transcribe --provider faster-whisper` runs. **What is built and what is measured are different lists** — see below |
| **5 — eval harness** | **measuring.** The whole chain runs: FLEURS TSV fetch and oid-keyed cache, the ranged-tarball audio pull, sampling, the response cache, scoring, bootstrap CI, tiering, and `thibi eval asr` with `--dry-run` and `--budget-usd`. **The first CER exists** — `my-MM` on `google/chirp_2` at **0.072** (below). Unbuilt: `tiers.json`, the dated report, the tier-change diff, the LLM evals |
| 6–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

`main` is at the merge of **PR #28**. Phase 5 went from a six-line placeholder to a working
harness across 2026-08-12/13: the metrics layer (PR #20, frozen against jiwer 4.0.0 and
sacrebleu 2.6.0), the FLEURS data path (#23), the sampler (#24), the dry run (#25) and the
runner (#28).

**The first measured CER in this project: `my-MM` on `google/chirp_2` = 0.072.** n=5, dev
split, tar order, CI95 [0.019, 0.122], script integrity 1.00, WER `null` (correct — Burmese
has no word segmentation), $0.0061. **It tiered `beta`, not `verified`**, blocked by `n<30`,
`humanReview` and `ciHiRatio>1.15`. Read that last one before quoting the 7.2%: at n=5 the
interval's upper bound is 1.7× the point estimate, so the gate comparing the *interval*
against the baseline caught what the point estimate alone would not. **It is the first number,
not a tier.** Amendment 74.

An identical second run cost **$0.0000** in 3.5 s, so the response cache and the
reproducibility Definition-of-done item are verified rather than asserted.

**Amendment numbers 56–65 were allocated by two branches at once, and it nearly shipped.**
PR #22 took 56–59 while PR #20 was already open holding 56–61; the table auto-merged without
a git conflict and would have carried four duplicate rows into the canonical record that every
phase document cross-references. PR #20's were renumbered to 60–65 on the way in, along with
eight references in `normalize.ts`, `script-integrity.ts`, a test and the diary. **Check the
open PRs before taking the next number** — the amendments table is append-only prose, so git
cannot see the collision for you.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **950 tests across 57
files, nothing skipped**, with Postgres, MinIO and the sidecar up. `pnpm gen` is idempotent.
The sidecar's own suite is **42 pytest tests**, still run separately (see *Known debt*).

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
2. **~~Build the rest of Phase 5~~ — mostly done 2026-08-13.** The data path, sampler, dry
   run, response cache, runner and tiering are built and have produced a real number. **What
   is left is publishing it**, in this order:

   1. **`tiers.json` and the dated report.** The measurement works; nothing writes it out, so
      `packages/languages` still cannot import a tier and `/settings/languages` has nothing
      to render. §5.11 has the shape. The tier-change diff goes **first** in the report — a
      reader who only reads the top must still learn the thing that matters.
   2. **Inject `loadTsv` and `fetchClips` into the runner.** They are called directly, so the
      one module that spends money is the one module with no unit test. Small now, harder
      once the report and the LLM evals both call it. See *Known debt*.
   3. **Then a real n=30 sweep**, which is the first output a user could look at and judge.
3. **Then the rest of Phase 5's queues**: Phase 4a's 24 Groq codes marked `suspected`, the
   same 23 now mirrored onto faster-whisper, S7's 68 accepted-but-unmeasured codes, and
   `reconcile.ts`'s five chosen-not-measured thresholds — `purityReviewBelow: 0.6` in
   particular, which is now known to sit at the densest point of a real purity distribution
   (amendment 57) and not merely to be unmeasured.
4. **~~Two small defects in the CLI~~ — done 2026-08-13, and one of the two was never real.**
   `thibi diarize run` **always exited 2** when `SIDECAR_URL` was unset; the "exit 0" claim
   came from reading the status of a command piped into `tail`, which reports `tail`'s. The
   `THIBI_TMP_DIR` stack trace was real and is fixed, along with the larger shape it exposed:
   `buildContext` throws outside every command's try block, so a `NotConfiguredError` raised
   while assembling the context bypassed all the careful per-command handling. Amendments 59
   (corrected) and 72.
5. **Do not try to benchmark `large-v3` on this machine.** S9 tried: it needs ~6.7 GB, the
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

**The eval must traverse the code the user traverses.** The runner's first attempt posted
FLEURS wavs straight to Google and got `400 … not in a supported encoding`. The encoding was
only how it surfaced. `runNormalize` applies `loudnorm=I=-16:TP=-1.5:LRA=11` before every
production request and **loudnorm changes what the recogniser hears**, so a CER measured
without it is a number for a path that does not exist in the product. Amendment 73, and the
general form is the useful part: **a shortcut that happens to work is worse than one that
fails, because only the second one tells you.**

**A refusal to score beat a plausible number, twice in one run.** `normalizeForScoring` threw
rather than treat Burmese as Unicode when no Zawgyi converter was supplied — scoring Zawgyi as
Unicode reports a *correct* transcript as ~100% error, which would have made Burmese look
unsupported against its own baseline (amendment 62's injected converter, earning its keep).
And `wer()` returned `null` for Burmese rather than a whitespace-tokenized fiction. Neither
would have failed loudly if it had been built to guess.

**Every throughput number here was measured on a clip too short to mean anything, and they
all understate it.** A 16.6-minute real recording diarized at **0.656×** against 0.36–0.51×
for every 11–34 s clip on this box: at that length the model load is amortised over nothing.
The trap is Phase 3 §6 item 4, which asks for the pre-run estimate to be the mean of the last
five runs — unweighted, that tracks how long recent jobs happened to be, and it read 0.326×
just before a job that ran at 0.656×. **Weight by duration.** Amendment 56. Ask the same
question of any rolling average this project grows: what is it averaging, and over what.

**Real audio is where the reconcile thresholds fail, and `purityReviewBelow: 0.6` fails
worst.** The sub-0.7 purities on that recording were 0.589, 0.595, 0.60, 0.60, 0.64, then a
gap to 0.70. Two segments flagged, three not, **0.006 apart**. The line is at the densest
point of the distribution. Amendment 57, and it is a far better tuning target than the
synthetic fixture the risk section used to cite.

**Google on real Burmese is the first evidence for a tier this product has been asserting.**
Script integrity **0.99**, 2 555 words with full timings, 99 % of the audio covered, 57 s of
wall clock for 16.6 minutes, $0.27. Set against amendments 52–53, where the same language
produced Khmer script and Vietnamese boilerplate from other providers, `my-MM` is the one
long-tail claim now standing on a newsroom-shaped file. Amendment 58 — which also carries the
offsetting half: **four of 19 chunk seams were hard cuts**, against a fixture set tuned on
English where they were rare. Continuous natural speech is harder on the seam merge than
anything it was built against, and each hard cut costs 2–3 words.

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

**A timing assertion nobody deliberately chose is a test of the machine.** Four times now:
the 64×64 Hungarian wall-clock bound, the DB teardown against `hookTimeout`,
`speakers.test.ts > answers the review query from the partial index` — 2.0 s standalone, over
5 s inside the 40-file run once a sixth suite also held a database — and, 2026-08-12,
`bootstrap.test.ts > mulberry32 > stays in [0, 1)`. If you see a red suite under a green
assertion count, check what else is running.

**The newest one had a cause worth generalising: the assertion count *was* the load.** That
test drew 5000 numbers and wrote **two `expect()`s per iteration — 10 000 assertions** in a
hot loop. `expect` is not free; it ran ~800 ms alone and blew a 5 s timeout inside the
53-file run. It now scans the draws and asserts three times, which is 35 ms and reports
*which* value was out of range instead of merely that one was. **Assert on the aggregate, not
inside the loop** — a per-iteration `expect` is a timing assertion you did not know you were
writing, and it degrades exactly when the suite is busiest.

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
   a diarization reference? **Half-answered 2026-08-12, and the remaining half is the whole
   point.** There is now a 16.6-minute real multi-speaker Burmese recording in local
   `testdata/`, and the full pipeline has run on it — pyannote found **2 speakers**, 295 turns,
   0 unassigned words. What there is *not* is a **reference RTTM**, so none of that is
   *accuracy*: nothing here can say whether 2 is the right answer, whether the 17.7 % of audio
   attributed to nobody is non-speech or missed speech, or whether the 64/18 speaking split
   hides a third voice folded into `speaker-00`. `thibi diarize score` still has nothing to
   score against. **Hand-labelling a few minutes of that file is now the cheapest unblock in
   the project** — it converts an existing asset into the first real diarization measurement
   and gives amendment 57's threshold something to tune against.
3. **Is a hosted diarization service worth evaluating? Reopened 2026-08-13 by the user** —
   as a question about the *category*, not about ElevenLabs, which was closed 2026-08-12 and
   stays closed on its own merits. Amendments 48 and 71; criteria in Phase 3 open question 7.

   What changed: throughput is measured rather than estimated (**0.656×**, so an hour of audio
   is ~90 minutes — amendment 56), the memory floor is pyannote **plus** the resident ASR
   model (amendment 54), and **accuracy is still unmeasured**, so nothing establishes that the
   90-minute wait buys a good answer. The trigger amendment 48 named — a newsroom that cannot
   host pyannote — looks less like an edge case than it did.

   **Evaluate in this order, because it kills candidates fastest:** long-tail language
   coverage first (a diarizer serving only the languages we already have alternatives for
   solves nothing, and an accepted language code proves nothing — S7); then **data
   residency**, which is the one amendment 48 never had to weigh — self-hosted, audio that
   never leaves the building, is the product's premise, so for a sensitive recording a hosted
   diarizer is disqualifying rather than a trade, and any hosted source ships **off by
   default, per-instance opt-in, named in the UI at the point of use**; then whether it
   re-transcribes; then cost and duration cap against the live API; then quality against
   pyannote, which needs question 2's RTTM before it can mean anything.

   **This reopens an evaluation, not a promise.** `scribe.ts` is unbuilt and no document may
   describe a hosted fallback as existing. A box that can run neither pyannote nor a GPU does
   no diarization — supported, and never to be called a fallback.
4. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed
   against the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Phase 14.
5. **Which Groq tier is this project's key on?** Live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH. A Phase 5 sweep exhausts the
   measured budget long before the documented one.

---

## Known debt, recorded not hidden

- **`runner.ts` has no unit test, and it is the module that spends money.** It calls `loadTsv`
  and `fetchClips` directly instead of taking them as dependencies the way it already takes
  `transcribe`, so nothing exercises it but a real billable run. 84 eval tests cover the cache,
  the tiering, the sampler and the data path; none cover the runner. Take the seam before the
  report and the LLM evals become its second and third callers.
- **The only measured language is one gender and five clips.** `my-MM` at n=5, all `FEMALE` —
  the split has no other (amendment 68). The tiering already refuses to call it verified, and
  nothing downstream may quote 0.072 as a language-level claim.
- **`--budget-usd` is implemented but its abort path has never fired.** The check runs before
  each billable call, and the exit-3-with-partial-results behaviour is asserted by nothing.
  Phase 5's Definition of done wants it proven; a run small enough to trip it deliberately is
  the cheapest way.
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
  not forgotten: the design survives in Phase 3 §2, and open question 7 — **reopened
  2026-08-13** — now carries the criteria a hosted source has to clear. **The debt it leaves
  is in the docs, not the code** — every place that described a hosted diarization fallback
  has been corrected, and **reopening the question does not license reintroducing one**. An
  evaluation is not a promise, and nothing may describe a hosted fallback as existing until
  something is built and measured.
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
- **The estimate shown before a diarization is still S6's 0.6× constant**, and it is now
  measured to be the *better* of the two options on offer. `diarization_runs.realtime_factor`
  holds 0.36–0.51× from short clips and **0.656× from the one real-length recording**, so the
  mean-of-last-five in Phase 3 §6 item 4 must be weighted by duration before anything reads
  the column — unweighted it would have promised ~51 minutes for a 26-minute job. Amendment
  56. Still small, still unblocked, no longer a straight substitution.
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
- **`thibi eval asr` caches into `.thibi-cache` in the working directory**, which is
  gitignored as of 2026-08-13. It holds FLEURS TSVs, downloaded wavs and cached provider
  responses — all re-derivable, and the response entries carry provider transcript text that
  has no business in git history. Delete it freely; a rerun refetches. `--cache-dir` moves it.
- **`/testdata/` is gitignored and holds real recordings.** Third-party material, some of it
  editorially sensitive, and this repo is public. Measurements taken against it are committed;
  the audio, the transcripts, the filenames and the sources are not. Do not `git add -f` in
  there and do not name a source in any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it**, and the CLI now says so instead of
  crashing. `mkdtemp` does not create its parent, so a wrong value used to surface as a raw
  `ENOENT` three stages into a pipeline; it is validated in `buildContext` and fails at exit 2
  with a `mkdir -p` you can copy. **It is deliberately not created for you** — an unmounted
  volume must stay an error rather than becoming a disk that fills up. Amendment 72.
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
