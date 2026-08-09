# Phase 12 — UI segment editor

## Goal

At the end of this phase a journalist can open a 90-minute, 1,500-segment transcript and correct
it against the audio without lag: virtualized rows, word-level playback highlighting driven by
`requestAnimationFrame`, layer switching between verbatim / cleaned / translated, low-confidence
marks that scale with confidence, optimistic saves with real conflict detection, and a keyboard
map that makes the mouse optional. It is the largest single UI piece in v1 and the one where the
product is judged. It sits after Phase 11 because it consumes the shell, the `data-script`
rendering system, `use-run-stream`, `ConfirmRunDialog` and the presigned media URL; it sits
before Phase 13 because speakers, glossary-from-selection and the export dialog all hang off the
row, the toolbar and the selection model this phase establishes.

The build order **inside** this phase is deliberate and non-negotiable: the `has_words = false`
path first, then words, then confidence. Overview risk #2 says the first Oromo file breaks four
features at once; building the degraded path last guarantees exactly that.

## Prerequisites

| Phase | What this phase consumes |
|---|---|
| 11 | `AppShell`, `ScriptedText` / `scriptAttrs`, generated `scripts.css`, `use-run-stream`, `ConfirmRunDialog`, `RunStatusPill`, presigned media URL route |
| 1 | `segments` (idx, start_ms, end_ms, text, confidence, has_words), `words` (idx, start_ms, end_ms, text, confidence, is_estimated) |
| 3 | `speakers`, `segments.speaker_id`, `speaker_purity`, `needs_speaker_review` (chips render here; the editing UI is Phase 13) |
| 6 | `segment_texts` (layer, target_lang, origin, author_id), `editorial_passes`, `resolveLayer()` in `packages/core/src/layers/resolve.ts` |
| 7 | `packages/core` timecode + bidi, for the export preview |
| 9 | `run_events` SSE with named event kinds |
| 10 | `requireUser()`, `action()`, `users.display_name` for conflict attribution |

Open dependency: spike **S2** determines whether Google returns usable `wordConfidence`. It
gates whether §8's marks are visible for the primary provider, not whether they are built.

## Deliverables

| Path | Purpose |
|---|---|
| `apps/web/app/(app)/jobs/[id]/page.tsx` | Server: `requireUser`, load job/runs/language/rate, mint the media URL, render `<EditorShell>` |
| `apps/web/components/editor/editor-shell.tsx` | Client root. Owns run selection, layer state, capability flags, the playback store and the mutation queue |
| `apps/web/components/editor/audio-dock.tsx` | Sticky `<audio>`, playback rate, loop toggle, URL re-minting |
| `apps/web/components/editor/run-tabs.tsx` | Run strip with provider, model, status pill, cost, primary star |
| `apps/web/components/editor/run-toolbar.tsx` | Layer control, reference-line select, uncertain count, speakers button, export, overflow |
| `apps/web/components/editor/segment-list.tsx` | Virtualizer owner, keyboard map, find, auto-scroll |
| `apps/web/components/editor/segment-row.tsx` | One row: gutter, chip, text, save state, overflow menu |
| `apps/web/components/editor/segment-text.tsx` | The textarea ⇄ read-only span swap |
| `apps/web/components/editor/word-spans.tsx` | Read-only word rendering with confidence marks and active-word highlight |
| `apps/web/components/editor/speaker-chip.tsx` | Colour chip + 2 px left border (popover is Phase 13) |
| `apps/web/components/editor/row-menu.tsx` | Overflow: Zawgyi convert, split, revert to ASR, copy with timecode |
| `apps/web/components/editor/conflict-bar.tsx` | 409 resolution UI |
| `apps/web/components/editor/shortcut-sheet.tsx` | `?` dialog |
| `apps/web/components/editor/no-words-note.tsx` | The `has_words = false` explanation |
| `apps/web/hooks/use-playback.ts` | `createPlaybackStore`, `usePlaybackDriver`, `useActiveSegment`, `useActiveWord` |
| `apps/web/hooks/use-segment-mutations.ts` | Optimistic queue, precondition, conflict state, `sessionStorage` mirror |
| `apps/web/hooks/use-time-index.ts` | `Float64Array` binary-search index over segments and words |
| `apps/web/hooks/use-row-heights.ts` | Measured-height cache + data-driven `estimateSize` |
| `apps/web/lib/caret.ts` | `caretPositionFromPoint` / `caretRangeFromPoint` feature detection |
| `apps/web/app/api/segments/[id]/text/route.ts` | `PATCH` with precondition → 200 / 409 |
| `apps/web/app/api/runs/[id]/segments/route.ts` | Ranged segment fetch (`?from=&count=`) |
| `apps/web/app/api/runs/[id]/lock/route.ts` | Advisory `locked_by` acquire/heartbeat/release |
| `packages/core/src/timecode.ts` | `formatClock` ported verbatim + an hours branch |
| `packages/engine/src/segments/write-text.ts` | The supersede-with-precondition write |
| `apps/web/__fixtures__/*` | Six transcript fixtures (see Tests) |

## Design

### 1. Decomposition

`job-detail.tsx` is 572 lines and does everything: data fetching, SSE, run selection, provider
buttons, the confirm dialog, post-processing, Zawgyi conversion, playback state, and the segment
list. Words, speakers and layers would triple it. The tree:

```
app/(app)/jobs/[id]/page.tsx                       server component
└─ <EditorShell job runs language caps mediaUrl rate user>            'use client'
   ├─ <AudioDock src duration onEl />                                 sticky, top
   ├─ <RunTabs runs activeRunId onSelect />
   ├─ <RunToolbar run layer onLayer reference onReference caps uncertain />
   ├─ <NoWordsNote provider />                       only when !caps.words
   ├─ <SegmentList runId layer reference caps />     owns the virtualizer + key map
   │   └─ <SegmentRow segment layer reference caps />          React.memo
   │      ├─ <TimecodeButton startMs onSeek />
   │      ├─ <SpeakerChip speakerId needsReview />
   │      ├─ <SegmentText segment layer value onCommit caps />
   │      │   └─ <WordSpans words threshold activeWordIdx />  unfocused only
   │      ├─ <ConflictBar conflict onKeepMine onUseTheirs />   only on 409
   │      └─ <RowMenu segment caps />
   ├─ <ConfirmRunDialog />                            from phase 11
   └─ <ShortcutSheet open />
```

| Component | Owns | Never receives |
|---|---|---|
| `EditorShell` | active run id, layer + reference layer, `caps`, the playback store instance, the mutation queue, the run lock | — |
| `AudioDock` | the `HTMLAudioElement`, playback rate, loop, URL refresh | current time as a prop |
| `RunTabs` | nothing; pure | segments |
| `RunToolbar` | threshold popover state, find state | current time, active segment |
| `SegmentList` | the virtualizer, scroll element, keyboard handler, focused index, find matches | current time |
| `SegmentRow` | focus state for its own row | `currentTime`, `activeSegmentId` (it *subscribes*) |
| `SegmentText` | the uncontrolled textarea, caret, the focused/unfocused swap | — |
| `WordSpans` | nothing; pure given `activeWordIdx` | the audio element |

**The rule that makes the tree work: state that changes at animation frequency never crosses a
component boundary as a prop.** `activeSegmentId` and `activeWordIdx` are *subscribed to* inside
the leaf that needs them, never passed down from `SegmentList`. Everything else follows from
that — it is why the store exists, why the rows are `memo`, and why 1,500 rows cost nothing
during playback.

Line budget: no file above ~200 lines. If `segment-row.tsx` grows past it in Phase 13, the
speaker popover moves out, not the row.

### 2. Port verbatim, and why each is worth keeping

**`AutoGrowTextarea`** (`job-detail.tsx:62-102`). The three-legged resize is a documented bug fix
and each leg fixes a distinct real failure. Keep all three, keep the comments (`:54-61`, `:76`,
`:81-82`) — they are the record of why:

| Leg | Failure it fixes |
|---|---|
| `useLayoutEffect(resize, [defaultValue])` on mount | Segments arrive **already populated**. A resize-on-type-only handler leaves every row one line tall with the rest clipped — the comment at `:56-58` says exactly this |
| `useLayoutEffect`, not `useEffect` | Sizes before paint. Otherwise every row visibly flashes at one line on load, and with 1,500 rows that is a full-page flicker |
| `el.style.height = 'auto'` before reading `scrollHeight` (`:76-78`) | `scrollHeight` never reports less than the current box height. Without the collapse, a row that loses text stays tall forever |
| `window.resize` listener (`:85-88`) | Width changes rewrap the text and change the required height |

Phase 12 adds a **fourth** leg: a `ResizeObserver` on the row's container, because the
virtualizer, the reference line and the "show original alongside" toggle all change the column
width without a window resize. It observes `contentBoxSize.inlineSize` **only** and early-returns
when the width is unchanged — see §4, measurement thrash.

**The SSE effect** (`:256-281`) — already extracted in Phase 11 as `use-run-stream`. Here it is
consumed through context by four components instead of one.

**`formatClock`** (`:214-218`) → `packages/core/src/timecode.ts`, verbatim, plus an `h:mm:ss.s`
branch past 3600 s. `m:ss.s` with `padStart(4, '0')` is the right default for an editor:
deciseconds are visible (you need them to judge a boundary) and hours are not (most files are
under one). It belongs in `core` because the gutter, the shortcut sheet, the quote panel and the
exporters all render timecodes and must agree.

**`STATUS_STYLES`** (`:46-52`) → `run-status-pill.tsx` from Phase 11. The light/dark colour pairs
are tuned; port them exactly.

**The run-tab strip** (`:396-415`). Structure verbatim. It is the thing that makes "compare Google
against faster-whisper on this file" a one-click operation, which is a genuine newsroom workflow
and the entire reason multi-provider support exists. Additions: model and language beside the
provider, recorded cost, a star on `jobs.primary_run_id`, and `is_probe` runs rendered
secondary and labelled "2-min probe".

**The sticky `<audio>` dock** (`:371-380`). `-mx-6 px-6`, `backdrop-blur`, `sticky top-0 z-10`
port as-is. **`preload="metadata"` must not be changed to `auto`** — a 90-minute file behind a
presigned URL would be fully buffered on page load, which is both slow and expensive.

One change, and it is a bug waiting to happen otherwise: the `src` is now a presigned MinIO URL
with a **15-minute TTL**. An editor working for twenty minutes gets a dead player and a seek that
silently fails. So the dock re-mints:

```tsx
const refresh = useCallback(async () => {
  const el = audioRef.current; if (!el) return;
  const { currentTime, paused } = el;
  const { url } = await fetch(`/api/media/${assetId}/url`).then(r => r.json());
  el.src = url;
  el.addEventListener('loadedmetadata', () => {
    el.currentTime = currentTime;          // restore position across the swap
    if (!paused) void el.play();
  }, { once: true });
}, [assetId]);

useEffect(() => {
  const id = setInterval(refresh, 12 * 60 * 1000);          // ahead of the 15-min TTL
  const onErr = () => { if (audioRef.current?.error?.code === MediaError.MEDIA_ERR_NETWORK) refresh(); };
  audioRef.current?.addEventListener('error', onErr);
  return () => { clearInterval(id); audioRef.current?.removeEventListener('error', onErr); };
}, [refresh]);
```

Also added to the dock, because they are the two most-used controls in every transcription tool
and cost almost nothing: **playback rate** (0.5×–2×, a `Select`) and **loop current segment**.

### 3. Playback sync, rebuilt

This is the single most important performance decision in the UI.

**What is wrong today.** `onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}`
(`:378`) puts a value that changes ~4 times per second into the root component's state. Every
change re-renders `JobDetail`, which re-renders the `<ul>` and every `<li>` (`:476-543`), each of
which recomputes `isActive` (`:477-478`) and re-renders an `AutoGrowTextarea`. At 1,500 segments
that is ~6,000 component renders per second of playback, and the list becomes unusable long
before 1,500 — well under 300. Word-level highlighting would multiply it by the word count.

**The design.**

1. `currentTime` lives in a **ref**. It is never React state, at any level.
2. One `requestAnimationFrame` loop while playing, sampling `audio.currentTime` directly.
3. The loop publishes only two scalars — `activeSegmentId` and `activeWordIdx` — through a tiny
   external store. Components subscribe with `useSyncExternalStore` and derive booleans.
4. Lookup is O(log n) against prebuilt `Float64Array`s.

**Why `requestAnimationFrame` and not `timeupdate`.** The HTML spec permits a user agent to fire
`timeupdate` as rarely as every 250 ms, and Chrome and Firefox do roughly that. A typical spoken
word is 200–400 ms, so at `timeupdate` granularity the highlighted word is wrong roughly half the
time and always trails the audio. rAF samples at display rate — the *loop* runs at 60 Hz, but it
publishes only when a value actually changes, so the cost of the extra sampling is a few
comparisons per frame.

```ts
// apps/web/hooks/use-playback.ts
export interface PlaybackSnapshot { segId: string | null; wordIdx: number; playing: boolean }

export function createPlaybackStore() {
  let snap: PlaybackSnapshot = { segId: null, wordIdx: -1, playing: false };
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snap,
    getServerSnapshot: () => snap,
    set(next: PlaybackSnapshot) {
      // Early return BEFORE notifying. At 60 Hz with 1,500 subscribers this line is
      // the difference between 0 and 90,000 closure calls per second.
      if (next.segId === snap.segId && next.wordIdx === snap.wordIdx && next.playing === snap.playing) return;
      snap = next;
      for (const l of listeners) l();
    },
  };
}
export type PlaybackStore = ReturnType<typeof createPlaybackStore>;
```

```ts
// apps/web/hooks/use-time-index.ts
export interface TimeIndex {
  segIds: string[];
  segStart: Float64Array;      // ms, ascending
  segEnd: Float64Array;
  wordStart: (Float64Array | null)[];   // null when has_words = false
}

/** Last segment whose start <= t, or -1 if t falls in a gap or before the first. */
export function findSegment(ix: TimeIndex, t: number): number {
  let lo = 0, hi = ix.segStart.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ix.segStart[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 && t < ix.segEnd[ans] ? ans : -1;
}

export function findWord(starts: Float64Array | null, t: number): number {
  if (!starts) return -1;
  let lo = 0, hi = starts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
```

```ts
export function usePlaybackDriver(
  audio: HTMLAudioElement | null, ix: TimeIndex, store: PlaybackStore, timeRef: MutableRefObject<number>,
) {
  const raf = useRef(0);
  useEffect(() => {
    if (!audio) return;
    const tick = () => {
      const t = audio.currentTime * 1000;
      timeRef.current = t;                                  // ref, never state
      const s = findSegment(ix, t);
      store.set({
        segId: s === -1 ? null : ix.segIds[s],
        wordIdx: s === -1 ? -1 : findWord(ix.wordStart[s], t),
        playing: !audio.paused,
      });
      raf.current = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(tick); };
    const stop  = () => { cancelAnimationFrame(raf.current); tick(); };   // settle the final position
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('seeked', stop);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(raf.current);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('seeked', stop);
    };
  }, [audio, ix, store, timeRef]);
}
```

Consumption — note that both selectors return **primitives**:

```tsx
export function useIsActiveSegment(store: PlaybackStore, id: string) {
  return useSyncExternalStore(store.subscribe,
    () => store.getSnapshot().segId === id, () => false);
}

export function useActiveWordIdx(store: PlaybackStore, id: string) {
  return useSyncExternalStore(store.subscribe,
    () => { const s = store.getSnapshot(); return s.segId === id ? s.wordIdx : -1; }, () => -1);
}
```

Returning a boolean or a number is not a style choice. `useSyncExternalStore` compares snapshots
with `Object.is`, so a `getSnapshot` that builds an object on every call triggers React's *"The
result of getSnapshot should be cached to avoid an infinite loop"* and re-renders forever.
Primitives make that impossible by construction.

The payoff: on a segment transition, exactly **two** rows re-render — the one losing the
highlight and the one gaining it. Every other row's selector returns the same `false` and React
bails out. During word highlighting only the active row's selector returns a changing number.
1,500 rows × 4 transitions per second becomes 8 row renders per second instead of 6,000.

**Auto-scroll (follow playback).** A toggle in the dock, default on. The driver calls
`virtualizer.scrollToIndex(i, { align: 'center' })` when the active index changes — but it is
**suppressed for 4 seconds after any user interaction with the list**: `wheel`, `touchmove`,
`keydown`, or `focusin`. Without the suppression, the page yanks the viewport away from someone
who is typing, which is the fastest way to make an editor unusable. A `lastInteraction` ref set
by those four listeners is the whole implementation.

### 4. Virtualization

`@tanstack/react-virtual`:

```tsx
const virtualizer = useVirtualizer({
  count: segments.length,
  getScrollElement: () => listRef.current,
  estimateSize: (i) => rowHeightHint(segments[i], layer, script, columnWidth),
  getItemKey: (i) => segments[i].id,
  measureElement: (el) => el.getBoundingClientRect().height,
  overscan: 8,
});
```

The scroll container is a dedicated element (`height: calc(100dvh - var(--dock-h)); overflow-y: auto`),
not the window, so `measureElement` and the sticky dock do not fight.

`getItemKey` returning the **segment id, not the index**, is load-bearing. With index keys React
recycles a DOM node between two different segments, and an uncontrolled textarea carries the
previous segment's text and caret into the new row. That is a data-corruption bug, not a
cosmetic one.

The virtualizer × `AutoGrowTextarea` interaction is the trickiest piece of UI engineering in v1.
The failure modes, and how each is handled:

| Failure | Mechanism | Handling |
|---|---|---|
| **Measurement thrash** | `AutoGrowTextarea` sets its own height in `useLayoutEffect`; `measureElement` observes the row with a `ResizeObserver` and writes a new offset; the offset change reflows the column; the reflow fires the observer again. Two `ResizeObserver`s and a layout effect in a cycle: the browser logs *"ResizeObserver loop completed with undelivered notifications"* and the list judders | Break the cycle by making the textarea's resize **width-triggered only**. `measureElement` observes the row *wrapper*; the textarea observes its container and early-returns unless `contentBoxSize.inlineSize` changed. Height changes therefore propagate outward and never back in |
| **Scroll jump on save** | A save changes a row's height. Every subsequent offset shifts. If the changed row is *above* the viewport, everything the user is looking at moves | Two measures. (a) A focused row is never re-measured — defer to `blur`. (b) Compensate explicitly: in the same `useLayoutEffect` that applies a measured delta, if `changedIndex < firstVisibleIndex` then `scrollElement.scrollTop += delta`. **TanStack does not do this for you**; without it, editing segment 12 while reading segment 300 moves the text under the cursor |
| **Focus loss on recycle** | Fast scrolling unmounts a focused row. `overscan` only delays it | **The focused row is always rendered.** Append its index to the virtual items when it is outside the window, positioned absolutely at its own measured offset. Ten lines, and it is the difference between "usable" and "loses my sentence" |
| **Estimate drift** | A constant `estimateSize: () => 72` against Burmese rows at line-height 1.9 wrapping to three lines makes the scrollbar lie; it jumps as real heights arrive | Estimate from data: `rowHeightHint` derives lines from `text.length / (columnWidth / avgAdvancePx[script])` and multiplies by the script's line-height and font size, plus reference-line height when shown. Measured heights are cached in a `Map<segmentId, number>` mirrored to `sessionStorage`, keyed by `(runId, layer, pass_id, columnWidth)` so a revisit is exact and an LLM pass invalidates it |
| **`scrollToIndex` lands wrong** | Deep-linking `#seg-900` scrolls to an *estimated* offset; measurement then moves the target | Call `scrollToIndex(i)` immediately and again inside `requestAnimationFrame` after the row measures. This is TanStack's own recommended workaround — write the comment so nobody "cleans it up" |
| **`Ctrl+F` finds nothing** | Only ~30 rows exist in the DOM | The real cost of virtualization. Ship our own find (`Ctrl+Shift+F`) over the full segment array with a match count and next/prev that `scrollToIndex` to each hit, and say in the shortcut sheet that the browser's find only sees the visible window. Copy-all and export read the array, never the DOM |
| **Print / select-all** | Same cause | Do not pretend the page prints. Provide "Copy transcript" and the export dialog (Phase 13) |

Row wrappers get `contain: layout paint`. `content-visibility` is deliberately **not** used — it
defers layout, which is exactly what `measureElement` needs to happen.

### 5. Drop the remount trick

Current code:

```tsx
<AutoGrowTextarea
  key={`${segment.id}-${segment.edited_text ?? segment.text}`}   // job-detail.tsx:501
  defaultValue={segment.edited_text ?? segment.text}
  onCommit={(value) => saveSegment(segment.id, value)}
/>
```

The key encodes the text, so any change to the saved value changes the key, so React unmounts and
remounts the textarea. It exists because the textarea is uncontrolled (`defaultValue`) and a
remount was the only mechanism available for pushing a server value in. What it costs:

- The DOM node is destroyed and recreated on **every** save round-trip. The caret jumps to the
  end, or focus is lost entirely if the blur that triggered the save moved focus elsewhere.
- The browser's native undo stack for that field is wiped. `Ctrl+Z` after a save does nothing.
- With optimistic updates it fires **twice** — once for the optimistic value, once for the server
  echo — and reads as a visible flicker on every commit.

Replacement: key on `segment.id` alone, keep the field uncontrolled, and reconcile external
changes through a ref.

```tsx
function SegmentText({ value, onCommit, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastServer = useRef(value);

  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastServer.current) return;   // ignore our own optimistic echo
    lastServer.current = value;
    if (document.activeElement === el) {
      // Never clobber a live edit. Record it and surface it on blur (§6).
      pendingExternal.current = value;
      return;
    }
    const { selectionStart, selectionEnd } = el;
    el.value = value;
    el.setSelectionRange(selectionStart, selectionEnd);
    resize(el);
  }, [value]);

  return <textarea ref={ref} defaultValue={value} rows={1} {...rest} />;
}
```

Three rules:

1. **A focused textarea is never written to from props.** Not by a save echo, not by an SSE event,
   not by a cleanup pass landing mid-sentence. Text vanishing while you type is the worst
   experience an editor can deliver.
2. `lastServer` stops the effect from fighting the optimistic value the user just produced.
3. A layer switch does rewrite the field — but switching layers also blurs, so it goes through the
   normal unfocused path with no special case.

### 6. Optimistic mutations and concurrency

**Today.** `PATCH /api/segments/:id` (`app/api/segments/[id]/route.ts:9-29`) does a blind
`UPDATE segments SET edited_text = ? WHERE id = ?` with no version check, and the client replaces
its state with the response (`job-detail.tsx:297-307`). Two editors on one interview silently lose
each other's work. So does one editor with two tabs open. This is the fourth of the four things
the overview says must change on the way over.

There is also a clever-but-surprising behaviour at `:22-25`: writing text equal to the raw ASR
text clears the override to `null`. The *intent* is right — "revert to ASR" is a real action — but
as an emergent property of string equality it means a legitimate human edit that happens to match
the ASR output is silently recorded as "never edited". Keep the capability, make it an explicit
`Revert to ASR` action in the row menu, and drop the equality special case.

**The new write.**

```
PATCH /api/segments/:id/text
  { layer, targetLang, text, ifMatchTextId }
  200 { id, text, updatedAt, origin, author }
  409 { current: { id, text, updatedAt, origin, author: { id, displayName } } }
```

```sql
UPDATE segment_texts SET superseded_at = now()
 WHERE segment_id = $1 AND layer = $2 AND target_lang = $3
   AND superseded_at IS NULL AND id = $4
RETURNING id;
-- zero rows → someone else superseded it → re-read the live row and return 409
```

On the overview's wording: it calls for an `updated_at` precondition. The mechanically stronger
form, *given that every write supersedes rather than overwrites*, is a precondition on the current
row's **id** — supersession always mints a new row, so identity is an exact check with no clock
involved and no same-millisecond ambiguity. Same guarantee, fewer edge cases; `updated_at` is
still returned to the client and shown in the conflict UI. When a segment has no `segment_texts`
row yet (the first human edit of a pure-ASR segment), the precondition is `ifMatchTextId: null`
enforced by an insert with the partial unique index, which fails cleanly if another writer got
there first.

**Optimistic flow** (`use-segment-mutations`):

1. On commit (blur or `Ctrl+Enter`), write `{ text, state: 'saving', baseId }` into a client cache
   keyed by `(segmentId, layer, targetLang)`. The row shows a 2 px amber tick on its inline edge.
2. Debounce 400 ms. Coalesce repeated edits of the same key into one in-flight request; keep at
   most one queued behind it (the latest wins — intermediate keystrokes are not history).
3. On 200: `state: 'saved'`, update `baseId`, the tick turns green and fades after 1 s.
4. On 409: `state: 'conflict'`. **Do not touch the textarea.** Render `<ConflictBar>` under the row:

   > **Also edited by Ma Thida, 12 s ago.**  [ Keep mine ]  [ Use theirs ]  [ Show both ]

   *Keep mine* re-PATCHes with the returned id as the new base and wins. *Use theirs* replaces the
   field (it is unfocused by then). *Show both* opens a small side-by-side with a word-level diff
   computed by `packages/core`'s Levenshtein — a direct payoff of putting the metrics in `core`
   rather than in the eval harness.
5. On network error: retry with full jitter up to 3×, then `state: 'error'` and a persistent
   toolbar chip — "2 unsaved changes · Retry all". The pending map is mirrored to `sessionStorage`
   per run, so a crashed tab recovers the text.
6. `beforeunload` guard whenever the pending map is non-empty.
7. Undo is the browser's own, inside the field — which works again only because §5 stopped
   remounting. Cross-row undo is out of scope; `segment_revisions` is the audit trail.

**The stale-while-focused case.** §5 refuses to write into a focused field, which is right, but
it leaves the user editing text that has moved underneath them. On blur, if `pendingExternal` is
set, surface the *same* `ConflictBar` — it is the identical decision ("mine or theirs?"), so it
gets the identical UI.

**Multi-user without collaborative editing.** Per the overview, ship `locked_by` plus a banner:

- The first edit in a run `POST`s `/api/runs/:id/lock`, setting `runs.locked_by` / `locked_at`,
  heartbeating every 30 s, released on unload or after 2 minutes stale.
- Another user opening the run sees an advisory banner: *"Ko Aung is editing this transcript. You
  can still edit — changes save per segment and conflicts are flagged."*
- **Advisory, never blocking.** Locking a second editor out of a transcript on deadline is worse
  than an occasional conflict bar, and the conflict bar already exists.

### 7. Layers

A segmented control in `RunToolbar` (shadcn `ToggleGroup`, `type="single"`):

```
[ Verbatim | Cleaned | Translated ▾ English ]      Show original alongside: [ none ▾ ]
```

Semantics:

- Exactly **one primary layer**: editable, full contrast, owns the textarea, the confidence marks
  and the word highlighting.
- **At most one reference layer**: read-only, muted (`text-muted-foreground`, ~90% size), rendered
  beneath the primary, with `unicode-bidi: plaintext` so an English translation under Pashto lays
  out LTR.
- **Translated carries a language sub-select** when `editorial_passes` has more than one
  `target_lang` for the run. With exactly one target it renders as a plain label — never show a
  one-option select.
- A layer with no pass is disabled with a tooltip that offers the action:
  *"Cleaned — not generated yet. Run it from the toolbar (~$0.04)."*
- Resolution goes through `resolveLayer(seg, texts, want, fallback)` from
  `packages/core/src/layers/resolve.ts`, the same function the exporters use. If the editor and
  the exporter disagree about what "cleaned" means for a segment the pass skipped, the exported
  file does not match what the journalist proofread.
- Editing a non-verbatim layer writes `(layer, origin = human)` and supersedes within that layer
  only. `segments.text` — the immutable ASR record — is never touched.
- Each row shows its origin: `asr` / `llm` / `human` / `rule`. `human` rows are the ones a later
  pass will skip and count in `segments_skipped_human`; surfacing the origin is what makes that
  skip comprehensible instead of looking like the pass failed.

**Why not stack all three** (current behaviour, `:500-523`): three text blocks per row at
line-height 1.9 is roughly 150 px per segment, so 1,500 segments is ~225,000 px of scroll — about
sixty screens. Worse than the length is the loss of anchoring: with three near-identical Burmese
paragraphs per row, the eye cannot hold which one is editable, and the cleaned layer differs from
verbatim by punctuation alone, so ~95% of those pixels are duplicates. A transcript editor is a
two-way comparison tool. Three-way comparison is a diff view, and that is deferred.

`Ctrl+1/2/3` switch the primary layer; `Ctrl+0` toggles the reference line.

### 8. Low-confidence marks

Source: `words.confidence`. Threshold default **0.6**, adjustable 0.3–0.9 in a toolbar popover,
persisted per user in localStorage. The feature renders only when
`provider.caps.wordConfidence === true` **and** `segments.has_words`.

**Rendering — dotted underline, opacity scaled by confidence, in the read-only span layer only.**

```tsx
<span
  className={low ? 'lowconf' : undefined}
  style={low ? {
    textDecorationColor:
      `color-mix(in oklab, var(--warn) ${Math.round((1 - w.confidence / threshold) * 100)}%, transparent)`,
  } : undefined}
  data-active={activeWordIdx === w.idx || undefined}
>{w.text}</span>
```

```css
.lowconf {
  text-decoration: underline dotted;
  text-decoration-thickness: 2px;
  text-underline-offset: var(--underline-offset, 0.28em);
  text-decoration-skip-ink: none;
}
[data-active="true"] { background: var(--active-word); border-radius: 2px; }
```

Why an underline and not a background:

- A background rectangle **fights the active-segment highlight and the active-word highlight**,
  which are themselves backgrounds. Two backgrounds on the same span means one wins and the other
  silently disappears, exactly when both matter (an uncertain word in the segment being played).
- On complex scripts a background box is painted around the em box. For Myanmar and Khmer, whose
  marks extend well above and below it, the box either clips visually or overlaps the neighbouring
  line, and the result looks like rendering corruption rather than an annotation.
- `text-underline-offset` puts the line clear of the descenders — but it must be script-aware,
  which is why §3b's generated CSS sets `--underline-offset: 0.45em` for Khmer, where coeng hangs
  lowest.
- **Opacity encodes confidence continuously.** 0.59 draws a faint hint; 0.15 draws a firm one. A
  binary mark claims more precision than the number supports, and treats a marginal word and a
  hopeless one identically.

**Why marks appear only when the row is unfocused.** `SegmentText` renders a read-only
`<div>` of word spans when unfocused and swaps to a `<textarea>` on focus. This is not a
compromise — it is what makes the feature possible at all. You cannot position an overlay under a
`<textarea>`; the standard hack is a mirror `<div>` with byte-identical wrapping, and that
**cannot be made correct** for complex scripts (shaping, ligature clusters, cluster-internal
breaks), for bidi runs, or for a font that loads after first paint — which, given `preload: false`,
is every non-Latin font in this app. Swapping the element eliminates the problem instead of
managing it.

The one real cost of the swap is caret placement: clicking into text must land the caret where the
user clicked, not at the end. Handle it on `mousedown`, before focus moves:

```ts
// apps/web/lib/caret.ts
export function offsetFromPoint(root: Node, x: number, y: number): number | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null };
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? charOffset(root, p.offsetNode, p.offset) : null; }
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); return r ? charOffset(root, r.startContainer, r.startOffset) : null; }
  return null;   // → focus with the caret at the end
}
```

then `textarea.setSelectionRange(offset, offset)` after focus.

**Toolbar affordances.**

- A count: **"38 uncertain words"**, from
  `SELECT count(*) FROM words WHERE run_id = $1 AND confidence < $2` — the schema's partial index
  `(run_id) WHERE confidence < 0.5` covers the default threshold.
- `Alt+↓` / `Alt+↑` jump to the next/previous uncertain word: `scrollToIndex`, focus the row,
  and place the caret at that word's character offset (summed from a per-segment `wordOffsets`
  array built alongside the time index). Jumping to a *row* is not enough — the point is to fix
  the word.
- An on/off toggle, because a transcript with 400 marks is noise and an editor doing a final read
  wants them gone.

**Providers without word confidence.** OpenAI and Groq Whisper have only `avg_logprob` at segment
level, so their capability is `wordConfidence: false`; whether Google Chirp populates it is spike
S2's open question.

The behaviour is to **hide the feature, not fake it**: no count, no marks, `Alt+↓` disabled with a
tooltip. In its place, one line in the toolbar overflow:

> Word confidence isn't available from Google `chirp_2`. faster-whisper reports it.

That is a true statement that also names the fix. Mapping `exp(avg_logprob)` onto words to fill
the space would be inventing per-word precision from a segment-level number, and the whole point
of tiering is that this product does not do that.

*(Small allowance, off by default and behind a setting: when only segment confidence exists, a
single subdued dot in the gutter for the bottom decile of segments. Honest, coarser, and clearly
a different signal. Ship it only if it costs nothing.)*

### 9. `has_words = false` — build this path first

Overview risk #2: word timings are the spine of half the design and the least reliable field in
the response. Chirp can return a perfectly good transcript with an empty word array for a
long-tail language. If the words path is built first and the degraded path bolted on afterwards,
the first Oromo file breaks four features simultaneously and each is debugged separately.

So the phase is built in this order, and each stage is shippable:

1. **No-words editor** — segments, gutter, textarea, save, layers, keyboard. Complete and usable.
2. **Words** — highlighting, per-word seek.
3. **Confidence** — marks, count, jump.

One derived flag computed once in `EditorShell` and passed down as a plain prop gates everything:

```ts
const caps = {
  words: run.word_timing_quality !== 'none',
  estimatedWords: run.word_timing_quality === 'partial',
  wordConfidence: provider.caps.wordConfidence && run.word_timing_quality !== 'none',
};
```

With `caps.words === false`:

| Feature | Behaviour |
|---|---|
| Segment highlighting | **Works.** `start_ms`/`end_ms` always exist |
| Word highlighting | Absent. `WordSpans` renders a single span of the whole text |
| Confidence marks / count / `Alt+↓` | Absent; the shortcut is disabled with a tooltip |
| Clicking inside text | Seeks to the **segment** start, not a word |
| Speaker chips | Render, but always carry `needs_speaker_review` (reconcile step 4 — never silently attribute) |
| A note above the list | Dismissible, per run |

> **No word timings for this file.** Google `chirp_2` returned segments without word-level
> timestamps. Segment playback and editing work normally; word highlighting, confidence marks and
> per-word speaker attribution are unavailable. Re-running with faster-whisper would provide them.

For `word_timing_quality = 'partial'`, rows whose words are `is_estimated` show a small `≈` in the
gutter meaning *timings interpolated*. An estimated timing is never presented as a measured one.

Implementation rule: every word-dependent component takes an **explicit** no-words branch. Do not
rely on `words?.map(...)` returning an empty array — that renders an empty row and looks like data
loss.

### 10. Keyboard

Transcript correction is 90% typing and 10% navigating, and the navigating is what costs the time.
An editor who reaches for the mouse to replay the last three seconds does it several hundred times
in a 90-minute file; at two seconds each that is ten to fifteen minutes of pure mouse travel per
file, every file, forever. **A beautiful editor with mouse-only replay loses to a plain one with
`Ctrl+←`.** This is where the product is won or lost, and it is cheap — the entire map below is
one keydown handler and a dialog.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Next / previous segment textarea, caret at end |
| `Ctrl+Enter` | Commit and advance |
| `Esc` | Revert this field to the last saved value and blur |
| `Ctrl+Space` (alias `Ctrl+/`) | Play / pause — **works from inside the textarea** |
| `Ctrl+←` / `Ctrl+→` | Seek −3 s / +3 s |
| `Ctrl+Shift+←` / `Ctrl+Shift+→` | Jump to the previous / next segment boundary in the audio |
| `Ctrl+L` | Loop the current segment |
| `Alt+↑` / `Alt+↓` | Previous / next uncertain word (disabled without word confidence) |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Primary layer: verbatim / cleaned / translated |
| `Ctrl+0` | Toggle the reference line |
| `Ctrl+Shift+F` | Find in transcript (see §4 — browser find only sees the visible window) |
| `?` | Shortcut sheet — only when focus is not in an editable field |

Implementation notes:

- Bind on the list container with `onKeyDown` in the capture phase, not on `window`. Dialogs and
  the shortcut sheet then need no unbinding, and Radix's own escape handling keeps working.
- `Ctrl+Space` needs `preventDefault` before the textarea sees it. On macOS it is the input-source
  switcher for users with multiple keyboards — which is *most* users of this product. Hence the
  `Ctrl+/` alias, and the shortcut sheet lists both so the conflict is discoverable rather than
  mysterious.
- **Never bind bare letters.** A `j`/`k` navigation map is actively hostile in an application whose
  primary interaction is typing. `?` is the only bare key, guarded by `!isEditable(document.activeElement)`.
- `Tab` is normally focus traversal, and overriding it is usually wrong. It is justified here
  because the only tabbable elements in the list are the textareas — the timecode button, the
  speaker chip and the row menu are `tabIndex={-1}` and reachable from the row menu — so the
  override *preserves* the expected behaviour while skipping three stops per row that nobody wants.
- **Every shortcut also has a visible control.** Keyboard-only features are undiscoverable, and the
  sheet is not a substitute for a button.

### 11. Zawgyi buttons

Keep them (`job-detail.tsx:329-339` and `:525-540`). Myanmar has a live Zawgyi/Unicode split; a
source file whose accompanying transcript is Zawgyi is a normal case, and so is exporting for a
partner still on Zawgyi. Removing this would be removing a feature that Burmese newsrooms actually
use.

Four changes:

1. **Gate on the registry, not on an assumption.** Show them when
   `resolveLanguage(job.languageCode).text.zawgyiApplies` is true — not when the script is `Mymr`.
   Shan and Mon also use `Mymr` and the flag differs. The current app is Burmese-only, so it never
   had to ask.
2. **Move into the row overflow menu.** The row now carries a timecode, a speaker chip, text, a
   save-state tick and (Phase 13) an add-to-glossary affordance. Two always-hovering conversion
   buttons are clutter for an operation used a handful of times per file. `RowMenu` gets: *Convert
   Zawgyi → Unicode*, *Convert Unicode → Zawgyi*, *Split segment here*, *Revert to ASR*, *Copy with
   timecode*, *Add to glossary* (Phase 13).
3. **Add a run-level conversion** in the toolbar overflow, with a confirmation showing how many
   segments the Zawgyi detector flagged. Nobody is going to convert 1,500 segments one row at a
   time; the per-row action is for the exceptions.
4. **Convert per word and re-derive the segment text.** Zawgyi↔Unicode conversion is **not
   length-preserving**, so converting segment text — which is what `:333` does, and which predates
   word storage entirely — desynchronises every word offset in the segment and silently breaks
   highlighting, confidence marks and word-level speaker attribution. The overview states this rule
   under normalize-text; the editor must obey the same one. The current segment-level implementation
   **must not survive**.

Refinement: run the detector per segment and order the menu by likelihood — if the segment scores
> 0.9 Zawgyi, *Convert Zawgyi → Unicode* is first and the reverse is labelled "(unlikely)".

## Deferred from this phase

Stated explicitly so they are not mistaken for omissions:

| Deferred | Why, and what ships instead |
|---|---|
| **Word-level editing** (re-timing, splitting words, forced realignment) | Needs forced alignment; multi-week on its own. Word timings are stored, confidence is shown, editing is at segment granularity |
| **Run-vs-run diff** | The run-tab strip lets you switch between runs; a synchronized diff view is a separate design |
| **Waveform visualisation** | The peaks (20 buckets/s, min+max int8) are already produced and stored by Phase 1's normalize step, so the data is waiting whenever the UI arrives |
| **Collaborative editing** (CRDT/OT, live cursors) | Ships as `runs.locked_by` + an advisory banner + the 409 conflict bar (§6) |
| **Segment merge** | Overview risk #3 permits exactly one narrow human exception — a **split** at an existing word boundary. Merge would supersede two rows into one, which the `split_of` lineage model does not describe |
| **Document-pass editing** (summary, chapters, quotes) | Read-only panel with copy buttons — Phase 13 |
| **Mobile layout** | Explicitly cut in the overview |

## Porting notes

| Old (`~/Coding_work/myanmar-transcription`) | New | Treatment |
|---|---|---|
| `job-detail.tsx:62-102` `AutoGrowTextarea` | `components/editor/segment-text.tsx` | **Verbatim**, comments included. Add a width-only `ResizeObserver` as a fourth leg |
| `job-detail.tsx:214-218` `formatClock` | `packages/core/src/timecode.ts` | Verbatim + an `h:mm:ss.s` branch past 3600 s |
| `job-detail.tsx:46-52` `STATUS_STYLES` | `components/run-status-pill.tsx` (Phase 11) | Verbatim colour pairs, extended states |
| `job-detail.tsx:371-380` sticky audio dock | `components/editor/audio-dock.tsx` | Verbatim markup; **keep `preload="metadata"`**; add URL re-minting, rate, loop |
| `job-detail.tsx:396-415` run-tab strip | `components/editor/run-tabs.tsx` | Structure verbatim; add model, language, cost, primary star, probe styling |
| `job-detail.tsx:486-498` timecode seek button | `components/editor/segment-row.tsx` | Verbatim behaviour (`currentTime = start; play()`), now `tabIndex={-1}` |
| `job-detail.tsx:436-467` export links + post-process buttons | `components/editor/run-toolbar.tsx` | Restructured; export becomes a dialog in Phase 13 |
| `job-detail.tsx:329-339` `convertSegment` | `components/editor/row-menu.tsx` + engine | Rewritten: per-word conversion, registry-gated |
| `job-detail.tsx:546-548` "no speech segments" | `components/editor/segment-list.tsx` | Verbatim copy; keep it — a silent empty list looks like a bug |
| `app/api/segments/[id]/route.ts` | `app/api/segments/[id]/text/route.ts` | Rewritten: layer-aware, supersede, precondition, 409 |

**Must not survive the port:**

| Thing | Where | Why |
|---|---|---|
| `key={`${segment.id}-${segment.edited_text ?? segment.text}`}` | `job-detail.tsx:501` | Remount per save; loses caret and undo (§5) |
| `onTimeUpdate={(e) => setCurrentTime(...)}` | `job-detail.tsx:378` | Re-renders every segment ~4×/s (§3) |
| `if (update.status === 'done') refetch()` | `job-detail.tsx:277` | Re-downloads every segment on a progress tick |
| Blind `UPDATE segments SET edited_text` | `app/api/segments/[id]/route.ts:25` | Silently loses concurrent edits (§6) |
| The `edited_text === text → null` special case | `app/api/segments/[id]/route.ts:22-25` | Becomes an explicit *Revert to ASR* action |
| Stacking cleaned + translation under every row | `job-detail.tsx:500-523` | Unreadable past a few hundred segments (§7) |
| `className="font-myanmar"` on the textarea | `job-detail.tsx:504,509` | Replaced by `{...scriptAttrs(job.languageCode)}` |
| Segment-level Zawgyi conversion | `job-detail.tsx:333` | Not length-preserving; desynchronises words (§11) |

## Tests

**Fixtures** (`apps/web/__fixtures__/`)

| Fixture | Shape |
|---|---|
| `transcript-burmese-1500.json` | 1,500 segments, ~14,000 words, `Mymr`, full timings and confidence |
| `transcript-oromo-nowords.json` | 420 segments, `has_words = false`, `word_timing_quality = 'none'` |
| `transcript-pashto-rtl.json` | 300 segments, `Arab`/rtl, embedded Latin acronyms and digits |
| `transcript-partial-words.json` | Half the segments `is_estimated` |
| `transcript-two-targets.json` | Translated into `en` and `fr` |
| `words-lowconf.json` | Exactly 38 words below 0.6, 3 below 0.2 |

**Unit**

- `time-index.spec.ts` — `findSegment` at exact starts, exact ends, in gaps (→ −1), before the
  first, after the last, and on an empty index; plus a property test over 10,000 random times
  against a linear scan on `transcript-burmese-1500`
- `playback-store.spec.ts` — `set` with an identical snapshot notifies **zero** listeners;
  changing only `wordIdx` notifies; `getSnapshot` returns a referentially stable value between
  changes (the React `getSnapshot should be cached` guard)
- `segment-text.spec.tsx` —
  `no-remount-on-save` (capture the DOM node before a save round-trip and assert it is the *same
  node* afterwards — this is the direct test that §5 landed),
  `does-not-clobber-focused-field`, `syncs-when-unfocused`, `preserves-selection-on-external-sync`,
  `surfaces-external-change-on-blur`
- `use-segment-mutations.spec.ts` — `coalesces-rapid-edits` (3 edits in 100 ms → 1 request),
  `queues-at-most-one-behind-inflight`, `409-does-not-overwrite-the-field`,
  `keep-mine-rebases-and-wins`, `retries-network-error-3x-with-jitter`,
  `mirrors-pending-to-sessionStorage`, `beforeunload-when-pending`
- `layers.spec.tsx` — `lang-select-only-with-two-targets` (uses `transcript-two-targets`),
  `single-target-renders-a-label`, `missing-pass-disabled-with-cost-tooltip`,
  `reference-line-is-readonly`, `at-most-one-reference`
- `confidence.spec.tsx` — `count-is-38` (from `words-lowconf`),
  `decoration-color-scales` (0.15 and 0.55 produce different `textDecorationColor`),
  `hidden-when-wordConfidence-false`, `hidden-when-has-words-false`,
  `threshold-change-updates-count`
- `no-words.spec.tsx` — the note renders with the provider name; `Alt+↓` disabled with a tooltip;
  clicking text seeks to the segment start; segment highlighting still works
- `zawgyi.spec.tsx` — `hidden-for-ha-NG`, `shown-for-my-MM`,
  `converts-per-word-and-rederives-segment-text` (asserts word count and per-word offsets stay
  consistent after conversion — the regression this change exists to prevent),
  `orders-menu-by-detector-score`
- `timecode.spec.ts` — parity with the old `formatClock` on 1,000 values, plus the hours branch

**Browser (Playwright)**

- `editor-perf.spec.ts` — **the test that stops this rotting back into `setCurrentTime`.** Load
  `transcript-burmese-1500`, play for 20 s, and assert: zero long tasks > 50 ms
  (`PerformanceObserver` on `longtask`), fewer than 10 `SegmentRow` renders per second (counted by
  a test-only render counter behind `NEXT_PUBLIC_RENDER_COUNTERS`), and a DOM node count under 400
- `virtualizer.spec.ts` —
  `focus-survives-scroll` (focus segment 40, type, scroll to 900 and back: focus and text intact),
  `no-scroll-jump-on-save` (viewing 300, save 12: `scrollTop` delta is 0),
  `deep-link-scrolls-exactly` (`#seg-900` in view after two frames),
  `no-resize-observer-loop-errors` (assert the console has no `ResizeObserver loop` warning after
  scrolling the full list)
- `keyboard.spec.ts` — walk 5 segments with `Tab`; `Ctrl+Enter` commits and advances;
  `Ctrl+Space` toggles playback from inside a textarea without inserting a space;
  `Alt+↓` lands on the first low-confidence word with the caret at its start;
  `Ctrl+2` switches layer; `?` opens the sheet and `Esc` closes it; `?` typed inside a textarea
  inserts a literal `?`
- `conflict.spec.ts` — two browser contexts edit segment 7: the second gets the conflict bar;
  *Use theirs* replaces; *Keep mine* rebases and wins; `segment_revisions` contains both
- `audio-url-refresh.spec.ts` — advance the clock past 12 minutes, seek, and assert a re-mint
  request fired and `currentTime` was preserved
- `word-sync.spec.ts` — at a known timestamp on a fixture with hand-checked word boundaries, the
  highlighted word index matches within one word for 20 sampled instants
- `rtl.spec.ts` — Pashto: textarea `dir="rtl"`, row wrapper and `<html>` not; gutter left of text;
  the English reference line lays out LTR
- `caret.spec.ts` — click into the middle of a word in the read-only span layer; after the swap the
  textarea's `selectionStart` is within one character of the clicked offset

## Verification

Seed a stack with a 90-minute Burmese job (1,500 segments, full words), the Oromo no-words job, and
a Pashto job.

1. **Scroll.** Open the Burmese job. Scroll the full transcript. Chrome Performance shows no long
   tasks; the Elements panel shows fewer than ~40 rows in the DOM at any time.
2. **Playback re-renders.** Press play. Open React DevTools Profiler with *record why each render
   happened*. Exactly **two** `SegmentRow`s re-render per segment transition, and `SegmentList`
   itself does not re-render at all. This is the observation that proves §3.
3. **Word sync.** Watch the highlight during speech. It should track *within* the word, not lag by
   a quarter second. Temporarily switch the driver to `timeupdate` — the difference must be obvious
   to the naked eye. Switch back.
4. **Focus survival.** Click into segment 300, type a few words, scroll to 900, scroll back. The
   text is there and the field still has focus.
5. **No scroll jump.** With segment 300 on screen, edit and save segment 12 in a second tab (or via
   `Alt+↑` to it and back). Nothing under the cursor moves.
6. **No remount.** With DevTools inspecting a segment's `<textarea>` node, edit and blur. The
   inspected node must **not** be replaced in the Elements panel, and `Ctrl+Z` afterwards must still
   undo within the field.
7. **Conflict.** Two browsers, same segment, both edit. The second sees the conflict bar naming the
   other user. *Keep mine* wins; *Use theirs* replaces; *Show both* renders a word diff.
   `segment_revisions` has both rows.
8. **Layers.** `Ctrl+1/2/3` switch the primary layer. Turn on "show original alongside". Scroll: row
   heights are stable, and at 200% zoom Burmese diacritics above and below are fully visible.
   Translated with two targets shows a language sub-select; with one it does not.
9. **Confidence.** Toolbar reads "38 uncertain words". `Alt+↓` walks them in order and places the
   caret on each word. Raise the threshold to 0.8 — the count grows and more marks appear. Toggle
   off — all marks disappear, the count hides.
10. **No word confidence.** Switch to a run from an OpenAI-Whisper provider. The count, the marks and
    `Alt+↓` are gone, and the overflow shows the "faster-whisper reports it" line. Nothing is shown
    as certain that isn't.
11. **No words at all.** Open the Oromo job. The note names the provider. Playback still highlights
    segments. Clicking text seeks to the segment start. `Alt+↓` is disabled with a tooltip. No empty
    word row is rendered anywhere.
12. **Partial words.** Open the partial fixture: rows with interpolated timings carry `≈`, and
    hovering explains it.
13. **Audio TTL.** Leave the editor open for 20 minutes, then seek. Audio plays; the Network tab
    shows a re-mint; playback position was preserved.
14. **Keyboard.** Do a full correction pass on ten segments without touching the mouse: `Tab` to
    move, `Ctrl+Space` to replay, `Ctrl+←` to rewind, `Ctrl+Enter` to commit. Then open `?` and
    confirm every listed shortcut works and every one also has a visible control.
15. **Find.** `Ctrl+Shift+F` for a word that occurs at segment 1,200 (outside the DOM window). It is
    found, counted and scrolled to. The sheet explains why the browser's own find does not.
16. **RTL.** Pashto job: text RTL, chrome LTR, gutter left, English reference line LTR, timecodes
    not reordered.
17. **Zawgyi.** On the Burmese job, convert one segment via the row menu; the word count and word
    offsets stay consistent (check `/api/runs/:id/segments?from=&count=1`). The buttons are absent
    on the Hausa job.

## Risks and open questions

1. **The virtualizer × auto-grow interaction is the highest-uncertainty item in v1.** Mitigation:
   spike it before committing. Build `SegmentList` against `transcript-burmese-1500` with *dummy
   fixed-content rows* first, prove 60 fps and stable measurement, and only then introduce the
   textarea. If measurement thrash cannot be tamed in a day, the fallback is fixed-height rows with
   internal scrolling on overflow — worse, but shippable, and it does not block anything else in the
   phase.
2. **rAF sampling may still stutter.** Chromium's media element clock does not necessarily advance
   `currentTime` once per animation frame. If word highlighting visibly steps, interpolate between
   real samples using `performance.now()` and `playbackRate`, resyncing whenever `currentTime`
   actually changes. Do not build the interpolation until step 3 of Verification says it is needed.
3. **1,500 subscribers on one store.** Every `store.set` iterates the listener set. The early return
   on an unchanged snapshot keeps that at zero for most frames, but a fast seek changes the snapshot
   every frame and pays 1,500 closure calls per frame. Measure it; if it is hot, shard the store by
   segment-index bucket so a change notifies only the bucket that contains the old and new indices.
4. **`caretPositionFromPoint` is not in Safari** (it has `caretRangeFromPoint`), and neither exists
   in some embedded WebViews. Feature-detect; the fallback is caret-at-end, which is annoying but not
   broken.
5. **Spike S2 governs how much of §8 is visible.** If Chirp returns no word confidence, marks are a
   faster-whisper-only feature in practice, which weakens the case for building them in this phase.
   The gate (§8's hide-the-feature path) is required regardless and is built first; the marks follow.
6. **Optimistic echo versus SSE.** A cleanup pass finishing while a user is mid-sentence pushes new
   text for an open row. §5's "never write a focused field" is correct but leaves them editing stale
   content. The on-blur surface reuses the 409 `ConflictBar`, but the *copy* differs ("a cleanup pass
   changed this while you were typing"), and that wording needs a decision.
7. **Row-height cache staleness.** The `sessionStorage` height cache keyed by segment id goes wrong
   after an LLM pass rewrites text or after a font finally loads. Key it on
   `(runId, layer, pass_id, columnWidth)` and clear it on the `fonts.ready` promise resolving.
8. **`Ctrl+Space` on macOS** collides with the input-source switcher for exactly the multilingual
   users this product targets. The `Ctrl+/` alias is the mitigation; if testing shows people still
   hit the collision, make the play/pause binding user-configurable in Phase 14.
9. **Zawgyi per-word conversion needs engine support**, not just a UI change — the write must
   re-derive segment text and rewrite word rows in one transaction. Confirm Phase 1's normalize-text
   module exposes that as a callable operation rather than only as a pipeline stage.

## Definition of done

- [ ] `/jobs/[id]` renders 1,500 segments with fewer than ~40 rows in the DOM and no long tasks
      while scrolling
- [ ] During playback, exactly two `SegmentRow`s re-render per segment transition and `SegmentList`
      does not re-render (asserted by `editor-perf.spec.ts`)
- [ ] `currentTime` appears in no React state anywhere in the editor
- [ ] Word highlighting is driven by `requestAnimationFrame`, and visibly tracks speech within the
      word
- [ ] Focusing a row, scrolling 900 rows away and back preserves focus and unsaved text
- [ ] Editing a row above the viewport does not move the viewport
- [ ] Saving does not replace the textarea DOM node; in-field `Ctrl+Z` still works after a save
- [ ] `PATCH /api/segments/:id/text` returns 409 on a stale precondition and the UI resolves it
      three ways without ever overwriting a focused field
- [ ] `runs.locked_by` produces an advisory banner that never blocks a second editor
- [ ] Exactly one editable layer and at most one muted reference are visible at a time
- [ ] Translated shows a language sub-select only when the run has more than one target
- [ ] Low-confidence words are dotted underlines whose colour scales with confidence, never
      backgrounds
- [ ] The whole confidence feature is hidden — not faked — when the provider lacks word confidence
- [ ] The `has_words = false` path was built and shipped **before** the words path, and the Oromo
      fixture renders a usable editor with an explanatory note
- [ ] Every shortcut in the table works, `?` opens the sheet, and every shortcut also has a visible
      control
- [ ] Zawgyi conversion is registry-gated, lives in the row overflow menu, runs per word, and leaves
      word offsets consistent
- [ ] No file in `components/editor/` exceeds ~200 lines
- [ ] Pashto renders RTL text with LTR chrome and a left-hand timecode gutter
- [ ] Deferred items (word editing, run diff, waveform, collaborative editing, merge, mobile) are
      absent and recorded in this document

