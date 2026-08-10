# Working on thibi-transcribe

How this project is planned, executed and recorded. These are conventions the repo already
follows — every rule below has examples in `plans/`, `work-diary/` and the git history.

---

## Plans live in the repo

`plans/00-overview.md` holds context, confirmed decisions, the data model and the build
order. Each phase gets its own execution document, `plans/phase-NN-name.md`, indexed by
`plans/README.md`.

Every phase document has the same skeleton, so they read as one set: **Goal · Prerequisites ·
Deliverables table · Design · Porting notes · Tests · Verification · Risks and open questions
· Definition of done.**

A **Definition of done** is a checklist someone can verify *without reading the code* —
`thibi lang list --tier verified` prints one row, `pnpm gen` produces no diff, the JSON word
count equals `select count(*) from words`. If an item can only be checked by inspecting an
implementation, rewrite it.

A single throwaway plan file is not the deliverable. The plans are what the work is executed
against and handed off from.

---

## One phase at a time

Work the build order in `plans/00-overview.md`. Before writing code for a phase:

1. **Read that phase's document in full**, including its Risks section.
2. **Settle anything the plan says to decide on day one.** Phase 1 had two — does
   `await using` work under our tsconfig, and can the test role create databases? Both were
   five-minute checks that would have been painful retrofits. Check them first.
3. **Do everything that does not depend on a blocker.** If a dependency is missing, build and
   unit-test around it and say so; do not stall the whole phase.

Branch as `phase-N/short-description`.

---

## Measure, do not assert

This is the project's defining habit and the reason it exists: *accepting a language code
proves nothing*, and a provider returning HTTP 200 is not evidence of quality.

- **A spike without a recorded row is not done.** `spikes/RESULTS.md` carries the summary
  table; the analysis lives in the phase document; the instruments are committed so a
  disputed number can be re-measured rather than argued about.
- **Capability values are facts with provenance.** `S1_ADAPTATION` and `S2_WORD_CONFIDENCE`
  in `packages/engine/src/providers/google/capabilities.ts` are literals carrying their
  measurement date and what was measured. Never write a capability you have not checked and
  plan to verify later.
- **Run new code against real input before believing it.** Phase 1's seam merge passed 16
  unit tests and still had a windowing bug that only a real 100-second file exposed.
- **When measurement contradicts the plan, amend the plan.** Add a row to the *Amendments*
  table in `plans/00-overview.md` and correct the phase document inline. The design record
  must not still assert numbers the implementation disproved.

---

## Commits

A commit message explains **what changed and why it changed**, in prose. It is the durable
record of reasoning; the diff already shows the code.

Say, in roughly this order: what this commit does · what was measured or discovered · what
that forced · what remains open. Name the specific thing — `lib/export.ts:15-22` turned
59.9996 s into `00:00:59,1000`, not "fixed a rounding bug". (A bare `lib/…` path means the
old app being generalised, `~/Coding_work/myanmar-transcription`; see `plans/README.md`.)

**Record corrections, including your own.** If a first attempt was wrong, say so and say what
the right reasoning was. Several commits here do exactly that and they are the most useful
ones to read later.

End every message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_<id>
```

Commit at coherent boundaries — a package, a stage, a correction — not per file and not once
per day.

---

## The work diary

`work-diary/YYYY-MM-DD.md`, one file per working day, covering every commit made that day.
Indexed by `work-diary/README.md`. No commits that day means no file.

Each entry answers *what was worked on, what materially changed, and why*, and links each
commit to the plan document it executes against with working relative links. Group by sitting
rather than listing commits flatly.

**Make the corrections the visible output**, not a footnote. The things the plan got wrong
are what a reader six months from now actually needs. Write it after the commits, not instead
of them.

---

## Reporting

- **Skipped is not passing.** If a suite skipped because a service was unreachable, say so
  and say what it would have covered. Never fold skipped tests into a green count.
- **Say what is blocked and what you left out**, explicitly, rather than reporting completion
  and hoping. Scaling the work down is the user's call.
- **Do not claim a Definition-of-Done item you have not run.** Phase 1 left the live smoke
  test and the `FakeFfmpeg` e2e harness open, and said so.
- Prefer plain statements of outcome. If tests fail, show the output.

---

## Comments carry findings

Many comments in this repo encode operational findings that are not re-derivable by reading
the code. When porting, **the comments travel with the code**:

- the re-encode-not-`-c copy` note in `packages/engine/src/audio/cut.ts` documents a real
  Google rejection;
- the 16 kHz mono downmix note in `packages/engine/src/audio/normalize.ts` records a measured
  accuracy difference;
- the back-half-of-window rule in `packages/engine/src/audio/plan.ts` explains a non-obvious
  heuristic.

Equally, **delete what was measured false rather than porting it**. The old app's Google
region doctrine appeared in four places and was wrong; it is gone, and a test asserts no
error message names a region.

Where a rule is enforced by tooling, explain it at the point of enforcement — and if a grep
would then trip over its own documentation, fix the grep, not the documentation.

---

## Architectural invariants

Enforced by ESLint, tests and CI. Full reasoning in `plans/00-overview.md`.

| Rule | Enforced by |
|---|---|
| Engine packages read no ambient configuration — no `process.env`, `process.cwd()`, `__dirname` | ESLint + CI grep + `tests/lint-rules.test.ts` |
| Dependency direction is one-way: `core ← languages ← db ← engine ← apps` | same |
| `apps/cli/src/context.ts` is the only environment reader, with an exhaustive key list | review |
| No region constraint asserted in code | CI grep + a provider test |
| The language is data, never a literal | review |
| `drizzle-kit push` is banned; migrations are forward-only and never edited after being applied | checksum in the migration runner |
| The generated language registry is committed and drift-checked | `pnpm gen && git diff --exit-code` in CI |

Run before committing: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

Database- and MinIO-backed suites skip themselves when the services are down. Start them
with `docker compose -f infra/compose.dev.yml up -d`. On macOS the Docker credential helper
is not on a minimal `PATH`; prefix with
`PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`.
