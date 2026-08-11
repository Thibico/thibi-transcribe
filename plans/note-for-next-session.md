# Note for the next session

**Read this first.** It is the handoff between sessions: what is done, what is next, and the
things you would otherwise have to rediscover. It is rewritten at the end of every session —
see the *Session handoff* section of [`../AGENTS.md`](../AGENTS.md).

**Last updated:** 2026-08-11, after Phase 4a.

---

## Where the build is

| Phase | State |
|---|---|
| 0 — spikes, monorepo, language registry | done |
| 1 — engine core, Google sync, CLI | done |
| 2 — batchRecognize, GCS staging, rates | done |
| **3 — diarization** | **not started.** Premises measured (S6); one new premise to re-check, see below |
| **4 — Whisper providers** | **4a done (OpenAI + Groq over HTTP); 4b not started** — faster-whisper needs Phase 3's sidecar |
| 5–7, 9–15 | not started |
| 8 — ingest | engine + CLI done; web routes deliberately not built |

Phases 8 and 4a were both taken out of build order deliberately, for the same reason: each needs
only Phases 0–2 and fits one session, while Phase 3 does not.

**On the branch `phase-4/whisper-http`, four commits, not yet pushed or merged.** CI has not run
on it. Locally: `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green at 543 tests
with nothing skipped, and `pnpm gen` is idempotent.

---

## Do this next

**First, five minutes of housekeeping:** push `phase-4/whisper-http`, open the PR, and ask the
user to merge it — the permission classifier usually blocks `gh pr merge`, so hand them the
command rather than retrying.

**Then, recommended: Phase 3 — diarization.** Budget two sessions. It is now the only thing
blocking Phase 4b, and S6 already answered the hardware question, so the sessions go on the
sidecar image and the reconciliation algorithm rather than on discovering a product constraint.

**Settle one thing on day one, before building anything.** OpenAI's docs (read 2026-08-11)
describe a **`gpt-4o-transcribe-diarize`** model with a `diarized_json` response format. Phase 3
is built on the premise that diarization means pyannote on our own hardware at ~1 h 40 m per
audio-hour. A hosted diarizing ASR did not exist when that premise was formed. Probe it — one run,
against the 2 s clip and something longer — before committing to the sidecar as the only path.
Nothing about it is measured: no language coverage, no quality, no price. It also would not
inherit §6's invariant for free, because a diarizing ASR *replaces* the transcript rather than
annotating one. There is a note at the top of Phase 3's Risks section.

**Alternative: Phase 5 — the eval harness.** Phase 4a exists to give it comparators, and it now
has 24 Groq codes marked `suspected` that are literally its work queue. Reasonable to prefer if
you would rather bank the measurement machinery than build a sidecar.

---

## What you would otherwise rediscover

**Run it. Every single time, this is where the defects are.** Phase 4a had four, and the test
suite was green for all of them: a word-attachment bug that only a *recorded* response exposed
(hand-written fixtures have tidy round numbers and real segment boundaries abut exactly); a
hallucination guard in the plan that contradicted itself and could never have fired; a Groq
repetition loop producing 96 words across 30.4 s for 2 s of audio; and a `?? DEFAULT_MODEL`
fallback in the CLI that discarded the null a correctly-written, correctly-tested resolver
returned. The last one is the sharpest lesson — **the unit test tested the function, and the bug
was in the line that threw its answer away.**

**Record real provider responses as fixtures; do not write them.** Every file in
`packages/engine/src/providers/whisper/__fixtures__/` is what an API actually returned on
2026-08-11, with the response headers kept, and its README says what each one pins.
`__tests__/record-fixtures.mjs` regenerates them. This is now the pattern to follow for any new
provider.

**Nothing in a Whisper response envelope distinguishes a correct transcript from a confident
wrong-language one.** Groq on Burmese returned Khmer for `language=my` and Vietnamese on
autodetect, both HTTP 200, `avg_logprob` ≈ −0.6 and `no_speech_prob` ≈ 0.05 — the same numbers as
the correct English control. Do not build anything that treats those fields as a quality signal.

**Script integrity is a screen, not a guarantee.** `packages/core/src/metrics/script.ts` catches
wrong-*alphabet* output. It scores Myanmar-script non-words 1.00, identically to a correct
transcript. Phase 5 still needs CER against a reference; the test asserts the miss so nobody reads
a 1.00 as a pass.

**`resolveJsonModule` is off repo-wide.** A JSON `import` type-checks under vitest's esbuild and
then fails `tsc -b` at the end of a run. Read fixtures with `readFileSync` instead.

**The plans predate the code in places, and Phase 4's did in four.** Check before implementing a
deliverables table. Amendments 28–34 in [`00-overview.md`](./00-overview.md) record what Phase 4a
found; expect the same in Phases 3, 5–7.

**`SettingsPort` is a flat key/value port.** Any plan that reads `ctx.settings.<namespace>.<key>`
is wrong. Limits and configuration arrive as explicit input to a stage.

**Two storage key schemes coexist deliberately.** Phase 1 writes content-addressed
`assets/{sha[0:2]}/{sha}/source.{ext}`; Phase 8 writes `media/{uuid}/source.{ext}`, because a
streamed upload does not know its hash until the last byte. Do not unify them without moving the
`delete` on the dedupe path in `ingest/upload.ts` — under content-addressing the loser of a race
writes the same bytes to the same key, so that delete would remove the winner's object.

**Diarization must never gate the transcript.** ASR finishes a 1-hour file in about a minute;
pyannote takes ~1 h 40 m. `diarize` is its own `run_steps` row —
[`phase-03-diarization.md`](./phase-03-diarization.md) §6, an invariant.

**Test-DB templates are per process.** `packages/db/src/testing.ts` names them
`thibi_test_template_${pid}` and sweeps dead pids. Adding a DB-backed suite is safe; adding one
that shares a template name is not.

---

## Open questions the user has to answer

1. **Typical recording length and deadline pressure** for the target newsrooms. Decides whether a
   1 h 38 m diarization wait is acceptable, and therefore whether the GPU tier is a requirement or
   an upsell. Open in Phase 3 and Phase 15 rather than guessed. **A `gpt-4o-transcribe-diarize`
   that works would change this question entirely**, which is another reason to probe it first.
2. **Risk 8, from Phase 2**: nothing yet proves a `DYNAMIC_BATCHING` submission is billed against
   the Dynamic Batch SKU rather than Recognition. Needs a real invoice. Belongs to Phase 14.
3. **Which Groq tier is this project's key on?** The live headers say 2000 requests/day and 7200
   audio-seconds/hour; the docs describe 300 RPM and 200k ASH. A Phase 5 sweep will exhaust the
   measured budget — two hours of audio per hour of wall clock — long before it exhausts the
   documented one, and knowing which is real changes how the harness is scheduled.

---

## Known debt, recorded not hidden

- **Phase 4b is unbuilt**: `services/sidecar/app/asr.py`, `thibi models pull`, and every
  `wordConfidence: true` claim in the Phase 4 plan. `buildProvider` refuses
  `--provider faster-whisper` with a message saying why. **No provider in the system currently
  returns genuine per-word confidence except Google**, whose S2 measurement stands.
- **`GENERATED_AT` is misnamed.** It now means "the date of the freshest input", not generation
  time. The honest name is `DATA_AS_OF`, but it is exported from `@thibi/languages`, mirrored in
  `ResolvedRegistry.generatedAt` and printed by `thibi --version` — an API change nobody has made.
- **`ProviderCapabilities.limits.rpm` cannot express Groq's limits** — a daily request bucket and
  an hourly audio-seconds bucket. Both numbers are recorded as constants in `groq.ts`, unused,
  waiting for Phase 9's token bucket to have a shape that fits them.
- **`limits.rpm` is unread by anything today.** Phase 9 owns it.
- **`transcribe` logs `plan: mode=…` twice**, the second time saying "requested explicitly with
  --mode sync" when the user requested nothing — the CLI plans, then passes its own decision to
  the engine as a `force`. Pre-existing since Phase 1, cosmetic, mildly misleading in logs.
- **`research/language-support-whisper-vs-google.md` is cited in four places and is not in this
  repo.** The strings it carried survive in `matrix-overrides.json` and the plan docs; the file
  itself does not. Either import it or stop citing it.
- **Phase 8's web routes are not built.** `/api/uploads`, `/api/ingest/batch`, `/api/imports` wait
  on Phase 10's auth and Phase 11's UI.
- **A live URL *download* has never been run** end to end — only `--resolve-only`.
- **The 2 GB flat-RSS memory test** in Phase 8's Definition of done is not in CI.
- **pyannote's GPU figure (8–20×) is inherited and unmeasured**, marked do-not-publish in Phase
  15's tier table.
- **A storage test flakes.** `packages/storage` `contract.test.ts > 's3' > accepts a stream exactly
  at maxBytes` failed once at 21.5 s against MinIO and passed on re-run. Seen once; not chased.

---

## Environment notes

- `docker compose -f infra/compose.dev.yml up -d` brings up Postgres (5433) and MinIO (9000). On
  macOS prefix with `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` — the Docker
  credential helper is not on a minimal PATH.
- `.env` carries `DATABASE_URL`, the `S3_*` keys, `APP_SECRET_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`
  and `GROQ_API_KEY`. `GROQ_TIER=dev` raises the request cap to 100 MB; it defaults to the
  pessimistic 25 MB.
- **Run `pnpm test` with the services up.** With them down, suites skip themselves and one file
  reports as failed rather than skipped, which reads like a real failure.
- Merging PRs is frequently blocked by the permission classifier. Push and open the PR, then ask
  the user to run `! gh pr merge <n> --merge` themselves — and do not re-check the result
  afterwards, they can see it.
- This machine is x86 macOS: torch stops at 2.2.2, so pyannote 4.x cannot be installed here. The
  Linux sidecar is not subject to that.
- `say -v Samantha -o out.aiff "…"` plus ffmpeg is a quick way to make English test audio when a
  provider needs a language the committed Burmese probe clip cannot exercise.
