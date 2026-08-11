# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-11, mid-Phase-3.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **about two-thirds.** Reconciler, identity matcher, schema and sidecar built and tested; `scribe.ts`, `persist.ts`, the CLI and the contract test are not |
| **4 — Whisper providers** | 4a done (OpenAI + Groq over HTTP); **4b now unblocked** — the sidecar image it needed exists |
| 5–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

Phase 3 is on branch **`phase-3/diarization`**, 7 commits ahead of `main`. `main` is still at the merge of PR #9.

On the branch: `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at **605
tests, nothing skipped**, with Postgres and MinIO up. `pnpm gen` is idempotent. The sidecar's
own suite is **30 pytest tests**, run separately (see below).

---

## Do this next

**Finish Phase 3.** In this order, because each unblocks the next:

1. **Ask the user to accept the third Hugging Face gate** — see *Open questions* below. It
   blocks every remaining end-to-end check, so raise it first even though nothing else waits
   on it.
2. **`persist.ts`** — write `diarization_runs`, `speaker_turns`, `speakers`, and the
   segment/word updates. The tables and the reconciler both exist; this is the seam between
   them and it is the last piece of pure logic.
3. **The CLI**: `thibi transcribe --diarize/--speakers/--min-speakers/--max-speakers/
   --diarize-source`, `thibi speakers list|rename|merge <jobId>`, `thibi diarize score <run>
   --reference turns.rttm`. The headline demo in the plan's Verification section — rename a
   speaker, re-transcribe, watch the name survive — is what proves the whole feature and
   nothing exercises `identity.ts` end to end until it exists.
4. **The contract test**: run `PyannoteSource` against the real container so the Python and
   TypeScript halves cannot drift. `/v1/tasks/by-key/{key}` exists specifically so the
   deterministic-id claim is checkable from outside.
5. **`scribe.ts`** last. It is the "this box cannot run pyannote" answer, not a default, and
   its cost and duration cap are still unconfirmed against the live API.

**Then Phase 4b** is a short hop: the image, the task registry and the single slot are all
built, so faster-whisper is `asr.py` plus `thibi models pull`.

**Alternative: Phase 5, the eval harness.** Still reasonable to prefer. Phase 4a left it 24
Groq codes marked `suspected`, and S7 has now added a second, larger work queue —
see *Open questions*.

---

## What you would otherwise rediscover

**Run it. Build it. Start it.** Every single defect this session came from doing that, and
none from re-reading code. Two in the sidecar image alone: `torchcodec` resolved from the
default index and linked CUDA (`libnvrtc.so.13`), in a Dockerfile whose comment explained
that exact hazard *for torch* one line above; and a **third** gated Hugging Face repo that
only appeared once the token was valid enough to get a 403 instead of a 401.

**One probe is not a measurement, and S7 is the proof.** `gpt-4o-transcribe-diarize` on
`language=mya` returned correct Myanmar script once — and then twenty distinct wrong-script
transcripts over twenty identical requests. **It was 1 in 21.** Phase 4a's lesson was that a
wrong answer can look healthy; this is worse, because the same request is right occasionally,
so a single sample is a coin flip presented as a measurement.
[`spikes/s7-mya-stability.mjs`](../spikes/s7-mya-stability.mjs) is the shape any language
claim has to take from now on.

**A plan's SQL is the fourth one to predate the code.** Phase 3 §4 said to add five columns
that Phase 1 had already shipped in `0000_init.sql`. Check the deliverables table against the
tree before implementing it; it has been worth the two minutes every time. Amendments 28–37
in [`00-overview.md`](./00-overview.md) are the running record.

**Two of my own test bugs looked like source bugs.** The brute-force Hungarian reference
pruned on `total >= best`, which is invalid with negative costs — and the identity matcher
passes `-overlapMs` deliberately — so it reported the solver wrong when the solver had found a
*better* answer. Then removing the prune left `best = total` unguarded. When a hand-written
reference disagrees with an implementation, suspect the reference.

**Don't put a wall-clock assertion in a test.** The 64×64 Hungarian timing bound passed alone
and failed inside the 36-file parallel run. It was measuring machine load.

**A red suite with a green test count is the DB teardown, not a bug.** Five suites create a
real Postgres database in `beforeAll` and drop it in `afterAll`, and vitest's 10 s default
hook timeout is not enough under load. With the sidecar container running, four suites failed
`Hook timed out in 10000ms` while all 605 assertions passed; stopping it made the same run
green in 20 s. `hookTimeout` is now 60 s in `vitest.config.ts`. If you see this again, check
what else is running before suspecting the database.

**`interjection-genuine` cannot protect the median filter's guards on its own.** Both guards
refuse that case, so deleting either still passes. The `-short-but-certain` /
`-long-but-uncertain` pair isolates them, and a separate test moves each threshold to prove
the flip *does* happen — otherwise the fixtures are green by accident.

**`purityReviewBelow: 0.6` lets a real second speaker through.** `interjection-genuine`
scores 0.64, just above the threshold, with a genuine interjection inside it. The number was
chosen, not measured. Recorded in the fixture; Phase 5 tunes it.

**Reconcile sorts words itself, and must.** The moving cursor in `assignWords` and
"neighbour" in `medianSmooth` both mean *temporal* order. Database order is `(segment idx,
word idx)`, which is usually the same and is not guaranteed to be across a merged chunk seam
— and the failure is a wrong answer, not an error.

**`exactOptionalPropertyTypes` is on**, so `{ progress: x ?? undefined }` does not type-check
against `progress?: number`. Build the object and assign conditionally. `noUncheckedIndexedAccess`
is on too and the house pattern is `!` — see `timing/interpolate.ts`.

**Nothing in a Whisper response envelope distinguishes a correct transcript from a confident
wrong-language one.** Groq on Burmese returned Khmer for `language=my` and Vietnamese on
autodetect, both HTTP 200, `avg_logprob` ≈ −0.6 — the same numbers as a correct English
control. Do not treat those fields as a quality signal.

**Script integrity is a screen, not a guarantee.** `packages/core/src/metrics/script.ts`
catches wrong-*alphabet* output. It scores Myanmar-script non-words 1.00, identically to a
correct transcript. Phase 5 still needs CER.

**`resolveJsonModule` is off repo-wide.** A JSON `import` type-checks under vitest's esbuild
and then fails `tsc -b`. Read fixtures with `readFileSync`.

**`SettingsPort` is a flat key/value port.** Any plan reading `ctx.settings.<ns>.<key>` is
wrong.

**Two storage key schemes coexist deliberately.** Phase 1 writes content-addressed
`assets/{sha[0:2]}/{sha}/source.{ext}`; Phase 8 writes `media/{uuid}/source.{ext}`, because a
streamed upload does not know its hash until the last byte. Do not unify them without moving
the `delete` on the dedupe path in `ingest/upload.ts`.

**Diarization must never gate the transcript.** ASR finishes a 1-hour file in about a minute;
pyannote takes ~1 h 40 m. `diarize` is its own `run_steps` row —
[`phase-03-diarization.md`](./phase-03-diarization.md) §6, an invariant. S7 did not disturb it,
because the hosted diarizing ASR that would have is not being added.

**Test-DB templates are per process.** `packages/db/src/testing.ts` names them
`thibi_test_template_${pid}`. Adding a DB-backed suite is safe; sharing a template name is not.

---

## Open questions the user has to answer

1. **Accept `pyannote/speaker-diarization-community-1` on Hugging Face** with the account that
   owns `HF_TOKEN` — https://huggingface.co/pyannote/speaker-diarization-community-1. The
   other two gates (`speaker-diarization-3.1`, `segmentation-3.0`) are already accepted; this
   third one is new in pyannote 4.x and its name appears nowhere in the model id we configure.
   **Everything end-to-end in Phase 3 is blocked on it.**
2. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether
   a 1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a
   requirement or an upsell. S7 removed the tempting escape hatch, so this question is now
   unavoidable rather than deferrable.
3. **Is there a real multi-speaker recording in one of the long-tail languages** we can use as
   a diarization reference? S7 scored English TTS with constructed boundaries, which is a floor
   on difficulty, and S6 measured throughput on an English podcast. Nothing has ever measured
   diarization *accuracy* on Burmese, and `thibi diarize score` needs an RTTM.
4. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed
   against the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Phase 14.
5. **Which Groq tier is this project's key on?** Live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH. A Phase 5 sweep exhausts the
   measured budget long before the documented one.

---

## Known debt, recorded not hidden

- **Phase 3 is unfinished**: `scribe.ts`, `persist.ts`, all three CLI commands, and the
  contract test. `PyannoteSource` exists but nothing calls it — no pipeline stage, no
  `run_steps` row, no wiring into `ctx.sidecar` (still typed `unknown`).
- **The sidecar's *loaded* path is unverified.** Blocked on open question 1. Everything up to
  the gate is measured: image builds, container starts, `/health` answers with real torch
  2.13.0+cpu / pyannote 4.0.7 / torchcodec 0.15.0+cpu versions and the three gate URLs.
- **The sidecar suite is not in `pnpm test`.** Run it by hand:
  `cd services/sidecar && uv run --python 3.11 --with 'fastapi>=0.115' --with
  'pydantic-settings>=2.5' --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest`.
  Wiring it into CI is unclaimed work.
- **S7 has no throughput number at length.** The 23-minute head-to-head against S6's podcast
  was submitted three times and never returned, the last abandoned after 38 minutes. The
  short-clip rate of 2.3–3.0× realtime does not extrapolate and the spike says so rather than
  estimating.
- **S7's language sweep is a Phase 5 work queue.** 68 codes accepted, and acceptance proved
  nothing for `mya`. Every accepted code is an unmeasured claim.
- **Phase 4b is unbuilt**: `services/sidecar/app/asr.py` is a 501 stub, `thibi models pull`
  does not exist. **No provider returns genuine per-word confidence except Google**, whose S2
  measurement stands.
- **`GENERATED_AT` is misnamed.** It means "the date of the freshest input". The honest name is
  `DATA_AS_OF`, but it is exported from `@thibi/languages`, mirrored in
  `ResolvedRegistry.generatedAt` and printed by `thibi --version`.
- **`ProviderCapabilities.limits.rpm` cannot express Groq's limits** — a daily request bucket
  and an hourly audio-seconds bucket. Both recorded as constants in `groq.ts`, unused, waiting
  for Phase 9's token bucket. `limits.rpm` is unread by anything today.
- **`transcribe` logs `plan: mode=…` twice**, the second time claiming the user passed
  `--mode sync` when they passed nothing. Pre-existing since Phase 1, cosmetic.
- **`research/language-support-whisper-vs-google.md` is cited in four places and is not in this
  repo.** Either import it or stop citing it.
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
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`
  and `GROQ_API_KEY`. `GROQ_TIER=dev` raises the request cap to 100 MB.
- **Run `pnpm test` with the services up.** With them down, suites skip themselves and one file
  reports as failed rather than skipped, which reads like a real failure.
- **The full run is ~20 s idle and ~65 s with the sidecar container up**, and the DB suites'
  teardown is what stretches. `hookTimeout: 60_000` covers it; the container is worth stopping
  anyway when you are iterating on tests.
- **`git` left a stale `.git/index.lock` twice this session**, both times after a `git mv` that
  failed. If a commit refuses with "Another git process seems to be running", check
  `ps aux | grep git` first and then remove it.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then
  ask the user to run `! gh pr merge <n> --merge` themselves — and do not re-check afterwards.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here.
  The Linux sidecar image is not subject to that and runs torch 2.13.0 / pyannote 4.0.7.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg makes English test audio.
  [`spikes/s7-make-2spk.mjs`](../spikes/s7-make-2spk.mjs) turns that into a two-speaker clip
  with millisecond-exact reference boundaries, which is the cheapest honest way to score a
  diarizer.
