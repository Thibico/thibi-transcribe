# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-14. Everything from the 08-13 sitting is merged; the LLM evals
are specified below and unstarted.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| 3 — diarization | **done.** `scribe.ts` descoped (amendment 48); open question 7 reopened as a question about hosted diarization *as a category*, not a promise |
| 4 — Whisper providers | **built end to end**, barely measured. `large-v3` has never been loaded on this box |
| **5 — eval harness** | **measuring and publishing.** `thibi eval asr` and `thibi eval report` produce `results/tiers.json`, a dated report and a runlog; `packages/languages` compiles the tiers in. **Four languages measured at n=30.** Unbuilt: the LLM evals, `--manifest`, `init-manifest`, `.github/workflows/eval.yml` |
| 6–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

`main` is at the merge of **PR #32**: the publishing layer (#30), a handoff correction (#31)
and risk 10 (#32), which made `tiers.json` accumulate across runs. The two sampling checks
(#33) are merged too. **Nothing is in flight.**

**The first tier table this project has produced** — `google/chirp_2`, n=30, dev split, tar
order, 2026-08-13:

| code | CER (nospace) | CI95 | ratio | script | tier |
|---|---|---|---|---|---|
| `my-MM` | **0.076** | [0.064, 0.088] | 1.00 | 0.99 | beta |
| `ha-NG` | 0.059 | [0.043, 0.076] | 0.91 | 1.00 | beta |
| `jv-ID` | 0.043 | [0.030, 0.057] | 0.67 | 1.00 | beta |
| `yo-NG` | 0.305 | [0.249, 0.362] | 4.75 | 0.98 | experimental |

`si-LK` reads `experimental / no-eval-set / cer: null` at exit 0. **The baseline row is
n=100**; the rest are n=30, and each names its own run in `tiers.json`. Burmese has now been
measured three times — 0.072 (n=5), 0.064 (n=30), **0.076 (n=100, CI [0.064, 0.088])** — each
inside the previous interval, which is what a converging estimate looks like. **Yoruba is the first language measured as clearly worse than the
one this product already ships**, and none of it is a Yoruba fact yet: one provider, one
model, thirty read Wikipedia sentences, all male.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **1012 tests across 63
files, nothing skipped**, with Postgres, MinIO and the sidecar up. `pnpm gen` is idempotent.
The sidecar's own suite is 42 pytest tests, still run separately.

---

## Do this next

1. **Widen the sweep.** S7's 68 accepted-but-unmeasured codes are the queue, and a
   107-language sweep is ~$17 by the plan's own arithmetic. Nothing blocks it now: risk 10 is
   closed so a partial sweep is safe, and risk 2's open question is answered (amendment 81 —
   tar order is not measurably biased). Go in tranches; the file accumulates.
   **Run it as `--n 30 --baseline-n 100`.** The baseline is already measured at n=100 and
   those clips are cached, so it costs **$0.0000** extra per sweep and every ratio divides by
   the tighter number. A sweep without it publishes ratios against a denominator with ±30% of
   sampling noise in it.
2. **The LLM evals — and do them locally.** `cleanup`, `translate`, the `--gate`,
   `report/llm.ts`, then `.github/workflows/eval.yml`. **Delegating this to a cloud agent was
   tried on 2026-08-13 and the agent stalled after the reading phase, producing nothing** — no
   branch, no commits. Treat it as local work rather than retrying the delegation; the brief
   below is what that agent was given and it is the brief to work from.

   **The prerequisite:** `packages/engine/src/llm/` does not exist. §5.10 requires
   `packages/eval` to import the **real** `buildCleanupPrompt` from the engine and never hold
   a prompt string of its own, so stub builders land in Phase 5 and Phase 6 replaces the
   prompt *text*. Each returns `{ promptId, promptVersion, system, user }` rendered from
   registry variables, not from hardcoded language facts. Build `cleanup.current`,
   `cleanup.restraint`, `translate.to-en`.

   **The four things that are load-bearing rather than stylistic:**
   - **The LLM call is an injected dependency**, exactly like `RunAsrDeps.transcribe`. Amendment
     75 is the argument: the one module here that took a direct import instead was the one no
     test could reach, and it carried a real defect for a day.
   - **`paramsHash` must include `promptId` and `promptVersion`, with a test.** §5.10: "the gate
     is only real because of one line in §5.8". Without it a bumped prompt is a cache hit and
     the gate passes on the previous prompt's numbers.
   - **`content_delta` is a contract check, not a quality score.** A compliant cleanup pass
     changes punctuation, case and whitespace and nothing else, so it must be exactly 0.000.
     It is the metric that names the Pashto and Somali in-script substitutions that
     `entity_drift` cannot see.
   - **The research numbers are the expected shape of a run, not results.** Cebuano 80.4,
     Yoruba 51.6, the 87.0 ceiling, the 65.6 bar — none of them may be written into a report,
     a comment or a test as though they had been observed here.

   **Then a real run**, which needs keys and a few dollars: §5.10 puts a 15-language sweep at
   under $10 uncached and ~$0 thereafter. The gate's acceptance criterion — reproducing the
   research finding that `current` is worse than `control` in **every** language tested — can
   only be checked after that run, and the plan's own Verification section expects Burmese
   restraint to fail on first pass (phase-06 risk 1). That is Phase 6 work, not a number to
   be excused.

   **Yoruba is the language to watch here.** Amendment 80 measured its error as 75%
   diacritics, and a diacritization pass is precisely the kind of thing a cleanup prompt could
   fix — so `yo-NG` is the first place the LLM evals would show a real product gain rather
   than a regression.
3. **Someone has to sign off `my-MM`, or accept that nothing is verified.** See the next
   section — this is a decision, not a task.

**Phase 5's ASR half has no open Definition-of-done items.** All four that were `[~]` were run
through the CLI on 2026-08-13 for a total of **$0.0089**: exit 3 with the runlog written and
`tiers.json` withheld, exit 4 with the previous file left byte-for-byte intact, a replay that
`diff` calls byte-identical, and all five non-FLEURS locales at exit 0 and $0.0000. What
remains open in the phase is the LLM half and `--manifest`.

**Do not** start windowed diarization, whatever a memory limit suggests. Phase 3 §5 argues it
out: it reintroduces exactly the identity problem whole-file diarization removes.

---

## The thing to know before you touch anything

**`my-MM` is no longer `verified`, and `listLanguages({tier:['verified']})` is empty.**

Resolution order is now seed < measured < `language_support`. A measurement supersedes a
seeded tier, and `my-MM`'s seeded `verified` came from operational use rather than the
harness. The measurement is good — CER 0.064, ratio 1.00, ciHi 0.080 — and the only thing
blocking `verified` is `humanReview`, which **the harness may never supply**. That is the
design working, not a regression, and the route back is a person writing
`results/human-review/my-MM.json` naming run `2026-08-13T07-12-20-473Z-google`, with
`verdict: "pass"`. Amendment 78.

One related fact, from the same amendment. **The baseline language can essentially never
clear its own `ciHiRatio > 1.15` gate**, because for the baseline that ratio is the relative
width of its own interval (1.24 at n=30) rather than a comparison with anything — applied to
`my-MM` the rule quietly becomes a precision requirement. Left as-is, since nothing reaches
`verified` without a human anyway, but do not read it as a quality signal.

---

## What you would otherwise rediscover

**A wrong number derived from real bytes is the hardest kind to see, and regularity is the
signal.** The sweep costed all 120 clips at exactly 4.56 seconds, so four languages with
visibly different total audio all billed $0.0365. `wavDurationMs` read the data size from
offset 40, which is right only for a canonical 44-byte header — FLEURS wavs have an 18-byte
`fmt `, a 4-byte `fact`, and `data` at byte 50, so offset 40 returned the same 291939 from
every file in the dataset. 291939 / 64000 = 4.56. They are 32-bit float too, so the fallback
constant was wrong by 2× as well. Fixed in `packages/eval/src/wav.ts`, which walks the chunk
list. **The recorded spend of that run is understated ~3.5× and is left standing with a note**
— correcting it means paying for the sweep twice. CERs are unaffected; `durationMs` never
touches the transcript. Amendment 77.

**The one module that spends money was the one module no test could reach**, and taking the
seam found a real defect in twenty minutes. `runner.ts` took `transcribe` as a dependency
while importing `loadTsv` and `fetchClips` directly, so 84 eval tests covered everything
except the code that decides how often a provider is called. **`--budget-usd` was checking
`spent >= budget`** — which permits the call that crosses the ceiling and refuses the next
one, unbounded in the bad case. Amendment 75. Ask of any dependency that is imported rather
than injected: what can no longer be tested because of it?

**Every FLEURS dev split is single-gender in its entirety.** `my_mm` 384 FEMALE, `ha_ng` 296
FEMALE, `yo_ng` 378 MALE, `jv_id` 295 MALE — the whole split, not the sample. Amendment 68
recorded this for Burmese and it read as a quirk; it is the shape of the dataset, so risk 2's
mitigation ("report the gender split") reports a constant for every language and the speaker
concentration it was meant to surface stays invisible everywhere. **`distinctIds` is the
column doing that work**: at n=30 it caught `ha-NG` covering 28 sentences and `jv-ID` 27.
Amendment 76.

**A replay that trusts stored aggregates is not a replay.** The runlog's `score` lines carry
per-clip edit counts, not rates, and `reconstructRun` recomputes the CER, the interval and the
tier. A reader that read back the stored `cer` would reproduce the old report perfectly and go
on reproducing it after somebody changed the estimator. Two traps came with it: the run id had
to move out of `runAsrEval` (the log is *named* by it and must be open before the first
billable call), and a budget-stopped language leaves `score` lines behind that the first
reader happily recomputed into the partial CER the runner deliberately drops.

**The baseline is measured at n=100 and still cannot clear its own `ciHiRatio` gate**
(1.160 against 1.15; it would need roughly n≥130). Applied to the baseline that rule is the
relative width of its own interval rather than a comparison with anything — amendment 78's
category error, unchanged by the extra precision. Exempting the baseline from the ratio gates
is a product decision, and close to moot while `humanReview` blocks it anyway. Also:
**`ratio` is computed per run and never re-derived**, so a language only benefits from a
better baseline by being measured alongside it — which is why `--baseline-n` is a per-run
option. Amendment 82.

**At n=30 the ratio is noisier than the CER it is computed from, and it moves every
language at once.** Measured by re-sampling with `--sample-strategy id-seeded`: `my-MM` went
0.064 → 0.084 (+31%, overlapping intervals), which took `ha-NG` from ratio 0.91 to 0.67 and
`yo-NG` from 4.75 to 3.80 **without either language changing** — because `my-MM` is every
ratio's denominator. Tar order itself shows no measurable bias, so risk 2's question is
answered; this is the question that replaced it. Amendment 81.

**A drift alarm that fires on deliberate changes stops being read.** Switching sampling
strategy blocked a publish over a baseline that had not drifted — the second false positive
after a Groq baseline compared against a Google one. A comparable baseline now requires the
same provider, model, split, `n` and strategy, with the honest cost that changing any of them
leaves the guard silent for that run.

**`tiers.json` separates the evidence from the claim, and only the evidence merges.**
`runs` and `measurements` accumulate across runs; `languages` is **derived** from them on
every publish, so it is a pure function of the evidence and republishing an untouched file is
a no-op. Two rules live in that derivation and the first is load-bearing: **a measurement only
sets a tier if it came from the provider `chooseProvider` would use** — otherwise deliberately
probing Groq on Burmese, which this project does, would publish romanized non-words as
Burmese's tier. Amendment 79.

**Turbo will replay a cached `gen` and leave a generated file stale.** After the sweep,
`results/tiers.json` was full and `tiers.gen.ts` was empty, because `results/` was not an
input to the task. A drift guard cannot catch drift it never regenerates. Now a
`globalDependencies` entry — ask the same question of any generated file whose source lives
outside its own package.

**A test that hard-codes a seeded tier breaks the day that language is measured.** Three
registry tests used `ha-NG`'s seeded `experimental` as the no-override default and went red on
the sweep. They use `af-ZA` now, chosen because nothing has measured it: **a test about
override precedence must not depend on which languages somebody last swept.**

**The eval must traverse the code the user traverses.** `runNormalize` applies
`loudnorm=I=-16:TP=-1.5:LRA=11` before every production request and loudnorm changes what the
recogniser hears, so a CER measured without it is a number for a path that does not exist in
the product. Amendment 73. The general form: **a shortcut that happens to work is worse than
one that fails, because only the second one tells you.**

**A refusal to score beat a plausible number, twice in one run.** `normalizeForScoring` threw
rather than treat Burmese as Unicode with no Zawgyi converter supplied — scoring Zawgyi as
Unicode reports a *correct* transcript as ~100% error. And `wer()` returned `null` for Burmese
rather than a whitespace-tokenized fiction.

**Every throughput number here was measured on a clip too short to mean anything.** A
16.6-minute recording diarized at **0.656×** against 0.36–0.51× for every 11–34 s clip: at
that length the model load is amortised over nothing. Phase 3 §6 item 4 asks for the pre-run
estimate to be the mean of the last five runs — unweighted, that tracks how long recent jobs
happened to be. **Weight by duration.** Amendment 56.

**Real audio is where the reconcile thresholds fail, and `purityReviewBelow: 0.6` fails
worst.** The sub-0.7 purities on that recording were 0.589, 0.595, 0.60, 0.60, 0.64, then a
gap to 0.70. Two flagged, three not, **0.006 apart** — the line sits at the densest point of
the distribution. Amendment 57.

**Google on real Burmese is the first evidence for a tier this product was asserting.** Script
integrity 0.99, 2 555 words with full timings, 99 % of the audio covered, 57 s of wall clock
for 16.6 minutes, $0.27. Amendment 58 carries the offsetting half: **four of 19 chunk seams
were hard cuts**, against a fixture set tuned on English where they were rare.

**A high per-word confidence is not evidence the words are real.** S9's Vietnamese
hallucination over Burmese audio scored a mean word probability of **0.892**, from the one
provider whose per-word confidence is its reason for being here. Amendment 53, and it
constrains every confidence-shaped feature in Phase 12.

**A `mem_limit` larger than the host's memory is not headroom, it is a disabled limit.**
`mem_limit: 16g` on a 7.65 GB VM means the cgroup never fires and Docker reports
`exit 0, OOMKilled: false` — a clean exit for an OOM.

**A comment is not an install line.** The sidecar Dockerfile's header claimed faster-whisper
for weeks before the `pip install` three lines below it contained it (amendment 49). **Check
the list, not the prose above the list.**

**A registry that grows a second workload grows a second unit.** `TaskRegistry` kept one
rolling window of realtime factors; adding ASR would have blended 0.4× with 2.0× into a number
describing neither (amendment 50).

**Run it. Build it. Start it.** Every defect in the last three sittings came from doing that
and none from re-reading code.

**Ask what shape the real caller passes, not what shape is convenient to construct.**
`persist.test.ts` built a *new run* per pass because that is the easy fixture; the real caller
re-diarizes **in place**, so the Hungarian solver had never once run against a non-empty
prior with the suite green throughout.

**A test the system can answer from cache is not a test.** The sidecar contract test mints a
fresh idempotency key every run: a stable one makes it forty seconds faster and worthless.

**A race-sensitive assertion belongs in `beforeAll`, not a test body.** The "second key gets
429" check is only meaningful while the slot is held.

**A `spikes/*.mjs` that imports `@thibi/*` cannot be run from anywhere.** ESM resolves bare
specifiers from the importing *file's* directory; only `packages/engine` and `apps/cli` have
the symlink. The file has to be copied into one of them.

**A timing assertion nobody deliberately chose is a test of the machine.** Five times now, and
the newest had a cause worth generalising: **the assertion count *was* the load** —
`bootstrap.test.ts` wrote two `expect()`s inside a 5000-iteration loop, 10 000 assertions,
~800 ms alone and a blown 5 s timeout inside a 53-file run. **Assert on the aggregate, not
inside the loop.**

**`hookTimeout` and `testTimeout` in `vitest.config.ts` do nothing** once `test.projects` is
used. Proved inert 2026-08-11 by setting both to 1 ms and watching every suite pass. Put the
timeout on the individual `beforeAll`/`afterAll`/`it`.

**One probe is not a measurement, and S7 is the proof.** `gpt-4o-transcribe-diarize` on
`language=mya` returned correct Myanmar script once and then twenty distinct wrong-script
transcripts over twenty identical requests. **1 in 21.**

**Plans predate the code — check the deliverables table against the tree first.** Amendments
28–78 in [`00-overview.md`](./00-overview.md) are the running record. Worth the two minutes
every single time.

**A merge must retire a speaker from identity matching.** `persistDiarization` filters
`is_merged_into is null`; without it the next diarization matches a cluster back onto a row a
human retired.

**Speaker keys never reuse a gap.** `allocateSpeakerKeys` continues past the job's highest
`speaker-NN`, because the key appears in exports and renames.

**Diarization must never gate the transcript.** In `transcribe.ts` the `--diarize` block sits
*after* the transcript is persisted and written out. §6 is an invariant.

**Reconcile sorts words itself, and must.** Database order is `(segment idx, word idx)`, which
is not guaranteed temporal across a merged chunk seam — and the failure is a wrong answer, not
an error.

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`. `noUncheckedIndexedAccess` is on too; the house pattern is `!`.

**`resolveJsonModule` is off repo-wide.** A JSON `import` type-checks under vitest's esbuild
and then fails `tsc -b`. This is why `tiers.json` is compiled by a gen script rather than
imported. Read fixtures with `readFileSync`.

**Script integrity is a screen, not a guarantee.** It catches wrong-*alphabet* output and
scores in-script non-words 1.00. Only CER can call those wrong.

**`SettingsPort` is a flat key/value port.** Any plan reading `ctx.settings.<ns>.<key>` is wrong.

**Two storage key schemes coexist deliberately.** Phase 1 writes content-addressed
`assets/{sha[0:2]}/{sha}/source.{ext}`; Phase 8 writes `media/{uuid}/source.{ext}`, because a
streamed upload does not know its hash until the last byte.

**Test-DB templates are per process**, named `thibi_test_template_${pid}`. Adding a DB-backed
suite is safe; sharing a template name is not.

---

## Open questions the user has to answer

1. **Does anyone sign off `my-MM`?** New, and the most immediate. Nothing is `verified` until
   a person writes `results/human-review/my-MM.json` against the current run id. The
   alternative is accepting that the product ships with no verified language and saying so in
   the UI, which is defensible and is a choice rather than a default.
2. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether
   a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell.
3. **Is there a real multi-speaker recording in a long-tail language** to use as a diarization
   reference? Half-answered: there is a 16.6-minute Burmese recording in local `testdata/` and
   the pipeline has run on it, but **there is no reference RTTM**, so none of it is *accuracy*.
   **Hand-labelling a few minutes of it is still the cheapest unblock in the project.**
4. **Is a hosted diarization service worth evaluating?** Reopened 2026-08-13 as a question
   about the *category*. Evaluate in this order, because it kills candidates fastest: long-tail
   coverage, then **data residency** (self-hosted audio that never leaves the building is the
   product's premise, so a hosted diarizer is disqualifying for a sensitive recording rather
   than a trade), then whether it re-transcribes, then cost, then quality against pyannote —
   which needs question 3's RTTM first. Amendments 48 and 71. **An evaluation is not a
   promise**; nothing may describe a hosted fallback as existing.
5. **Risk 8, from Phase 2**: nothing proves a `DYNAMIC_BATCHING` submission is billed against
   the Dynamic Batch SKU. Needs a real invoice. Phase 14.
6. **Which Groq tier is this project's key on?** Live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH.

---

## Known debt, recorded not hidden

- **The dry run overstates a cached run.** It printed `$0.412` for a run that cost `$0.0000`,
  because the estimate table has no cached column — §5.8's own mock output has one
  (`30 (free)`). An estimate printed "first and unconditionally" so it is a budget rather
  than a receipt is undermined by overstating the spend.
- **The sweep's recorded spend is wrong.** $0.146 against a real ~$0.49, from amendment 77's
  wav reader. Fixed forward; the run's log is left as it was written.
- **A runlog carries provider transcript text.** Fine for FLEURS, which is public. **A
  `--manifest` run over newsroom audio would put transcripts of `/testdata/` material into a
  public repo**, and nothing enforces the distinction. Decide it before `--manifest` is built.
- **Only four languages are measured, each on one gender and one provider.** Nothing
  downstream may quote 0.064 as a language-level claim.
- **`yo-NG`'s 0.305 is 75% diacritics, and must not be quoted as a word-accuracy number.**
  Ignoring tone marks it is **0.065**, in line with `my-MM` 0.064 and `ha-NG` 0.059; 10 of 30
  hypotheses came back with no tone marks at all. `experimental` is still the right tier —
  tone is lexical in Yoruba — but the failure is diacritization, not recognition, which is a
  Phase 6 prompt rather than a provider problem. Amendment 80. (The earlier guess in this note
  that `letterlikePunct` was the cause was wrong: tone marks are combining marks and
  `stripPunct` never touches them.)
- **A diacritic-blind CER would name that class of failure** the way script integrity names
  the wrong-alphabet one, and it is unbuilt. It must never be published for a script whose
  marks are not optional — stripping Burmese's would yield a flattering number meaning
  nothing.
- **Phase 4b is built and barely measured.** `tiny`, English, eleven seconds. `large-v3` has
  never been loaded on this box; do not try, S9 explains why (~6.7 GB against a 7.65 GB VM).
- **`thibi models pull` works by transcribing one second of silence** at a URL that 404s by
  design: the model loads before the audio is fetched. A *successful* pull ends in a
  `bad_audio` task, and anything tightening that error handling has to keep knowing why.
- **Phase 3 has no open Definition-of-done items.** `scribe.ts` is descoped, not forgotten;
  reopening open question 7 does not license describing a hosted fallback as existing.
- **The contract test costs ~40 s** whenever the sidecar is up, because it runs a genuine
  11-second diarization. It skips itself, naming the missing service, when the sidecar is
  unreachable.
- **The container's 0.51× realtime is a macOS artifact**, not a deployment number. S6's native
  0.74–0.79× on the identical file is ~1.5× faster.
- **The estimate shown before a diarization is still S6's 0.6× constant**, and it is now
  measured to be the better of the two options on offer. Weight by duration before reading
  `diarization_runs.realtime_factor`.
- **`persistDiarization` is not idempotent per run.** Two calls insert two `diarization_runs`
  rows. Honest, but Phase 9's retry loop has to decide whether it should dedupe.
- **`thibi speakers merge` has no unmerge.** The lineage is kept precisely so it is reversible.
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
- **S7 has no throughput number at length**, and its 68 accepted codes are a Phase 5 queue.
- **`GENERATED_AT` is misnamed.** It means "the date of the freshest input".
- **`ProviderCapabilities.limits.rpm` cannot express Groq's limits** — a daily request bucket
  and an hourly audio-seconds bucket.
- **`transcribe` logs `plan: mode=…` twice**, the second time claiming `--mode sync` when the
  user passed nothing. Cosmetic, pre-existing since Phase 1.
- **`research/language-support-whisper-vs-google.md` is cited in four places and is not in
  this repo.** Either import it or stop citing it.
- **Phase 8's web routes are not built**; a live URL *download* has never been run end to end;
  the 2 GB flat-RSS memory test is not in CI.
- **pyannote's GPU figure (8–20×) is inherited and unmeasured**, marked do-not-publish.
- **A storage test flakes.** `contract.test.ts > 's3' > accepts a stream exactly at maxBytes`
  failed once at 21.5 s against MinIO and passed on re-run. Seen once.

---

## Environment notes

- **A cloud agent was dispatched to build the LLM evals on 2026-08-13 and stalled**, with the
  watchdog reporting no progress for 600 s. It had reached the end of the reading phase and
  written nothing: no branch, no commits, nothing to salvage. One data point rather than a
  verdict on delegation — but the brief was long and front-loaded with five documents to read,
  which is a plausible way to spend a watchdog window without producing an edit. If it is
  tried again, give it something to write early.

- **This machine ran out of disk on 2026-08-13, and the way it presented is worth knowing.**
  At 99 % full the `rates` query *hung* rather than failing, and so did `docker ps`,
  `docker logs` and `docker stats`; a CLI command died on an unexplained `Failed query` with
  no cause attached. The actual event was in
  `~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log`:

      engine linux/virtualization-framework run error:
        write .../Data/log/vm/init.log: no space left on device

  Docker Desktop had put up a *"disk full — free up space and start Docker Desktop again"*
  dialog and quit its VM, **leaving `com.docker.backend` resident and holding the socket** —
  which is why every client hung instead of erroring. **Freeing space is not enough; the
  leftover backend must be killed and the app relaunched.** What worked:
  `osascript -e 'quit app "Docker Desktop"'`, then `pkill -f com.docker.backend` (and
  `kill -9` the two that survive it), then `open -a Docker`. All three containers came back
  healthy in under a minute with every named volume intact.
  Space came from `uv cache clean` (8.1 GB), `pip cache purge` (2.4 GB), staged Electron
  updates under `~/Library/Caches/*ShipIt*` (2.5 GB), and the Adobe/Playwright/Cypress caches
  (6.6 GB) — 6.9 GB free became 20 GB. **`Docker.raw` reading 60 GB in `ls` is sparse**; `du`
  says ~7.7 GB, so it is not the culprit and must not be deleted on that evidence.
  **If a database hangs rather than refusing, check `df` before anything else.**
- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
  The sidecar is behind a profile and needs the repo-root `.env` passed explicitly:
  `docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar`.
- On macOS prefix docker commands with
  `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` — the credential helper is not
  on a minimal PATH. There is no `timeout` on this machine either.
- **`SIDECAR_URL` unset means this box does no diarization**, which is supported and prints a
  remediation rather than a stack trace.
- **Run `thibi db migrate` against the dev database after pulling.** The test suites migrate
  their own databases and will not tell you the dev one is stale.
- **`thibi eval asr` caches into `.thibi-cache`**, gitignored. Delete it freely; a rerun
  refetches. `--cache-dir` moves it, `--results-dir` moves the outputs — use the latter for
  any sweep you do not want published.
- **`/testdata/` is gitignored and holds real recordings.** Third-party, some editorially
  sensitive, and this repo is public. Do not `git add -f` in there and do not name a source in
  any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it**, and is deliberately not created for you:
  an unmounted volume must stay an error rather than becoming a disk that fills up.
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`,
  `OPENAI_API_KEY` and `GROQ_API_KEY`. `GROQ_TIER=dev` raises the request cap to 100 MB.
  **A CLI eval run needs it exported** — `set -a && source .env && set +a`.
- **Run `pnpm test` with the services up.** With them down, suites skip themselves and one
  file reports as failed rather than skipped, which reads like a real failure.
- **A cold `pnpm test` after a big build reports failures that a warm one does not.** Measured
  this sitting: 13 failures, then 4, then 0 across three consecutive runs of an unchanged
  tree. Every one was a `beforeAll`/`afterAll` hook timeout in a DB-backed suite with all
  assertions passing — vitest's transform cost competing with Postgres for CPU. Standalone,
  `createTestDb` takes 1.1 s. **Re-run before believing a red DB suite.**
- **`git` leaves a stale `.git/index.lock`, and it is now routine** — five times. Always a
  zero-byte file timestamped at the *previous* successful command. Run
  `ps aux | grep "[g]it"` — the bracket matters — and remove the lock when nothing is there.
- **A stacked PR merges into its base, not into `main`.** Check
  `gh pr view <n> --json baseRefName` before merging the second one.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
  The Linux sidecar image runs torch 2.13.0 / pyannote 4.0.7.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
