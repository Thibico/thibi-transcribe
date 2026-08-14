# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-14. The LLM evals are built, run for the first time, and the first
run found five defects in them. All of it is merged; **nothing is in flight**.

> **Decision, 2026-08-14: the eval work is parked and the next work is the app.** The user
> called it — measurement had consumed a full sitting and the product still has no UI. The CI
> gate is **manual-dispatch only** (see `.github/workflows/eval.yml`, which says why in its
> header), `thibi eval translate` stays unrun, and `--manifest` stays unbuilt. **Do not pick
> the eval items up again as "next" unless asked**; the build order below is the answer to
> "what now".

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| 3 — diarization | **done.** `scribe.ts` descoped (amendment 48); open question 7 reopened as a question about hosted diarization *as a category*, not a promise |
| 4 — Whisper providers | **built end to end**, barely measured. `large-v3` has never been loaded on this box |
| **5 — eval harness** | **ASR half done and published. LLM half built and measured once.** `thibi eval asr`, `report`, `cleanup` and `translate` all exist; `cleanup` has run for real against six languages. Unbuilt: `--manifest`, `init-manifest`, the LLM runlog **replay**, and a `translate` run of any size |
| 6–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

`main` is at the merge of **PR #35**, which is this session's six commits:

1. `1b5152c` the prompts and the two registry fields they need
2. `d49e58b` `packages/eval/src/llm/` — metrics, runners, gate
3. `db8ccab` the CLI commands, and the first defect the first live run found
4. `c783483` the gate failing when it measured nothing, plus retry and CI
5. `31a5221` the same entity-regex defect in its second branch
6. `4af051c` the six-language measurement, the diary and this note

Plus three follow-ups on `main` after the merge: `a96ad10` a reporting convention in
`AGENTS.md`, `c112134` the eval workflow, **which did not parse at all** and therefore was
never a gate until it was fixed, and `2295686` a cap on how long a provider's `Retry-After`
may be believed.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **1125 tests across 71
files, nothing skipped**, with Postgres, MinIO and the sidecar up. `pnpm gen` is idempotent.
The sidecar's own suite is 42 pytest tests, still run separately.

**The first cleanup measurement this project has produced** — `groq/openai/gpt-oss-20b`,
n=10, dev split, seed 1, 2026-08-14, `cer_punct` (lower is better, control = doing nothing):

| code | control | current | restraint | content_delta (current → restraint) |
|---|---|---|---|---|
| `my-MM` | **0.016** | 0.021 | **0.027** | 0.0024 → 0.0000 |
| `yo-NG` | 0.032 | **0.096** | 0.018 | **0.0952** → 0.0011 |
| `ps-AF` | 0.017 | 0.030 | 0.014 | 0.0064 → 0.0000 |
| `so-SO` | 0.043 | 0.044 | 0.030 | 0.0239 → 0.0021 |
| `ha-NG` | 0.036 | 0.028 | 0.022 | 0.0094 → 0.0009 |
| `xh-ZA` | 0.042 | 0.051 | 0.029 | 0.0201 → 0.0051 |

**The research direction reproduces, and the restraint prompt reverses it.** `current` is worse
than doing nothing in **five of six** languages — Hausa is the exception — and `restraint`
beats the control in **five of six**. `content_delta` is the clearer signal: the shipped prompt
rewrote **9.5% of Yoruba's characters**, 2.4% of Somali's and 2.0% of Xhosa's, and the
restraint prompt is at or near zero everywhere. The magnitudes differ from the research table
(it has Yoruba `current` at 0.148 and `restraint` at 0.035) because this is a different model
at n=10; the ordering is what was worth checking, and it holds.

**Burmese is the exception, exactly where phase-06 risk 1 predicted it.** Restraint 0.027
against a 0.016 control — above it, and further above than the research's own 0.019. **Do not
relax the gate**; closing that gap is Phase 6 work. What the run shows it doing is inserting
`၊` at every phrase boundary: `ဖြစ်သူ ဂျမီစီမင်အော့ဖ် သည်` came back as
`ဖြစ်သူ ဂျမီစီမင်အော့ဖ်၊ သည်`, which is a clause mark where the reference has a space.
`content_delta` is **0.0000** for that arm, so the prompt's contract held perfectly — it
changed only punctuation, and the punctuation it chose was wrong. That is a prompt problem
with a clear shape.

`thibi eval cleanup --gate` **exits 2 with 12 failing conditions**, which is the correct
answer for a run containing an arm that is meant to fail. With `--arms control,restraint` only
two would remain: `my-MM` on CER and `xh-ZA` on `content_delta` at 0.0051 against a 0.0050
tolerance.

---

## Do this next

**Build the app.** Phase 5 is as done as it needs to be for now — the measuring instrument
exists and has produced one real finding. What the product does not have is a way for anyone
to use it. From the build order in [`00-overview.md`](./00-overview.md) the shortest path to
something a newsroom can open is **9 → 10 → 11 → 12**: the queue and worker, then auth and
settings, then the UI shell, then the editor. Phases 6 (LLM passes) and 7 (export) can be
taken in either order around them, and 6 now has measured evidence waiting for it.

Start by reading [`plans/phase-09-queue-and-worker.md`](./phase-09-queue-and-worker.md) in
full, including its Risks section, and settle anything it says to decide on day one.

### Parked, and why — do not restart these without being asked

1. **The Burmese restraint gap.** Phase 6 work and now measured rather than predicted.
   See the table above. Phase 6 risk 1 said Burmese restraint would fail on first run because
   the research's own table has it at 0.019 against a 0.016 control; it does. **Do not relax
   the gate.** The cache makes iteration free on everything except the segments a new prompt
   version actually changes — and bumping `promptVersion` is what makes them a genuine miss.
2. **`thibi eval translate` has never been run against a real model.** A first run is
   `--languages ceb-PH,jv-ID,xh-ZA,yo-NG --target en-US`, which is six languages of calls
   including the two controls it adds itself.
3. **Widen the ASR sweep.** Unchanged from the last note and still the largest single piece of
   value: S7's 68 accepted-but-unmeasured codes are the queue, a 107-language sweep is ~$17,
   and nothing blocks it. **Run it as `--n 30 --baseline-n 100`** — the n=100 baseline clips
   are cached, so the tighter denominator costs **$0.0000** extra.
4. **Someone has to sign off `my-MM`, or accept that nothing is verified.** See below — a
   decision, not a task, and the only parked item that costs nothing to resolve.

---

## The thing to know before you touch anything

**`my-MM` is no longer `verified`, and `listLanguages({tier:['verified']})` is empty.**

Resolution order is seed < measured < `language_support`. A measurement supersedes a seeded
tier, and `my-MM`'s seeded `verified` came from operational use rather than the harness. The
measurement is good — CER 0.076 at n=100, ratio 1.00 — and the only thing blocking `verified`
is `humanReview`, which **the harness may never supply**. That is the design working, and the
route back is a person writing `results/human-review/my-MM.json` naming run
`2026-08-13T15-17-34-278Z-google` with `verdict: "pass"`. Amendment 78.

**The baseline language can essentially never clear its own `ciHiRatio > 1.15` gate**, because
for the baseline that ratio is the relative width of its own interval (1.160 at n=100) rather
than a comparison with anything. Left as-is, since nothing reaches `verified` without a human
anyway, but do not read it as a quality signal.

---

## What you would otherwise rediscover

**A check that cannot distinguish "clean" from "did not run" is not a check.** The first
six-language cleanup run measured **nothing** — five languages lost to a single Groq 429
apiece, one to a `json_validate_failed` 400 — and the gate printed *"pass — every arm is at or
below its control"* and exited 0, because it skipped every language it had nothing to compare.
It now fails with `not_measured`, and a run that measured nothing exits non-zero with or
without `--gate`. Amendment 83. A language FLEURS has no eval set for is still not a failure:
that is a fact about FLEURS, and `thibi eval asr` exits 0 on it too.

**A metric that tokenises the text it scores must tokenise it the same way after the edit as
before.** §5.10's `entity_drift` regex had the same defect in two of its three branches, and
one live run found both. `\d[\d.,:/٫٬]*` is greedy over its separators, so adding a full stop
moved `1755` out of the multiset and `1755.` in — **drift 2.0 against a 0.02 gate**. The
Latin-token branch is bounded by `(?=$|\s)`, so `ring ၏ ceo` becoming `ring၊ ၏ ceo၊` dropped
both tokens — **drift 0.25** — for words the model had not altered. Anything anchored on the
characters a pass is *licensed to change* will fire on the licence. Amendment 83.

**Two registry fields the prompt design assumes do not exist, and one cannot be derived from
Unicode.** §6.4's mapping table reads `script.hasCase` and `text.punctuation.clause`. Both are
now hand judgements in `gen-scripts.ts`. Georgian Mtavruli capitals carry `Lu`, so deriving
case from character properties would tell a model to capitalise Georgian sentences; cased is
Latn, Cyrl, Grek, Armn. And `sentenceEnders` is one flat list that several languages fill with
both kinds of mark — **Burmese lists `၊` beside `။`, Amharic `፣` beside `።`** — so `promptVars`
subtracts the clause set from it, once, rather than in 116 rows. **Empty `clausePunct` means
not recorded, not "none exist"**, and an empty set omits the permission line entirely.
Amendment 84.

**A prompt-version guard has to be a digest file, not a snapshot.** A snapshot test fails on
any change and is fixed with `vitest -u` — which is exactly how a prompt edit ships with a
stale `promptVersion`, and the response cache keys on `promptId` + `promptVersion`, so a stale
version makes a bumped prompt a cache *hit* and the gate passes on the previous prompt's
numbers. `packages/engine/src/llm/prompts/prompt-versions.json` records the version and a
sha256 over the six rendered snapshots, and the test asserts both directions.

**The eval must traverse the code the user traverses**, which is why `packages/eval` imports
`buildCleanupPrompt` from `packages/engine` and holds no prompt string of its own. That is
also why `cleanup.current` still contains the two lines phase-06 forbids: §6.5 step 4 requires
the old prompt to keep failing the gate, and a regression test with no regression in it is
decoration.

**`content_delta` sees what `entity_drift` cannot.** Measured on the very first two segments:
`casa branca` came back as `casa blanca`, a proper name rewritten in a language the model
half-knows, and the entity metric is blind to it because both tokens are in-script and
lowercase. `content_delta` caught it at 0.0049 — *below* the 0.005 gate, because one such edit
in two sentences is under a tolerance sized for Unicode normalization noise.

**A wrong number derived from real bytes is the hardest kind to see, and regularity is the
signal.** The ASR sweep costed all 120 clips at exactly 4.56 seconds because `wavDurationMs`
read the data size from offset 40, which is right only for a canonical 44-byte header. Fixed
in `packages/eval/src/wav.ts`. **The recorded spend of that run is understated ~3.5× and is
left standing with a note.** Amendment 77.

**The one module that spends money was the one module no test could reach.** `runner.ts` took
`transcribe` as a dependency while importing `loadTsv` and `fetchClips` directly, and
`--budget-usd` was checking `spent >= budget` — which permits the call that crosses the
ceiling. Amendment 75. Ask of any dependency that is imported rather than injected: what can no
longer be tested because of it?

**Every FLEURS dev split is single-gender in its entirety.** `my_mm` 384 FEMALE, `ha_ng` 296
FEMALE, `yo_ng` 378 MALE, `jv_id` 295 MALE — the whole split, not the sample, so risk 2's
"report the gender split" mitigation reports a constant. **`distinctIds` is the column doing
that work.** Amendment 76.

**A replay that trusts stored aggregates is not a replay.** The ASR runlog's `score` lines
carry per-clip edit counts, not rates, and `reconstructRun` recomputes. The LLM runlog follows
the same rule harder: a `seg` line carries the input and reference once, `llm` lines carry each
arm's output, and every metric is recomputable from those strings. **The reader is unbuilt** —
see the debt list.

**At n=30 the ratio is noisier than the CER it is computed from, and it moves every language at
once.** `my-MM` went 0.064 → 0.084 under a different sampling strategy, which took `ha-NG` from
0.91 to 0.67 **without either language changing**, because `my-MM` is every ratio's
denominator. Tar order itself shows no measurable bias. Amendment 81.

**`tiers.json` separates the evidence from the claim, and only the evidence merges.** `runs`
and `measurements` accumulate; `languages` is **derived** from them on every publish. **A
measurement only sets a tier if it came from the provider `chooseProvider` would use** —
otherwise deliberately probing Groq on Burmese, which this project does, would publish
romanized non-words as Burmese's tier. Amendment 79.

**Turbo will replay a cached `gen` and leave a generated file stale.** `results/` is now a
`globalDependencies` entry — ask the same question of any generated file whose source lives
outside its own package.

**A test that hard-codes a seeded tier breaks the day that language is measured.** Registry
tests use `af-ZA` now, chosen because nothing has measured it.

**A refusal to score beat a plausible number, twice in one run.** `normalizeForScoring` threw
rather than treat Burmese as Unicode with no Zawgyi converter supplied, and `wer()` returned
`null` for Burmese rather than a whitespace-tokenized fiction.

**Every throughput number here was measured on a clip too short to mean anything.** A
16.6-minute recording diarized at **0.656×** against 0.36–0.51× for every 11–34 s clip.
**Weight by duration.** Amendment 56.

**Real audio is where the reconcile thresholds fail, and `purityReviewBelow: 0.6` fails
worst** — the sub-0.7 purities were 0.589, 0.595, 0.60, 0.60, 0.64, then a gap to 0.70. Two
flagged, three not, **0.006 apart**. Amendment 57.

**A high per-word confidence is not evidence the words are real.** S9's Vietnamese
hallucination over Burmese audio scored a mean word probability of **0.892**. Amendment 53.

**A `mem_limit` larger than the host's memory is not headroom, it is a disabled limit.**

**A comment is not an install line.** Check the list, not the prose above the list
(amendment 49).

**A registry that grows a second workload grows a second unit** (amendment 50).

**Run it. Build it. Start it.** Every defect in the last four sittings came from doing that and
none from re-reading code — and this sitting is the clearest case yet: 44 unit tests were green
while two branches of one regex would have failed every arm in every language.

**Ask what shape the real caller passes, not what shape is convenient to construct.**

**A test the system can answer from cache is not a test.** The sidecar contract test mints a
fresh idempotency key every run.

**A race-sensitive assertion belongs in `beforeAll`, not a test body.**

**A `spikes/*.mjs` that imports `@thibi/*` cannot be run from anywhere.** ESM resolves bare
specifiers from the importing *file's* directory; copy it into `packages/engine` or `apps/cli`.

**A timing assertion nobody deliberately chose is a test of the machine.** **Assert on the
aggregate, not inside the loop.**

**`hookTimeout` and `testTimeout` in `vitest.config.ts` do nothing** once `test.projects` is
used. Put the timeout on the individual `beforeAll`/`afterAll`/`it`.

**One probe is not a measurement, and S7 is the proof.** `gpt-4o-transcribe-diarize` on
`language=mya` returned correct Myanmar script once and then twenty distinct wrong-script
transcripts over twenty identical requests. **1 in 21.**

**Plans predate the code — check the deliverables table against the tree first.** Amendments
28–84 in [`00-overview.md`](./00-overview.md) are the running record.

**A merge must retire a speaker from identity matching.** `persistDiarization` filters
`is_merged_into is null`.

**Speaker keys never reuse a gap.** **Diarization must never gate the transcript.**
**Reconcile sorts words itself, and must.**

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`. `noUncheckedIndexedAccess` is on too; the house pattern is `!`.

**`resolveJsonModule` is off repo-wide.** Read fixtures with `readFileSync`.

**Script integrity is a screen, not a guarantee.** It scores in-script non-words 1.00.

**`SettingsPort` is a flat key/value port.** **Two storage key schemes coexist deliberately.**
**Test-DB templates are per process**, named `thibi_test_template_${pid}`.

---

## Open questions the user has to answer

1. **Does anyone sign off `my-MM`?** Nothing is `verified` until a person writes
   `results/human-review/my-MM.json` against the current run id. The alternative is accepting
   that the product ships with no verified language and saying so in the UI, which is
   defensible and is a choice rather than a default.
2. **Which LLM provider and model should the editorial passes actually use?** This session
   measured `openai/gpt-oss-20b` on Groq because those keys exist here and it is small, which
   §6.1 argues for on the evidence that restraint beats capability. Nothing has compared it
   against anything. The gate makes that comparison cheap and it is a product decision.
3. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether
   a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell.
4. **Is there a real multi-speaker recording in a long-tail language** to use as a diarization
   reference? Half-answered: there is a 16.6-minute Burmese recording in local `testdata/` and
   the pipeline has run on it, but **there is no reference RTTM**. **Hand-labelling a few
   minutes of it is still the cheapest unblock in the project.**
5. **Is a hosted diarization service worth evaluating?** Evaluate in this order, because it
   kills candidates fastest: long-tail coverage, then **data residency**, then whether it
   re-transcribes, then cost, then quality against pyannote — which needs question 4's RTTM
   first. **An evaluation is not a promise.**
6. **Risk 8, from Phase 2**: nothing proves a `DYNAMIC_BATCHING` submission is billed against
   the Dynamic Batch SKU. Needs a real invoice. Phase 14.
7. **Which Groq tier is this project's key on?** Now partly answered for LLM work and it is
   the binding constraint: see the environment notes.

---

## Known debt, recorded not hidden

- **The LLM runlog has no reader.** `thibi eval report --run <id>` handles ASR only, and
  refuses an LLM log by name rather than reconstructing nonsense out of it. Everything needed
  is in the file — a `seg` line per segment with input and reference, an `llm` line per arm
  with the output — so a replay would recompute every metric for $0.0000. Until it exists,
  **changing a metric means re-running the command**, which is nearly free because the
  responses are cached, but only while the cache survives.
- **`rates` carries no LLM token units**, so every LLM run reports `$0.0000` and says the
  spend is UNMEASURED rather than free. `--budget-usd` degrades with it: the ledger projects
  from a running mean of calls so far, so the ceiling is one call late exactly once. Seeding
  real token prices means reading them off a vendor page and dating them, the way
  `seed/rates.ts` already does for audio.
- **`.github/workflows/eval.yml` is manual-dispatch only, by decision.** The `GROQ_API_KEY`
  secret **is** set, and the file's first version **did not parse at all** — `secrets` is not
  a valid context in an `if`, and GitHub rejects the whole file rather than the step, so for a
  day it was a gate that did not exist. Fixed, then triggered, then parked: a six-language
  n=10 run passed three hours on a GitHub runner without finishing, at Groq's 8000-tokens-per-
  minute free tier. **What still runs free on every push** is `ci.yml`, which includes the
  parity fixture, the prompt snapshots and the **version-bump guard** — so a prompt edited
  without a version bump still fails CI. Only the part that spends money is parked.
- **`thibi eval translate` has never been run.** Built, unit-tested against a fake model, zero
  live evidence.
- **The cleanup run is n=10, not the plan's 30**, because of the TPM ceiling below. Read every
  number in it as a direction, not a magnitude.
- **An arm is scored over the segments that came back, and the control over all of them.**
  Groq 400s cost `yo-NG current` three of its ten segments, so a 7-segment arm was compared
  against a 10-segment control — and the three that failed are not a random three. The fix is
  to score every arm of a language over the **intersection** of the segments all arms
  returned, and to say how many that is. Until then, read any row whose `failed` count is
  non-zero as approximate, and note that this cuts the way that flatters the arm if the hard
  segments are the ones that fail.
- **The dry run overstates a cached run.** It printed `$0.412` for a run that cost `$0.0000`,
  because the estimate table has no cached column.
- **The ASR sweep's recorded spend is wrong.** $0.146 against a real ~$0.49, from amendment
  77's wav reader. Fixed forward; the run's log is left as it was written.
- **A runlog carries provider transcript text.** Fine for FLEURS, which is public. **A
  `--manifest` run over newsroom audio would put transcripts of `/testdata/` material into a
  public repo**, and nothing enforces the distinction. The LLM runlog now carries reference
  text too, on the same terms.
- **Only four languages have an ASR measurement, each on one gender and one provider.**
- **`yo-NG`'s 0.305 is 75% diacritics, and must not be quoted as a word-accuracy number.**
  Ignoring tone marks it is **0.065**. Amendment 80. This is the language the cleanup eval was
  expected to help most, and the first run says the restraint prompt does help it.
- **A diacritic-blind CER would name that class of failure** and is unbuilt. It must never be
  published for a script whose marks are not optional.
- **Phase 4b is built and barely measured.** `large-v3` has never been loaded on this box; do
  not try, S9 explains why (~6.7 GB against a 7.65 GB VM).
- **`thibi models pull` works by transcribing one second of silence** at a URL that 404s by
  design.
- **The contract test costs ~40 s** whenever the sidecar is up.
- **The container's 0.51× realtime is a macOS artifact.** **The estimate shown before a
  diarization is still S6's 0.6× constant.**
- **`persistDiarization` is not idempotent per run.** **`thibi speakers merge` has no unmerge.**
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
- **S7 has no throughput number at length**, and its 68 accepted codes are a Phase 5 queue.
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

- **Groq's free tier caps `openai/gpt-oss-20b` at 8000 tokens per minute, and one cleanup
  segment costs about 2000.** Locally that is two to four calls a minute; **on a GitHub runner
  it was closer to one**, and a 120-call run passed three hours without finishing. Plan around
  it or pay for a bigger bucket. A second pass is near-instant because every response is
  cached — but only responses that *succeeded* are cached, so a run full of failures gets no
  cheaper on repeat.
- **`openai/gpt-oss-20b` is a reasoning model**, confirmed against the live API: responses
  carry `completion_tokens_details.reasoning_tokens`, so with no cap it spends an unbounded
  number of them before writing the JSON. `max_completion_tokens` is now 4000 in
  `apps/cli/src/llm.ts`. Unbounded, it is both slow and the provider's own stated cause of the
  `json_validate_failed` 400s. **Check this before choosing any new model**: a reasoning model
  with no output cap will look like a rate-limit problem.
- **A `Retry-After` is now believed only up to 60 seconds.** `withRetry` honours it
  unconditionally, which is right for a window measured in seconds and dangerous for one
  measured in hours: a 40-minute wait, obeyed three times, is **indistinguishable from a hang**
  from outside the process — no output, no error, and a CI job killed at six hours having
  measured nothing. Past the ceiling the wait is dropped, the retry budget is spent in under
  two minutes, and the segment fails with the provider's message attached.
- **Groq returns HTTP 400 `json_validate_failed` on a minority of calls**, more often on
  Burmese, Yoruba, Somali and Xhosa than on Hausa. It is counted as a failed segment and the
  message reaches the report, and it is the reason a 10-segment arm can score 7. **At least
  some of them say why**: `failed_generation: "max completion tokens reached before generating
  a valid document"`. Nothing sets `max_completion_tokens` in `apps/cli/src/llm.ts`, so the
  provider's default cap applies — and a non-Latin script costs several tokens per character,
  so the languages this product exists for are exactly the ones that hit it. **Setting an
  explicit, generous cap is the first thing to try**, and it is cheap to check because a
  segment that failed was never cached. Others come back with `failed_generation: ""` and are
  still unexplained.
- **The chat models this key can reach** (checked 2026-08-14): `llama-3.1-8b-instant`,
  `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`,
  `groq/compound`. `--models` is required and has no default, deliberately.
- **This machine ran out of disk on 2026-08-13, and the way it presented is worth knowing.** At
  99 % full the `rates` query *hung* rather than failing, and so did `docker ps`. Docker
  Desktop had quit its VM **leaving `com.docker.backend` resident and holding the socket**.
  Freeing space is not enough: `osascript -e 'quit app "Docker Desktop"'`, then
  `pkill -f com.docker.backend` (and `kill -9` the survivors), then `open -a Docker`.
  **`Docker.raw` reading 60 GB in `ls` is sparse** — `du` says ~7.7 GB. **If a database hangs
  rather than refusing, check `df` before anything else.**
- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000).
  The sidecar is behind a profile and needs the repo-root `.env` passed explicitly:
  `docker compose --env-file .env -f infra/compose.dev.yml --profile diarize up -d sidecar`.
- On macOS prefix docker commands with
  `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`. There is no `timeout` here.
- **`SIDECAR_URL` unset means this box does no diarization**, which is supported.
- **Run `thibi db migrate` against the dev database after pulling.**
- **`thibi eval asr` and the LLM evals cache into `.thibi-cache`**, gitignored. Delete it
  freely; a rerun refetches — and for the LLM evals that means paying again. `--results-dir`
  moves the outputs; use it for any run you do not want published.
- **`/testdata/` is gitignored and holds real recordings.** Third-party, some editorially
  sensitive, and this repo is public. Do not `git add -f` in there and do not name a source in
  any committed file — including this one.
- **`THIBI_TMP_DIR` must exist before you set it.**
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`,
  `OPENAI_API_KEY` and `GROQ_API_KEY`. **A CLI eval run needs it exported** —
  `set -a && source .env && set +a`.
- **Run `pnpm test` with the services up**, and **re-run before believing a red DB suite**: a
  cold run after a big build reported 3 hook timeouts that a warm run did not, again this
  sitting.
- **`git` leaves a stale `.git/index.lock`, and it is now routine.** Run
  `ps aux | grep "[g]it"` — the bracket matters — and remove the lock when nothing is there.
- **A stacked PR merges into its base, not into `main`.**
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
