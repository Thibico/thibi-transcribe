# Phase 13 — UI: speakers, glossary, export dialog

## Goal

At the end of this phase a transcript is **attributable, correctable and shippable**. Phase 12
made segment text editable at 90-minute scale; on its own that produces a wall of anonymous
sentences with no way to say who spoke, no way to fix the name the recogniser mangled forty
times, and a download button that cannot choose which editorial layer it is downloading. Phase
13 adds the three surfaces that turn the editor into a working tool: a speaker chip with
run-aware reassignment, glossary management with an in-editor capture path, and an export
dialog with a live client-side subtitle preview. It sits here because all three depend on the
virtualized list, the layer resolution and the playback store built in Phase 12, and because
Phase 14 (settings and admin) is configuration work that nobody needs until the editing loop is
complete.

## Prerequisites

| Needs | From | Used for |
|---|---|---|
| `speakers`, `speaker_turns`, `segments.speaker_id/purity/needs_speaker_review` | Phase 3 | everything in §1 |
| Hungarian re-diarization identity preservation | Phase 3 (`reconcile.ts`) | the guard that makes a rename durable |
| `glossaries`, `glossary_terms`; the entity substitution pass | Phase 6 | §2 |
| `packages/core/src/export/*` — reflow, bidi, writers | Phase 7 | §3 live preview and the download route |
| `documents` rows (summary / chapters / quotes with `segmentIds`) | Phase 6 | §4 |
| `editor-shell`, `segment-list`, `segment-row`, `segment-text`, `use-playback`, `use-segment-mutations`, virtualizer + `measureElement` | Phase 12 | host for all new UI |
| `requireUser()` / `action()` wrapper, `updated_at` preconditions | Phase 10 / 12 | every mutation here |
| shadcn `Popover`, `Dialog`, `Command`, `Select`, `Tabs`, `Toast`, `DropdownMenu` | Phase 11 | — |

## Deliverables

### Migrations

| Path | Purpose |
|---|---|
| `packages/db/migrations/0013_speaker_source.sql` | `segments.speaker_source text not null default 'reconcile' check (speaker_source in ('reconcile','human'))` — the flag that lets a re-diarization skip human decisions |
| `packages/db/migrations/0014_glossary_notes.sql` | `glossary_terms.notes text`, `glossaries.archived_at timestamptz` |
| `packages/db/migrations/0015_job_glossaries.sql` | `jobs.glossary_ids uuid[] not null default '{}'` — pinned glossaries survive a re-run |

### Engine

| Path | Purpose |
|---|---|
| `packages/engine/src/speakers/assign.ts` | `renameSpeaker`, `assignSegment`, `assignRun`, `undoAssignment` — the run-extent computation lives here, not in React |
| `packages/engine/src/speakers/merge.ts` | `mergeSpeakers`, `deleteSpeaker` with the `is_merged_into` redirect |
| `packages/engine/src/glossary/repo.ts` | CRUD + `usedInJobs(glossaryId)` + duplicate detection |
| `packages/engine/src/glossary/csv.ts` | parse/serialise the interchange dialect; BOM, CRLF, pipe-separated variants |
| `packages/engine/src/diarize/reconcile.ts` *(modified)* | one guard: never overwrite `speaker_source = 'human'` |

### Web — speakers

| Path | Purpose |
|---|---|
| `apps/web/components/editor/speaker-chip.tsx` *(modified)* | Phase 12 shipped it read-only; add the popover trigger, review state, colour |
| `apps/web/components/editor/speaker-popover.tsx` | rename globally / reassign this / reassign this-and-following |
| `apps/web/components/editor/speakers-dialog.tsx` | toolbar "Speakers (N)" — rename, merge, delete |
| `apps/web/components/editor/speaker-review-nav.tsx` | "12 to check" counter + `Alt+S` jump |
| `apps/web/lib/speaker-colors.ts` | the 8-colour ramp, light and dark |
| `apps/web/app/actions/speakers.ts` | server actions wrapping the engine functions |

### Web — glossary

| Path | Purpose |
|---|---|
| `apps/web/app/(app)/glossaries/page.tsx` | list: name, scope, language, terms, used in N jobs |
| `apps/web/app/(app)/glossaries/[id]/page.tsx` | the editable table |
| `apps/web/components/glossary/term-table.tsx` | inline add-row, chip editor for variants |
| `apps/web/components/glossary/variant-chips.tsx` | also-written-as input |
| `apps/web/components/glossary/csv-dialog.tsx` | import with dry-run preview; export link |
| `apps/web/components/glossary/glossary-picker.tsx` | multi-select on the job page; budget warnings |
| `apps/web/components/editor/add-to-glossary.tsx` | selection → floating button → prefilled dialog |
| `apps/web/components/editor/use-text-selection.ts` | span + textarea selection, row-anchored |
| `apps/web/app/actions/glossary.ts` | server actions |
| `apps/web/app/api/glossaries/[id]/export/route.ts` | CSV download |

### Web — export and documents

| Path | Purpose |
|---|---|
| `apps/web/app/(app)/jobs/[id]/layout.tsx` *(modified)* | render the `@modal` slot |
| `apps/web/app/(app)/jobs/[id]/@modal/default.tsx` | returns `null` — without it a hard nav 404s the slot |
| `apps/web/app/(app)/jobs/[id]/@modal/(.)export/page.tsx` | intercepting route |
| `apps/web/app/(app)/jobs/[id]/export/page.tsx` | plain-page fallback (`Cmd+click`, reload, shared link) |
| `apps/web/components/export/export-form.tsx` | the shared control set, used by both routes |
| `apps/web/components/export/subtitle-preview.tsx` | first-6-cue live preview via `packages/core` |
| `apps/web/app/api/runs/[id]/export/route.ts` | the download; ports the RFC 5987 header |
| `apps/web/components/editor/document-panel.tsx` | read-only summary / chapters / quotes |
| `apps/web/components/editor/run-toolbar.tsx` *(modified)* | "Export…", "Speakers (N)", review counter, Documents tab |

### Tests

| Path | Purpose |
|---|---|
| `packages/engine/src/speakers/__tests__/assign.test.ts` | run-extent semantics |
| `packages/engine/src/speakers/__tests__/merge.test.ts` | merge + re-diarization redirect |
| `packages/engine/src/glossary/__tests__/csv.test.ts` | the four dialect fixtures |
| `apps/web/components/export/__tests__/preview-parity.test.ts` | preview ≡ `thibi export`, byte for byte |
| `apps/web/app/api/runs/[id]/export/__tests__/filename.test.ts` | non-Latin filename round-trip |

---

## Design

### 1. Speaker labelling

#### Why speakers are a table

The design decision this section exists to cash in: `speakers` is keyed on `job_id`, not
`run_id`, and carries `display_name`. So "Speaker 01 is Daw Aung San Suu Kyi" is **one row**.
A global rename is:

```sql
UPDATE speakers SET display_name = $2, updated_at = now()
 WHERE id = $1 AND job_id = $3;
```

One statement, no fan-out over 1,400 segments, and it survives re-transcription because
Phase 3's re-diarization maps new pyannote labels onto existing `speakers` rows by Hungarian
assignment on the overlap matrix. Had `speaker` been a string column on `segments`, this would
be a 1,400-row `UPDATE` that a re-run silently reverts.

#### The chip popover

Trigger: the chip in the segment row gutter. shadcn `Popover`, opens on click and on `Enter`
when focused.

```
┌──────────────────────────────────────┐
│  ● Speaker 02                        │
│  ────────────────────────────────    │
│  Name                                │
│  [ Daw Khin Myo Chit          ]  ⏎   │  ← renames everywhere in this job
│                                      │
│  Reassign this segment to            │
│  ○ Speaker 01 · U Thant              │
│  ● Speaker 02 · Daw Khin Myo Chit    │
│  ○ Speaker 03                        │
│  + New speaker                       │
│                                      │
│  [ Apply to this and 6 following ]   │  ← the run fix
│                                      │
│  ⚠ Uncertain — purity 0.42           │
│  [ Confirm as Speaker 02 ]           │
└──────────────────────────────────────┘
```

**"This and all following until the next speaker change."** pyannote errors arrive in runs, not
singletons: a mis-clustered stretch of one side of an interview is typically 5–30 consecutive
segments. The extent is computed server-side so the label on the button is truthful before the
click:

```ts
// packages/engine/src/speakers/assign.ts
export function runExtent(segments: SegmentRow[], fromIdx: number): string[] {
  const start = segments.findIndex(s => s.idx === fromIdx);
  const speaker = segments[start].speakerId;          // may be null
  const ids: string[] = [];
  for (let i = start; i < segments.length; i++) {
    if (segments[i].speakerId !== speaker) break;      // the next speaker change
    ids.push(segments[i].id);
  }
  return ids;
}
```

Boundary rules, all tested:

| Case | Behaviour |
|---|---|
| the clicked segment is the only one with that speaker | extent = 1; button reads "Apply to this segment" and collapses into the radio list |
| speaker is `null` (no diarization, or `has_words = false` fallback) | extent runs over the contiguous `null` block; the button says so |
| a superseded segment (human split) sits inside the block | skipped by the query (`superseded_at IS NULL`), so a split never truncates a run |
| the extent reaches the end of the run | fine; no special case |

Applied as one statement plus one audit row:

```sql
UPDATE segments
   SET speaker_id = $1, speaker_source = 'human',
       speaker_purity = NULL, needs_speaker_review = false, updated_at = now()
 WHERE id = ANY($2) AND run_id = $3
RETURNING id, speaker_id AS new_id;
```

The prior `(segment_id, speaker_id, speaker_source)` triples go into `audit_log.data`, and the
toast offers **Undo** for 10 s, which calls `undoAssignment(auditId)` and writes them back.
Twenty clicks became one click plus a safety net.

`speaker_purity` is set to `NULL` rather than `1.0` on a human assignment: purity is a
*measurement* of the reconciler's confidence, and a human decision is not a measurement. The UI
reads `speaker_source = 'human'` and shows a small solid dot instead of a purity number.

#### The reconcile guard

One change to Phase 3, and the reason `0013` exists:

```ts
// packages/engine/src/diarize/reconcile.ts — step 3, per segment
if (segment.speakerSource === 'human') continue;   // never overwrite a human decision
```

Without it, re-running diarization after a correction pass silently discards every manual
assignment, which is the worst possible failure: invisible, and only noticed at export.

#### The Speakers dialog

Toolbar button reads `Speakers (4)`. shadcn `Dialog`, table:

| Col | Content |
|---|---|
| ● | colour swatch (`color_idx`) |
| Name | inline-editable; blank shows the `key` in muted type (`speaker-02`) |
| Segments | count — needed to make delete safe, nothing more |
| First heard | timecode + ▶ that seeks and closes the dialog |
| | ⋯ menu: Merge into…, Reassign all to…, Delete |

**Merge is the most common correction.** pyannote over-segments far more often than it
under-segments — one person becomes `speaker-01` and `speaker-04` after a cough or a mic bump.
Merge is:

```ts
// packages/engine/src/speakers/merge.ts
await tx.update(speakers).set({ isMergedInto: targetId }).where(eq(speakers.id, loserId));
await tx.update(segments).set({ speakerId: targetId }).where(eq(segments.speakerId, loserId));
await tx.update(words).set({ speakerId: targetId }).where(eq(words.speakerId, loserId));
```

The loser row is **kept**, not deleted. `is_merged_into` exists precisely so that a later
re-diarization whose Hungarian assignment lands on the old speaker gets redirected to the
target instead of resurrecting a merged identity. Resolution is one hop, asserted acyclic
(merging A→B then B→A is rejected).

Selecting two or more rows enables "Merge N speakers" with a target picker defaulting to the
one with the most segments. Delete is blocked while segments reference the speaker; the dialog
offers "Reassign 42 segments to… then delete".

**Cut from this dialog, deliberately:** talk-time percentages, interruption counts,
words-per-minute, any cross-job speaker identity, voice prints. The segment count is here
because delete needs it, not as the beginning of an analytics panel.

#### Colour and review state

```ts
// apps/web/lib/speaker-colors.ts
export const SPEAKER_COLORS = [
  { name: 'slate',  chip: 'bg-slate-100  text-slate-700  dark:bg-slate-800/60  dark:text-slate-200',  border: 'border-l-slate-400'  },
  { name: 'blue',   /* … */ }, 'amber', 'emerald', 'violet', 'rose', 'cyan', 'orange',
] as const;                     // 8 entries; speakers.color_idx % 8
```

Rendering rule: **the chip, plus a 2 px left border on the row. Never a row background.**
Phase 12 already spends the row background on the active-playback highlight and the text
channel on the low-confidence dotted underline. A third background treatment makes all three
illegible, and it fights complex-script rendering — a tinted background behind stacked Myanmar
diacritics reads as a smudge. Colour is also never the only signal: the chip always carries the
name or key, so an 8-way categorical ramp does not have to survive a colour-vision test alone.

`needs_speaker_review` segments (purity < 0.6, or any `has_words = false` fallback) get a
**dashed** chip border, a trailing `?`, and `title="Speaker uncertain — 0.42 of this segment's
audio matched Speaker 02"`. Toolbar shows `12 to check`; `Alt+S` / `Shift+Alt+S` jump next and
previous, reusing Phase 12's `useJumpTargets` with a second target list rather than a parallel
mechanism. "Confirm as Speaker 02" in the popover clears the flag and sets
`speaker_source = 'human'` — confirming is a decision and must be as durable as changing.

---

### 2. Glossary management

#### Why a table, not a modal per term

A newsroom glossary is 40–400 short rows that get edited in bursts: someone sits down after a
transcript and enters eleven names. Any UI that costs a modal open, a form, and a save per row
turns eleven entries into eleven minutes and the eleventh never gets typed. `/glossaries/[id]`
is a plain editable grid with a permanently-present blank last row.

#### Columns

| Column | DB | Notes |
|---|---|---|
| Source term | `term` | the canonical, correct spelling. What the entity pass substitutes **to**, and what feeds the Google phrase set if spike S1 said yes |
| Also written as | `variants[]` | chip input. What the entity pass substitutes **from** — i.e. the ASR's actual mistakes |
| Type | `kind` | person · org · place · term · acronym |
| Preferred translation | `translations` jsonb | one chip per target language, `en: Aung San Suu Kyi`. A 🔒 sets `do_not_translate` and greys the cell |
| Notes | `notes` (new) | free text — "the paper spells it without the hyphen" |
| Boost | `boost` | **hidden unless `adaptation` is available** for at least one configured provider. If S1 came back negative the column does not render and the page header says "Pre-recognition biasing is unavailable on the models you have configured; terms are applied by the post-transcription entity pass." |

One term row feeds three consumers (overview): phrase set, substitution pass, translation
lexicon. The column layout mirrors that so an editor can see which fields matter for which.

#### Inline add-row

The last row is always empty. Typing anywhere in it creates a client-side draft; `Tab` off the
last cell or `Enter` commits via `upsertTerm` and appends a fresh blank row with focus in the
first cell. Optimistic — the row renders immediately with a subtle pending state and reverts
with a toast on failure. Duplicate `term` inside one glossary returns 409; the row turns amber
with **"Already in this glossary — merge the variants?"** and a one-click merge that unions
`variants[]` rather than making the user find the existing row.

Delete is a row-hover `×` with an undo toast, not a confirmation dialog. Terms are cheap;
confirmation dialogs on cheap things train people to click through confirmation dialogs on
expensive things.

#### Scope

`instance | project | job`, set at creation. `/glossaries` groups by scope with the count and
"used in N jobs". Resolution at run time (established in Phase 6, restated in the page footer
so it is discoverable): **instance → project → job, later wins on a conflicting variant.** A
job-scope glossary is created lazily the first time someone uses "Add to glossary" from that
job's editor and nothing else is writable.

Deleting a glossary that any `editorial_passes.glossary_ids` references is **blocked** —
provenance has to stay resolvable, since a pass row claims "these terms were applied". Offer
`archived_at` instead: hidden from pickers, still resolvable, restorable.

#### CSV import / export

Dialect, documented in the import dialog and in the exported header comment:

```csv
term,variants,kind,translations,do_not_translate,notes
ဒေါ်အောင်ဆန်းစုကြည်,ဒေါ်အောင်ဆန်းစုကြည,|ဒေါ်စု,person,en=Aung San Suu Kyi,false,
NLD,အင်္ဂလိပ်လို NLD|အန်အယ်လ်ဒီ,org,en=NLD,true,do not expand on first use
```

- **Variants are pipe-separated**, not comma-separated inside a quoted field. Commas appear
  inside real terms far more often than pipes do, and a quoted-comma list is the single most
  common thing a newsroom's spreadsheet export gets wrong.
- **Translations are `lang=value` pipe-separated** for the same reason.
- Import strips a UTF-8 BOM before parsing the header. Excel writes one; without stripping,
  the first column is named `﻿term` and every row imports with an empty term. This is a
  test fixture, not a footnote.
- CRLF, LF and lone-CR all accepted.

Import is a **dry run first**: parse, diff against the current glossary, show
`23 new · 4 updated · 2 conflicts · 1 unparseable (line 17)` with an expandable table and only
then an Apply button. A glossary import that silently overwrites 200 curated rows is not
recoverable through the UI.

Export streams from `GET /api/glossaries/[id]/export` using the same RFC 5987 header as the
transcript export (see §3).

#### The job-page picker

shadcn `Command` in a `Popover`, multi-select, persisted to `jobs.glossary_ids` so a re-run
reuses the same set. Default selection: every non-archived instance-scope glossary, plus the
project's, plus the job's own.

The footer does budget arithmetic, which is the honest part:

```
340 terms selected across 3 glossaries.
· Post-transcription entity pass: all 340 applied.
· Whisper prompt: the first 112 fit in the 224-token budget; the rest are
  still applied after transcription.
· Google phrase set: unavailable on chirp_2 (see Settings → Providers).
```

Ordering into the truncated Whisper prompt is by `boost` then by term length descending —
longer strings are the ones the model is least likely to get right unaided.

#### "Add to glossary" from the editor — the feature worth building

**Why.** Glossaries are only maintained while someone is correcting a transcript. Every product
that puts term management behind a separate nav item ends up with a glossary populated during
onboarding and untouched afterwards; it rots, and then the entity pass starts *introducing*
errors, which is worse than not having one. The moment a journalist sees a mangled name is the
only moment they have both the motivation and the correct spelling in front of them. If capture
costs more than about three seconds it does not happen.

**Mechanics.**

```ts
// apps/web/components/editor/use-text-selection.ts
// Two selection sources, one shape.
//   focused row  → textarea.selectionStart/selectionEnd
//   unfocused    → window.getSelection() range intersected with the row's read-only span
// Emits { segmentId, text, rowEl } — never a live Range object.
```

The emitted value holds a **copy** of the text and the segment id, never a `Range` or a node
reference. Rows unmount constantly inside `@tanstack/react-virtual`; a popover holding a live
Range is a crash waiting for a scroll.

The floating button is **anchored to the segment row, not to the selection rectangle** — top
right of the row, `Popover` anchored to the row element. Measuring caret coordinates inside a
textarea requires a mirrored div with copied computed styles, which then has to be re-measured
on every `measureElement` pass of the virtualizer. Anchoring to the row is one line, cannot
drift, and the reader's eye is already on that row. This is a deliberate simplification, not an
oversight.

Dialog, prefilled:

| Field | Prefill |
|---|---|
| Source term | the selection, trimmed of surrounding punctuation and zero-width characters |
| Type | `acronym` if `/^[A-Z0-9]{2,6}$/`; otherwise blank |
| Glossary | the job's writable glossary (created lazily), with a picker to promote to project or instance scope |
| Also written as | empty, plus a hint: **"3 other spellings of this appear in this run"** listing near-matches found by normalized-edit-distance ≤ 2 over the run's segment texts, each with a checkbox |

The near-match list is the part that makes this worth more than a text box: the journalist is
looking at one instance of the error, and the tool already knows about the other three.

**Then the step that pays for it.** After save:

> Added. **Fix the 7 other segments where this appears?** [Fix them] [Not now]

"Fix them" starts an `editorial_passes` row with `kind = 'entities'` scoped to those segment
ids — constrained substitution against the glossary only, never freeform, exactly as Phase 6
defined it. Results land as `segment_texts (layer = 'entity_corrected', origin = 'rule')`, so
they are supersedable and provenanced like anything else. Human-edited segments are skipped and
counted in `segments_skipped_human`.

Keyboard: `Ctrl+G` with a non-empty selection opens the dialog directly.

**Cut:** pronunciation audio, term versioning/history, automatic term extraction. Automatic
extraction in particular is tempting and wrong at this stage — it produces a hundred
low-precision candidates that nobody triages, and the triage queue rots the same way the
glossary would have.

---

### 3. Export dialog

#### Route shape

```
apps/web/app/(app)/jobs/[id]/
  layout.tsx                    export default ({children, modal}) => <>{children}{modal}</>
  page.tsx                      the editor
  export/page.tsx               full-page fallback
  @modal/
    default.tsx                 export default () => null      ← required
    (.)export/page.tsx          intercepted: renders <Dialog><ExportForm/></Dialog>
```

`@modal/default.tsx` returning `null` is not optional. Without it, any navigation that is not a
client-side soft push into `/jobs/[id]/export` leaves the slot unmatched and Next renders a 404
for the whole route. This costs an afternoon to diagnose the first time.

Why an intercepting route rather than `useState`:

- The configuration is a **URL**. "Export it with these settings" is a link a producer sends an
  editor.
- Reload keeps the dialog open with the same options.
- Browser Back closes it, which is what everyone tries first.
- `Cmd+click` on "Export…" gives the standalone page, which is also what a screen reader user
  gets if the dialog misbehaves.

Both routes render the same `<ExportForm runId layer defaults />`; the dialog is a wrapper.
State lives in `searchParams` via `useRouter().replace(..., { scroll: false })`, debounced.

#### Controls

| Control | Values | Default | Notes |
|---|---|---|---|
| Format | srt · vtt · txt · json · docx · md | srt | from the `packages/core` writer registry, so adding a writer adds an option |
| Layer | verbatim · cleaned · translated | verbatim | a layer with no `segment_texts` rows is disabled **with the reason** ("no cleanup pass has run on this run") and a link that starts it |
| Target language | select | — | translated only; options are the `target_lang` values that actually have rows |
| Bilingual | off · source above · source below | off | subtitle formats only; disabled with a tooltip elsewhere |
| Speaker labels | off · `NAME: ` prefix · VTT `<v Name>` | prefix when the run has speakers | `<v>` only offered for vtt |
| CPS limit | number | `languages[out].subtitle.cpsMax` | |
| Chars per line | number | `subtitle.charsPerLineMax` | |
| Max lines | 1–3 | `subtitle.maxLines` | |
| RTL handling | isolate marks · RLM prefix · none | isolate | **only rendered when the output script is RTL** |
| Timecode offset | ms | 0 | for a clip cut from a longer recording |

**Defaults come from the *output* language, not the job language.** A Burmese job exported as an
English translation must use Latin CPS and line lengths; using `my`'s values produces cues that
are correct for Myanmar script and unreadably long in English. `resolveLanguage(outLang)` where
`outLang = layer === 'translated' ? targetLang : job.languageCode`. This is a one-line bug that
is invisible in testing if you only ever export the source language.

#### Live preview

```tsx
// apps/web/components/export/subtitle-preview.tsx
'use client';
import { reflow, applyBidi, renderCues } from '@thibi/core/export';   // zero deps, browser-safe

const cues = useMemo(
  () => reflow(segments.slice(0, 40), opts).slice(0, 6),
  [segments, opts]
);
```

This is the payoff for the overview's rule that `packages/core` is importable from client
components. The preview is not an approximation of what the exporter does — it *is* the
exporter, running on the same inputs. Each cue shows its index, timecode, wrapped lines, and a
CPS badge that turns amber above the limit. Below the preview:

> **14 of 812 cues exceed 17 CPS.** Raising chars-per-line to 42 clears 11 of them.

computed over the whole run client-side (pure function, already-loaded text, microseconds), in
a `useDeferredValue` so typing in the CPS box stays responsive.

For RTL output the preview renders the actual isolate characters with a toggle to reveal them
as `⁧`/`⁩` glyph pills, because "does this cue start with U+2067" is not answerable by looking
at rendered text.

#### The download route

Ported from `app/api/runs/[id]/export/route.ts`, with the header improved:

```ts
const base = job.filename.replace(/\.[^.]+$/, '') || 'transcript';   // ported verbatim
const parts = [base, layer, layer === 'translated' ? targetLang : null, run.providerId];
const filename = `${parts.filter(Boolean).join('.')}.${writer.extension}`;

headers.set('Content-Type', writer.mime);
headers.set(
  'Content-Disposition',
  `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
);
```

Two notes:

- The `filename*=UTF-8''` form is ported **verbatim in intent** from `route.ts:33`. It matters
  more here than it did there: filenames are Burmese, Amharic, Khmer and Pashto. Plain
  `filename="…"` is latin-1 only and produces mojibake or a truncated name.
- The **ASCII fallback is new**. Some download managers and older Safari builds ignore the
  starred parameter entirely; with only the starred form they invent a name from the URL path,
  which here is `export`. Emitting both is strictly better and costs one helper.

The route writes an `audit_log` row (`kind = 'export'`, `data = { format, layer, targetLang,
bytes }`) — this is the source for Phase 14's "who exported what".

Submission is a plain `<form method="get" action="/api/runs/[id]/export" target="_blank">`. Not
`fetch` + blob: a 3-hour translated DOCX should stream from the server to disk without being
materialised in the tab's memory.

#### What replaces the old export row

`job-detail.tsx:436-467` renders four bare format links. Those go. In their place: one
**Export…** button, plus a dropdown of the last three configurations used on this job (stored
in `localStorage`, keyed by job id) rendered as "SRT · translated · en" one-click repeats. The
four links were fine when there was one layer; the layer picker is now the actual question and
a link cannot ask it.

---

### 4. Document-pass panel

Read-only. A `Documents` tab in the run toolbar, badge showing which of the three exist.

| Tab | Source | Rendering |
|---|---|---|
| Summary | `documents` where `kind='summary'` | `content_md` through the markdown renderer; one Copy button |
| Chapters | `kind='chapters'` | list of `timecodeMs · title`; the timecode is a ▶ that seeks; Copy copies the whole list as markdown |
| Quotes | `kind='quotes'` | blockquote + speaker name + timecode; clicking scrolls the virtualized list to `segmentIds[0]` and seeks audio to its start |

The quote → audio jump is the one interaction that has to be right. A newsroom checks every
quote against the recording before it runs; `content.segmentIds` exists in the schema for
exactly this, and the panel is the only thing that makes it usable. Reuse Phase 12's
`scrollToSegment(id)` from the virtualizer, then `seek(startMs)`.

Footer on every tab, from the `editorial_passes` row:

> Generated by `<provider>/<model>`, prompt `document@v2`, 2026-08-09 14:22 · **Regenerate**

Regenerating supersedes (`documents.superseded_at`) rather than overwriting, matching the
provenance rule everywhere else. Empty state is a single "Run document pass" button opening
`ConfirmRunDialog` with the LLM token estimate.

**Cut in v1, explicitly:** editing chapter titles, reordering chapters, pinning or starring
quotes, exporting a quote as an audio clip, regenerating one section only.

---

## Porting notes

| From (old repo) | To | Verbatim? | Notes |
|---|---|---|---|
| `app/api/runs/[id]/export/route.ts:33` | `app/api/runs/[id]/export/route.ts` | **changed** | keep `filename*=UTF-8''${encodeURIComponent(…)}`; add the ASCII `filename=` fallback |
| `app/api/runs/[id]/export/route.ts:30-31` | same | **verbatim** | `job.filename.replace(/\.[^.]+$/, "") \|\| "transcript"` — handles extensionless and empty names |
| `app/api/runs/[id]/export/route.ts:17-21` | same | changed | the "format must be one of" 400 is good; extend it to reject an unknown `layer` and an unavailable `targetLang` the same way, with the same message shape |
| `job-detail.tsx:436-447` export row | `run-toolbar.tsx` | **deleted** | replaced by one Export… button + recents; four format links cannot express a layer |
| `job-detail.tsx:449-465` post-process buttons | `run-toolbar.tsx` | changed | become a pass menu covering four passes with per-pass state, not two hardcoded buttons and one `postBusy` string |
| `job-detail.tsx:112-212` `ConfirmRunDialog` | `components/confirm-run-dialog.tsx` | **verbatim** | already ported in Phase 11; reused here for the document pass. The Escape handler, focused Confirm button and "this file already has N runs" warning all carry over |
| `job-detail.tsx:506-523` inline cleaned/translation paragraphs | — | **must not survive** | stacking every layer under every segment is unreadable past a few hundred rows; Phase 12's segmented control replaced it |
| `job-detail.tsx:501` `key={`${segment.id}-${…}`}` remount | — | **must not survive** | already removed in Phase 12; re-check that no new component reintroduces it |
| `job-detail.tsx:525-540` Z→U / U→Z per-segment buttons | — | **must not survive as UI** | Zawgyi conversion is a per-word normalizer in the pipeline (overview: applied per word, segment text re-derived). A per-segment button desynchronises word alignment. If a manual escape hatch is wanted it belongs in the run toolbar as a whole-run operation |

Nothing in `lib/pricing/*` is touched by this phase; it is dropped in Phase 14.

---

## Tests

### `packages/engine/src/speakers/__tests__/assign.test.ts`

| Fixture | Case | Assertion |
|---|---|---|
| `run-flicker.json` (A A B A A A) | click the single B, "this and following" | exactly 1 segment updated |
| `run-block.json` (A×3 B×7 A×2) | click B[0] | exactly 7 updated, the trailing A block untouched |
| `run-tail.json` | click the last segment | extent = 1, no off-by-one past the array |
| `run-null-speaker.json` | click a `speaker_id = null` segment | extent covers the contiguous null block only |
| `run-with-split.json` | a superseded segment sits mid-block | extent is 9, not 4 — the superseded row is excluded by the query, not by a break |
| any | undo | prior `(segment, speaker, source)` triples restored exactly, including `null` |

### `packages/engine/src/speakers/__tests__/merge.test.ts`

- `mergeSpeakers(A → B)` repoints `segments` **and** `words`, sets `A.is_merged_into = B`, keeps
  row A.
- A subsequent `reconcile` whose Hungarian assignment maps a new pyannote cluster to A writes to
  B. Fixture `rediarize-onto-merged.json`.
- `mergeSpeakers(B → A)` after the above is rejected (cycle).
- `deleteSpeaker` with segments still attached throws `SPEAKER_IN_USE` with the count.

### `packages/engine/src/diarize/__tests__/reconcile-human.test.ts`

- Fixture `human-assigned.sql`: 3 of 20 segments have `speaker_source = 'human'`. A full
  re-diarization changes 17 and leaves those 3 byte-identical, including `speaker_purity IS NULL`.

### `packages/engine/src/glossary/__tests__/csv.test.ts`

| Fixture | Tests |
|---|---|
| `terms-basic.csv` | round-trip: parse → serialise → parse is idempotent |
| `terms-bom.csv` | leading U+FEFF stripped; first column is `term`, not `﻿term` |
| `terms-crlf.csv` | CRLF and a final line without a newline |
| `terms-commas.csv` | a term containing a comma inside quotes; variants pipe-separated |
| `terms-duplicate.csv` | two rows with the same `term` → one conflict entry, no write |
| `terms-bad-lang.csv` | `translations=xx=foo` where `xx` is not in the registry → line-level error, other rows still importable |
| `terms-myanmar.csv` | Myanmar text survives NFC normalization unchanged; zero-width characters in `term` are stripped, in `notes` are not |

### `apps/web/components/export/__tests__/preview-parity.test.ts`

The load-bearing test of the phase. For each of `[srt, vtt]` × `[my, ps, ha]` × two option sets:

1. `thibi export <run> --format … --layer … > __fixtures__/expected/<name>.srt` (checked in,
   regenerated by a script, not by hand).
2. The preview component's `reflow(...).slice(0, 6)` rendered through the same writer.
3. Assert **byte equality** of the first six cues.

If these ever diverge, the preview is lying, and a lying preview is worse than no preview.

### `apps/web/app/api/runs/[id]/export/__tests__/filename.test.ts`

- Job `စမ်းသပ်.mp3`, layer `verbatim`, provider `google` → header parses under RFC 5987 and
  `decodeURIComponent` returns `စမ်းသပ်.verbatim.google.srt`.
- The ASCII fallback contains no byte > 0x7E and is non-empty.
- Job filename `.mp3` (no stem) → `transcript.verbatim.google.srt`.

### Component tests

- `speaker-popover.test.tsx` — Escape closes and returns focus to the chip; Tab cycles inside;
  the run button's label matches the extent the server computed.
- `term-table.test.tsx` — typing in the blank row and pressing Tab commits and creates a new
  blank row with focus in cell 1; a 409 turns the row amber and does not clear the input.
- `add-to-glossary.test.tsx` — with the popover open, scroll the virtualizer until the source
  row unmounts; the dialog still opens with the correct text (guards the "never hold a live
  Range" rule).

---

## Verification

Run against a real 2-hour multi-speaker interview with diarization complete.

**Speakers**

1. Open `/jobs/<id>`. Every segment shows a chip; colours cycle through 8 and repeat.
2. Click a chip → popover → type a name → Enter. **Every** segment for that speaker updates in
   one render, and one row changed in `speakers` (`SELECT count(*) FROM segment_revisions`
   should be unchanged — a rename is not a segment edit).
3. Find a run of mis-attributed segments. Click the first, choose the correct speaker, click
   "Apply to this and N following". The button's N matches what actually changes. Undo restores
   all of them.
4. `SELECT speaker_source, count(*) FROM segments WHERE run_id = … GROUP BY 1` → the human ones
   are counted.
5. Re-run diarization (`thibi diarize <run> --force`). The renamed speaker keeps its name; the
   manually reassigned segments are unchanged; everything else may move.
6. Toolbar shows "N to check"; `Alt+S` walks them in document order and wraps with a toast.
7. Merge two speakers in the dialog. Segments and words both repoint. Re-run diarization: no
   third speaker appears where the merged one was.

**Glossary**

8. `/glossaries` → New → job scope. Add three terms by typing and tabbing, no modal opens.
9. Export CSV, open in Excel, add a row, save as CSV (Excel writes a BOM), re-import. Preview
   says `1 new · 3 updated · 0 conflicts`. Apply. No duplicates, no `﻿`.
10. In the editor, select a mangled name in an unfocused segment → floating button appears at
    the row's top-right → dialog is prefilled → the near-matches list offers the other
    spellings. Save, then "Fix them". The other segments update as
    `layer = 'entity_corrected'`, and a segment you had hand-edited is skipped.
11. Scroll 500 rows away with the dialog open. No crash, no wrong text.
12. The job-page picker shows the token-budget footer with real numbers.

**Export**

13. Click Export… — the URL becomes `/jobs/<id>/export?format=srt&layer=verbatim`. Reload: the
    dialog is still open with those options. Back: it closes. `Cmd+click` gives the full page.
14. Switch to `translated / en`. CPS defaults change from the Myanmar values to the Latin ones.
15. Set chars-per-line to 20 — the preview re-wraps live and the over-CPS count rises.
16. Download SRT. `diff` it against `thibi export <run> --format srt --layer translated --lang en`.
    **Identical.**
17. Export a Pashto run. `xxd` the file: RTL cues are wrapped in `e2 81 a7 … e2 81 a9`. Open in
    VLC and in a browser; the Latin acronym at the start of a cue reads left to right.
18. Export with a Burmese filename. Chrome, Safari and `curl -OJ` all produce a correctly named
    file.
19. `SELECT * FROM audit_log WHERE kind='export' ORDER BY created_at DESC LIMIT 1` has the
    layer, format and language.

**Documents**

20. Documents tab → Quotes → click a quote. The list scrolls to the right segment and the audio
    seeks to it. Copy produces markdown that pastes cleanly into a CMS.

---

## Risks and open questions

1. **Selection inside a virtualized list.** The mitigation (copy the text, anchor to the row,
   never hold a Range) is specified above and has a test, but this is the interaction most
   likely to produce a "sometimes it opens with the wrong text" bug report. If it proves flaky,
   the fallback is to require the row to be focused (textarea selection only), which is
   deterministic and loses only the ability to capture from a read-only row.
2. **Textarea selection and `measureElement`.** Opening a popover can change the row's height
   if it pushes content; anchor the popover with `Portal` so it never participates in row
   layout.
3. **The `@modal` slot.** `default.tsx` handles the hard-navigation case, but parallel routes
   plus `searchParams`-driven state re-render more than expected. If the preview stutters while
   typing in the CPS box, move the option state to `useState` and sync to the URL on a 400 ms
   debounce rather than driving from `searchParams`.
4. **CSV dialect divergence.** Newsrooms will paste from Google Sheets, Excel and LibreOffice.
   The pipe-separated choice is deliberate but unusual; the import preview is the safety net. If
   users keep getting it wrong, add a "paste a column" mode rather than trying to sniff dialects.
5. **Extent semantics with no diarization.** When `speaker_id` is null everywhere, "this and
   following" selects the whole run, which is almost certainly what someone wants after
   listening to a two-person interview that was never diarized — but it should be labelled
   loudly ("Apply to this and 812 following").
6. **Open question — should a merge be undoable?** Currently no; it is a `Dialog` with a
   confirmation naming both speakers. `is_merged_into` makes it technically reversible
   (repoint segments back by `speaker_turns` overlap), but the segments that were *manually*
   assigned to the loser before the merge cannot be distinguished afterwards. Decide before
   shipping: either record the pre-merge mapping in `audit_log.data` (cheap, ~1,400 uuid pairs)
   or state in the dialog that merge is permanent. Prefer the former.
7. **Open question — glossary term limit.** No cap today. A 5,000-term instance glossary would
   make the entity pass expensive and the phrase set impossible. Add a soft warning at 500 and
   revisit after the first real newsroom glossary exists.

---

## Definition of done

- [ ] Renaming a speaker from the chip popover updates one `speakers` row and every displayed
      segment, and survives `thibi diarize --force`.
- [ ] "Apply to this and N following" stops at the next speaker change, the label's N matches
      what changes, and Undo restores the exact prior state including nulls.
- [ ] `segments.speaker_source = 'human'` is never overwritten by `reconcile`, with a test.
- [ ] Merging two speakers repoints segments and words, keeps the loser row, and redirects a
      later re-diarization.
- [ ] `needs_speaker_review` segments are visually distinct and `Alt+S` walks them.
- [ ] Speaker colour appears only on the chip and a 2 px left border — no row background.
- [ ] `/glossaries/[id]` adds a term with keyboard only, no modal, and reports duplicates as a
      mergeable conflict.
- [ ] CSV import round-trips an Excel-saved file with a BOM; import always shows a dry-run
      first.
- [ ] "Add to glossary" works from a selection in an unfocused row, survives the row unmounting,
      pre-fills type and near-matches, and offers the scoped entity fix.
- [ ] The job glossary picker persists to `jobs.glossary_ids` and states the Whisper prompt
      budget honestly.
- [ ] `/jobs/[id]/export` works as an intercepted modal, as a full page, on reload and on Back.
- [ ] Export defaults derive from the **output** language.
- [ ] The preview's first six cues are byte-identical to `thibi export`, asserted in CI.
- [ ] Non-Latin filenames download correctly in Chrome, Safari and `curl -OJ`.
- [ ] Every export writes an `audit_log` row.
- [ ] The document panel's quote click seeks the audio and scrolls the list.
- [ ] The four bare export links, the stacked layer paragraphs, and the per-segment Zawgyi
      buttons from `job-detail.tsx` do not exist anywhere in `apps/web`.

