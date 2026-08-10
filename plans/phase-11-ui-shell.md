# Phase 11 — UI shell, upload, job list, language picker

## Goal

At the end of this phase `apps/web` is a real application rather than a CLI wrapper: an
auth-gated Next.js 16 App Router shell with shadcn/ui, a registry-driven multi-script rendering
system that can display all twenty-two scripts in the language registry without shipping a
single unused font file, a job list that shows language, tier, project, status and cost, three
ingest paths (file, batch, URL) over the Phase 8 API, a 107-language picker that makes tier
honesty visible at the moment of choice, a cost confirmation dialog that covers ASR *and* the
LLM passes, and a live progress stream. The demo is: log in → drop a Hausa file → pick the
language → see the estimate → run → watch progress to completion. It sits here because it needs
Phase 10's `requireUser()` and browser-configured provider keys underneath it, and because Phase
12's editor needs the shell, the script system, the SSE hook and `ConfirmRunDialog` to already
exist. Everything in this phase is deliberately not the editor — `/jobs/[id]` renders a run
timeline and a read-only transcript until Phase 12 replaces it.

## Prerequisites

| Phase | What this phase consumes |
|---|---|
| 0 | `packages/languages` frozen registry: `code, nameEn, endonym, altNames, script{code,direction,complex}, typography{...}, text{...}` |
| 5 | `language_support` rows (tier, cer, cer_baseline, cer_ratio, eval_n, eval_date, enabled) and `results/tiers.json` |
| 8 | ingest API: single file, batch, and the `yt-dlp --dump-json` resolve step |
| 9 | `run_events` + `GET /api/jobs/:id/stream` with `Last-Event-ID` replay; `X-Accel-Buffering: no` |
| 10 | `requireUser()` / `requireAdmin()` in React `cache()`, the `action()` server-action wrapper, `proxy.ts` cookie check, `settings`/`rates` tables |
| 1 | `media_assets.duration_ms` from probe; presigned media URL route |

Blocking decision from Phase 0: spike **S2** (`wordConfidence` on Chirp) does not block this
phase but determines whether the picker's provider line can advertise word confidence.

## Deliverables

| Path | Purpose |
|---|---|
| `apps/web/package.json` | next 16, react 19, tailwind v4, `cmdk`, `@radix-ui/*` (via shadcn), `@tanstack/react-virtual` (installed here, used in 12) |
| `apps/web/next.config.ts` | `transpilePackages` for `@thibi/core`, `@thibi/languages`, `@thibi/db` |
| `apps/web/postcss.config.mjs` | `@tailwindcss/postcss` only — Tailwind v4 has no JS config |
| `apps/web/components.json` | shadcn config: `new-york`, CSS variables, `@/components/ui` alias |
| `apps/web/app/globals.css` | `@import "tailwindcss"`, `@theme` tokens, `@import "./generated/scripts.css"` |
| `apps/web/app/fonts.ts` | Nineteen static `next/font/google` declarations + `SCRIPT_FONTS` map |
| `apps/web/app/generated/scripts.css` | **Generated, committed.** One `[data-script="…"]` rule per script |
| `apps/web/scripts/gen-scripts.ts` | Build-time generator + `--check` mode for CI |
| `apps/web/app/layout.tsx` | `<html>`/`<body>`, font CSS variables, `<Toaster/>`. No chrome, no nav |
| `apps/web/app/(auth)/layout.tsx` | Centred card, no app chrome |
| `apps/web/app/(auth)/login/page.tsx` | Phase 10's form, restyled to shadcn |
| `apps/web/app/(app)/layout.tsx` | `await requireUser()` → `<AppShell user>` |
| `apps/web/app/(app)/page.tsx` | Job list (server component) |
| `apps/web/app/(app)/jobs/new/page.tsx` | Tabs: File / Batch / From URL |
| `apps/web/app/(app)/jobs/[id]/page.tsx` | Run timeline + read-only transcript; Phase 12 replaces the body |
| `apps/web/app/(app)/glossaries/page.tsx` | Stub with an empty state → Phase 13 |
| `apps/web/app/(app)/settings/layout.tsx` | Settings nav; `requireAdmin()` on the write pages |
| `apps/web/app/(app)/settings/{providers,models,languages,users,retention}/page.tsx` | Stubs → Phase 14, except `languages` which renders `tiers.json` read-only now because the picker links into it |
| `apps/web/app/(app)/admin/layout.tsx` | `await requireAdmin()` |
| `apps/web/app/(app)/admin/{queue,system}/page.tsx` | Stubs → Phase 14 |
| `apps/web/components/ui/*` | shadcn-generated: button, dialog, popover, command, select, tabs, table, badge, input, label, textarea, separator, tooltip, dropdown-menu, alert, sonner, skeleton, checkbox, toggle-group |
| `apps/web/components/app-shell.tsx` | Header, project switcher, user menu, nav |
| `apps/web/components/scripted-text.tsx` | `<ScriptedText script dir lang as>` |
| `apps/web/components/language-picker.tsx` | The Command-in-Popover picker |
| `apps/web/components/tier-pill.tsx` | verified / beta / experimental pills |
| `apps/web/components/confirm-run-dialog.tsx` | Ported dialog, extended estimate |
| `apps/web/components/run-status-pill.tsx` | `STATUS_STYLES`, extended state machine |
| `apps/web/components/dropzone.tsx` | Drag-depth-counted dropzone |
| `apps/web/components/job-table.tsx` | Job list table with project grouping |
| `apps/web/components/provider-alert.tsx` | "Google not configured yet" alert |
| `apps/web/components/new-job/{file-tab,batch-tab,url-tab}.tsx` | The three ingest tabs |
| `apps/web/hooks/use-run-stream.ts` | SSE hook + `RunStreamProvider` context |
| `apps/web/hooks/use-recent-languages.ts` | localStorage MRU via `useSyncExternalStore` |
| `apps/web/lib/language-search.ts` | `fold()` + `matchLanguage()` for cmdk |
| `apps/web/app/api/ingest/url/resolve/route.ts` | Enqueue resolve, return step id |
| `packages/core/src/pricing/format.ts` | **Ported verbatim** from `lib/pricing/format.ts` |
| `packages/core/src/pricing/estimate.ts` | New: LLM pass cost estimation with per-script `charsPerToken` |
| `packages/core/src/format/{bytes,duration}.ts` | Ported from `app/page.tsx:25-35` |
| `packages/languages/src/script-attrs.ts` | `scriptAttrs(code) → { 'data-script', dir, lang }` |

## Design

### 1. Stack setup

Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui. Tailwind v4 is CSS-first: there is no
`tailwind.config.js`, tokens live in `@theme` inside `globals.css`, and the PostCSS plugin moved
to `@tailwindcss/postcss`. Initialise shadcn *from `apps/web`*, not the repo root, so
`components.json` resolves aliases against the app's `tsconfig` paths.

```bash
cd apps/web
pnpm dlx shadcn@latest init            # new-york, CSS variables, neutral base
pnpm dlx shadcn@latest add button dialog popover command select tabs table badge \
  input label textarea separator tooltip dropdown-menu alert sonner skeleton checkbox toggle-group
```

Pin the CLI version in `apps/web/package.json` under a `shadcn` field and commit
`components.json` — the registry emits different CSS for Tailwind v3 vs v4 and an unpinned
`latest` will eventually generate v3 output into a v4 app.

What each component actually buys, so this is not cargo cult:

| Component | Why it is worth the dependency |
|---|---|
| `Command` (cmdk) | The language picker. 107 rows with grouping, keyboard navigation, `aria-activedescendant` and a custom scorer. Hand-rolling the a11y here is a week |
| `Popover` | Radix's collision-aware positioning. Our picker is 420 px wide and opens near the viewport edge in the batch table |
| `Dialog` | Focus trap, scroll lock, `aria-modal`, Escape, backdrop. Replaces the hand-rolled version at `job-detail.tsx:144-211` |
| `Select` | Provider, layer target, project. Native `<select>` cannot render a tier pill |
| `Tabs` | `/jobs/new`, `/settings`. Roving tabindex + `aria-controls` |
| `Table` | Job list. Mostly styling, but it keeps the markup honest (`<caption>`, scope) |
| `sonner` (Toast) | Save/error toasts. Chosen over the deprecated shadcn `toast` |
| `DropdownMenu` | Row overflow menus in the batch table and (Phase 12) the segment row |
| `Alert` | The unconfigured-provider notice, ported from `app/page.tsx:129-137` |

**We do not adopt shadcn's opinions where the old app already had better ones.** The
`ConfirmRunDialog` copy, the warning cards and `STATUS_STYLES` port as-is; only the surrounding
chrome becomes Radix.

### 2. Route tree and layouts

```
apps/web/app/
  layout.tsx                        <html lang="en"> + font vars + Toaster. No nav.
  (auth)/
    layout.tsx                      centred card
    login/page.tsx
    setup/page.tsx                  Phase 10; token-gated, not behind requireUser
  (app)/
    layout.tsx                      const user = await requireUser()  → <AppShell user>
    page.tsx                        job list
    jobs/new/page.tsx
    jobs/[id]/page.tsx
    glossaries/page.tsx  glossaries/[id]/page.tsx
    settings/
      layout.tsx                    settings nav
      providers|models|languages|users|retention/page.tsx
    admin/
      layout.tsx                    await requireAdmin()
      queue|system/page.tsx
```

Rules, stated once so they are not re-litigated per route:

- `proxy.ts` (Next 16's replacement for `middleware.ts`) does a **cookie-presence check only** and
  redirects to `/login`. It is a UX optimisation. CVE-2025-29927 is the reason it is never an
  authorization boundary.
- `(app)/layout.tsx` calling `requireUser()` protects **pages**. It does not protect route
  handlers or server actions, which are independently addressable POST endpoints. Every route
  handler in `app/api/**` calls `requireUser()` itself; every server action is wrapped in Phase
  10's `action()`. The lint rule from Phase 10 enforces both.
- `requireUser()` is wrapped in React `cache()`, so the layout call and a page call in the same
  request hit the DB once.
- Data comes from server components through props. There is no `useEffect(() => fetch(...))` in
  this app. `app/page.tsx:46-57` is the pattern being deleted: it produces a blank flash, two
  round trips, and no way to stream.

### 3. Multi-script rendering — the whole system

This replaces `.font-myanmar` (`app/globals.css:29-33`) and the single `Noto_Sans_Myanmar`
import (`app/layout.tsx:3,16-20`). Four parts: static font declarations, generated CSS, a
component, and a build-time completeness check.

#### 3a. `app/fonts.ts` — static declarations, `preload: false`

`next/font/google` is a build-time transform: the arguments must be literals at module scope.
There is no dynamic route — you cannot write `notoFor(script)`. So every family is declared
explicitly, and the registry's job is to *verify* the list rather than generate it at runtime.

```ts
// apps/web/app/fonts.ts
import {
  Noto_Sans, Noto_Sans_Mono,
  Noto_Sans_Arabic, Noto_Sans_Armenian, Noto_Sans_Bengali, Noto_Sans_Ethiopic,
  Noto_Sans_Georgian, Noto_Sans_Gujarati, Noto_Sans_Gurmukhi, Noto_Sans_Hebrew,
  Noto_Sans_Kannada, Noto_Sans_Khmer, Noto_Sans_Lao, Noto_Sans_Malayalam,
  Noto_Sans_Myanmar, Noto_Sans_Oriya, Noto_Sans_Sinhala, Noto_Sans_Tamil,
  Noto_Sans_Telugu, Noto_Sans_Thai,
} from 'next/font/google';

const common = { display: 'swap', preload: false, weight: ['400', '700'] } as const;

// One family covers five scripts: Google serves Noto Sans with per-subset @font-face
// blocks carrying unicode-range, so declaring six subsets does not mean six downloads.
export const notoSans = Noto_Sans({
  variable: '--font-noto-latn',
  subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'devanagari', 'vietnamese'],
  display: 'swap',
  preload: true,          // the ONLY preloaded family — it renders the app chrome
  weight: ['400', '500', '700'],
});

export const notoMono = Noto_Sans_Mono({
  variable: '--font-mono', subsets: ['latin'], display: 'swap', preload: true, weight: ['400'],
});

export const notoMymr = Noto_Sans_Myanmar({ variable: '--font-noto-mymr', subsets: ['myanmar'], ...common });
export const notoKhmr = Noto_Sans_Khmer({ variable: '--font-noto-khmr', subsets: ['khmer'], ...common });
export const notoEthi = Noto_Sans_Ethiopic({ variable: '--font-noto-ethi', subsets: ['ethiopic'], ...common });
export const notoArab = Noto_Sans_Arabic({ variable: '--font-noto-arab', subsets: ['arabic'], ...common });
// … hebrew, bengali, gurmukhi, gujarati, oriya, tamil, telugu, kannada,
//     malayalam, sinhala, thai, lao, georgian, armenian

/** The registry's contract: every script code in languages.json must appear here. */
export const SCRIPT_FONTS = {
  Latn: notoSans, Cyrl: notoSans, Grek: notoSans, Deva: notoSans,
  Mymr: notoMymr, Khmr: notoKhmr, Ethi: notoEthi, Arab: notoArab,
  Hebr: notoHebr, Beng: notoBeng, Guru: notoGuru, Gujr: notoGujr,
  Orya: notoOrya, Taml: notoTaml, Telu: notoTelu, Knda: notoKnda,
  Mlym: notoMlym, Sinh: notoSinh, Thai: notoThai, Laoo: notoLaoo,
  Geor: notoGeor, Armn: notoArmn,
} as const;

/** Scripts we deliberately do not bind, with the reason recorded. */
export const SCRIPT_OPT_OUT: Record<string, string> = {
  Hans: 'CJK cut from v1', Hant: 'CJK cut from v1',
  Jpan: 'CJK cut from v1', Kore: 'CJK cut from v1',
};
```

Nineteen `next/font/google` calls cover twenty-two scripts, because Google's `Noto Sans` ships
Latin, Latin-ext, Cyrillic, Greek, Devanagari and Vietnamese as separate `@font-face` blocks
under one family.

**Why `preload: false` is the whole trick.** With the default `preload: true`, Next emits
`<link rel="preload" as="font" href="/_next/static/media/…woff2">` into `<head>` for every
declared subset. The browser fetches those files unconditionally, on every page, before it knows
whether a single matching glyph exists. That is what the current app does with Noto Sans
Myanmar: `/settings` downloads a Burmese font to render an English form. Multiply that by
nineteen families and the shell costs several megabytes before any audio is uploaded.

With `preload: false`, Next emits only the `@font-face` CSS and the CSS custom property. A
`@font-face` rule is *inert* — it is a declaration of where a font can be found, not a request.
The browser instantiates it lazily, at layout time, when a character being laid out matches both
the rule's `unicode-range` and an element whose computed `font-family` names that family. So:

- A Hausa job renders Latin text under `[data-script="Latn"]` → one woff2 (`noto-sans-latin`),
  which was preloaded anyway because it is the chrome font. **Zero non-Latin font files.**
- A Burmese job additionally renders `[data-script="Mymr"]` → exactly one more woff2.
- Opening the language picker and scrolling to Khmer renders a Khmer sample glyph → *then* the
  Khmer woff2 arrives. That is the correct moment for it.

The fixed cost is the CSS. Nineteen families × 2 weights × (1–7 subset blocks) is roughly 6–10 KB
of extra `@font-face` text in the document — measured in Verification step 14, and if it exceeds
~15 KB the mitigation is one weight per non-Latin family (Risks §3).

`display: 'swap'` pairs with this deliberately. The font arrives *after* first paint by
construction, so the choice is between FOUT (swap: fallback text, then reflow) and FOIT
(`block`: invisible text for up to 3 s). For a transcript, text that is readable immediately and
reflows is strictly better than a blank column. The reflow is real and is accepted.

Everything is **self-hosted**: `next/font/google` downloads the woff2 at build time into
`.next/static/media` and rewrites the `src` URL. At runtime there is no request to
`fonts.gstatic.com` — no third-party DNS, no CSP exception, no font-CDN telemetry from a
newsroom's machine, and it works on an air-gapped host. The cost is that the *build* needs
network access; see Risks §1.

#### 3b. Generated per-script CSS

`apps/web/app/generated/scripts.css`, emitted by `scripts/gen-scripts.ts` and committed:

```css
/* GENERATED by scripts/gen-scripts.ts — do not edit. Run `pnpm gen:scripts`. */
[data-script] { font-size: var(--script-font-size, 1rem); line-height: var(--script-leading); }

[data-script="Latn"], [data-script="Cyrl"], [data-script="Grek"] {
  font-family: var(--font-noto-latn), system-ui, sans-serif;
  --script-leading: 1.5;
}
[data-script="Mymr"] {
  font-family: var(--font-noto-mymr), "Noto Sans Myanmar", "Padauk", "Myanmar Text", "Pyidaungsu", sans-serif;
  --script-leading: 1.9;
  --script-font-size: 1.0625rem;
}
[data-script="Khmr"] {
  font-family: var(--font-noto-khmr), "Noto Sans Khmer", "Khmer OS", sans-serif;
  --script-leading: 2.0;
  --script-font-size: 1.0625rem;
  --underline-offset: 0.45em;      /* coeng hangs far below the baseline */
}
[data-script="Ethi"] {
  font-family: var(--font-noto-ethi), "Noto Sans Ethiopic", "Abyssinica SIL", sans-serif;
  --script-leading: 1.7;
}
[data-script="Deva"] { font-family: var(--font-noto-latn), "Noto Sans Devanagari", sans-serif; --script-leading: 1.7; }
[data-script="Arab"] { font-family: var(--font-noto-arab), "Noto Sans Arabic", sans-serif; --script-leading: 1.8; }
[data-script="Sinh"] { font-family: var(--font-noto-sinh), "Noto Sans Sinhala", sans-serif; --script-leading: 1.9; }
[data-script="Thai"] { font-family: var(--font-noto-thai), "Noto Sans Thai", sans-serif; --script-leading: 1.75; }
[data-script="Laoo"] { font-family: var(--font-noto-laoo), "Noto Sans Lao", sans-serif; --script-leading: 1.8; }
/* … one rule per bound script … */
```

**The line-heights are not cosmetic.** These scripts stack marks vertically around the base
glyph: Myanmar puts medials below and vowel signs plus tone marks above, Khmer's coeng
(subscript consonant) hangs a full glyph height below the baseline, Devanagari has a headline
above and matras below, Ethiopic has unusually tall ascenders. At `line-height: 1.5` the marks of
one line collide with the next, and inside `AutoGrowTextarea` — which sets `overflow: hidden` and
sizes to `scrollHeight` — the browser **clips** them. A clipped Burmese tone mark is a different
word. This is data loss on screen, not ugliness, and it is already why the existing rule at
`globals.css:32` sets 1.9.

`--script-font-size` exists for the same reason: Khmer and Myanmar at 15 px are legible only to
someone who already knows what the word is. The registry's `typography.minFontPx` drives it.

`globals.css` imports it after Tailwind so the `[data-script]` rules win over `font-sans`
utilities without `!important`:

```css
@import "tailwindcss";
@import "./generated/scripts.css";
```

#### 3c. `<ScriptedText>` and `scriptAttrs()`

```tsx
// apps/web/components/scripted-text.tsx
export function ScriptedText<T extends React.ElementType = 'span'>({
  script, dir, lang, as, className, children, ...rest
}: { script: string; dir: 'ltr' | 'rtl'; lang: string; as?: T } & React.ComponentPropsWithoutRef<T>) {
  const As = (as ?? 'span') as React.ElementType;
  return <As data-script={script} dir={dir} lang={lang} className={className} {...rest}>{children}</As>;
}
```

```ts
// packages/languages/src/script-attrs.ts
export function scriptAttrs(code: string) {
  const l = resolveLanguage(code);
  return { 'data-script': l.script.code, dir: l.script.direction, lang: l.code } as const;
}
```

`scriptAttrs` exists so a `<textarea>` — which cannot be a `ScriptedText` — gets the same three
attributes by spreading: `<textarea {...scriptAttrs(job.languageCode)} />`. One source of truth,
two call shapes.

**`lang` is missing entirely from the current app** and it is not decoration:

| Consumer | What `lang` changes |
|---|---|
| Font matching | The fallback chain after our Noto family is the OS's. Without `lang`, the UA picks by codepoint coverage and can land on a font with partial or wrong-regional glyphs. With `lang="my"` it prefers the system's Burmese font |
| Line breaking | Chromium uses ICU dictionary breaking for Thai, Khmer, Lao and Burmese, selected by `lang`. Without it, lines break mid-syllable-cluster — visually corrupt in a script with no spaces |
| Spellcheck | We set `spellcheck={false}` for non-Latin (a red squiggle under every Burmese word is noise). `lang` is what makes that decision per-language rather than global |
| Screen readers | Voice and pronunciation switch on `lang`. A Pashto transcript read in an English voice is unusable |
| `text-transform` | Turkish dotted/dotless i. `lang="tr"` is the only thing that makes `uppercase` correct |
| `:lang()` | Lets a later stylesheet target one language inside a script without new attributes |

#### 3d. The registry can never forget a font

`scripts/gen-scripts.ts` runs in `prebuild` and in CI with `--check`:

```ts
const scripts = new Set(languages.map(l => l.script.code));
const missing = [...scripts].filter(s => !(s in SCRIPT_FONTS) && !(s in SCRIPT_OPT_OUT));
if (missing.length) {
  throw new Error(
    `No font binding for script(s): ${missing.join(', ')}.\n` +
    `Languages affected: ${languages.filter(l => missing.includes(l.script.code)).map(l => l.code).join(', ')}\n` +
    `Add a next/font/google declaration to apps/web/app/fonts.ts and re-run \`pnpm gen:scripts\`, ` +
    `or record an explicit opt-out in SCRIPT_OPT_OUT with a reason.`
  );
}
```

Then it emits `scripts.css` from `typography.{cssStack,lineHeight,minFontPx}`. `--check` diffs
the emitted output against the committed file and exits non-zero. Adding a language to
`languages.json` therefore either ships with a font or fails the build with the exact fix in the
message. Opting out is possible but must be written down.

#### 3e. Why CJK is excluded

Google STT v2 supports `cmn-Hans-CN`, `cmn-Hant-TW`, `yue-Hant-HK`, `ja-JP`, `ko-KR`. All five
are `unsupported` in the picker for v1, per the overview's cut list.

1. **The lazy-loading story is different.** Google splits Noto Sans SC into ~100 unicode-range
   subset files; a page of Chinese pulls a substantial fraction of them. `preload: false` still
   helps, but the "a job downloads one woff2" property does not hold, and the loading behaviour
   needs its own design.
2. **Subtitle reflow and CPS are unmeasured for CJK.** `charsPerLineMax` is ~16 for Japanese
   versus ~42 for English, line-breaking is per-character with kinsoku rules, and `cpsMax`
   differs. Phase 7's reflow would silently produce wrong subtitles.
3. **It is off-thesis.** The product exists for the 44 languages OpenAI will not accept. It
   serves CJK well.

Consequence in code: CJK codes are `enabled = false` in `language_support` and never rendered in
the picker; `SCRIPT_OPT_OUT` records the reason so `gen-scripts` does not fail. If a CJK string
somehow reaches the DOM it falls through to `system-ui` — a system font, not tofu.

### 4. RTL foundations

The rule, in one sentence: **`dir` goes on transcript content, never on app chrome.**

| Gets `dir` | Never gets `dir` |
|---|---|
| The segment text column and its `<textarea>` | `<html>` |
| The muted reference line | `<body>` / `AppShell` |
| Job titles and filenames in the list (`unicode-bidi: plaintext`) | The header, nav, toolbars |
| Export previews | The segment row's flex container |
| Glossary term cells | Any table row wrapper |

Why not flip the chrome: bilingual editors — the actual users — expect the application to stay
where it was and only the text to change direction. Flipping the shell also means converting
every `ml-`, `pl-`, `left-`, `text-left` in the app to logical properties, which is a
whole-codebase migration for no user benefit in v1.

Logical properties are therefore **confined to the text column**. Components under
`components/editor/` and `components/scripted-text.tsx` use `ms-`/`me-`/`ps-`/`pe-`/`text-start`/
`text-end`; everything else uses physical classes. Enforce with an ESLint rule
(`no-restricted-syntax` on JSX `className` string literals matching `/\b(ml|mr|pl|pr|left|right|text-(left|right))-/`)
scoped by `overrides` to that directory. A lint rule is what stops this from decaying.

**The timecode gutter stays on the visual left, always.** It is chrome. A timecode column that
jumps to the right for Pashto and back to the left for Hausa in the same session reads as a bug,
and it would sit against RTL text while the rest of the app is LTR. Implementation detail that
matters: the row is a plain LTR flex container and only the *text child* carries `dir="rtl"`. Put
`dir` on the row and the gutter flips with it.

Three smaller rules:

- `unicode-bidi: plaintext` on the reference line, so an English translation under a Pashto
  verbatim line lays out LTR by first-strong character rather than inheriting RTL.
- Every timecode span gets `dir="ltr"` and `font-variant-numeric: tabular-nums`. Inside an RTL
  context `1:02.5` can reorder; and tabular figures stop the gutter jittering during playback.
- Filenames and job titles get `unicode-bidi: plaintext` too — `مقابلة-2026.mp3` must not
  reorder the surrounding row.

Deferred, stated so nobody thinks it was missed: RTL app chrome; Eastern-Arabic numeral
preference (`ar-EG` digit shapes); Nastaliq for Urdu (Noto Nastaliq Urdu has radically different
metrics and needs its own line-height and font-size work); mirrored iconography; deep shaping QA
across Arabic dialects. Export-side bidi isolates are **Phase 7's** `packages/core/src/export/bidi.ts`
and are not re-litigated here — the editor's export preview simply calls the same function.

### 5. Job list (`/`)

A server component. `app/page.tsx:46-57`'s client `useEffect` + two `fetch`es is deleted.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Drop audio or video here — or click to browse                               │
│  Language  [ Hausa · Harshen Hausa  ⬤ beta ▾ ]     Provider [ Google ▾ ]     │
└──────────────────────────────────────────────────────────────────────────────┘

Election 2026                                                       12 jobs ▾
┌─────────────────┬──────────┬──────────┬────────┬─────────┬──────┬──────────┐
│ Title           │ Language │ Duration │ Status │ Runs    │ Cost │ Updated  │
│ interview-3.m4a │ ဗမာ ⬤verified│  68:14 │ ●done  │ 2       │ $0.42│ 2 h ago │
│ rally-audio.mp3 │ Hausa ⬤beta │  14:02 │ ◐ 61%  │ 1       │ ~$0.05│ now     │
└─────────────────┴──────────┴──────────┴────────┴─────────┴──────┴──────────┘
```

| Column | Notes |
|---|---|
| Title | `jobs.title` falling back to `media_assets.filename`. `unicode-bidi: plaintext` |
| Language | `<ScriptedText>` endonym + `<TierPill>`. Endonym first: a Burmese journalist scanning a list finds ဗမာ faster than "Burmese" |
| Duration | `formatDuration`, ported from `app/page.tsx:30-35` |
| Status | `<RunStatusPill>` for the primary run, with an inline progress bar for live runs, fed by `use-run-stream`. A `batch` run has real progress to show — measured 2026-08-10, Google populates `metadata.progressPercent` (26/52/78 across thirteen polls on a 20-minute file), which Phase 2's risk 3 had assumed might always be absent. It is only ever read when actually sent, so a run that omits it falls back to elapsed time rather than to an invented number |
| Runs | Count, as today (`app/page.tsx:165-167`) |
| Cost | **Actual** from `usage_records` once a run exists; `formatEstimate` before that. Never show an estimate next to a completed run |
| Updated | Relative time |

`STATUS_STYLES` (`job-detail.tsx:46-52`) extends to the Phase 9 state machine. The one editorial
decision: **`partial` is amber, not red.** A three-hour transcript with one failed 55-second
chunk is a usable transcript with a retry button, and colouring it as a failure tells the user to
throw it away.

Project grouping: a `Select` "All projects" filter plus grouped sections with a sticky
sub-header. `projects` is the grouping newsrooms actually asked for.

Dropzone (`components/dropzone.tsx`), ported from `app/page.tsx:85-121` with one bug fixed. The
original's `onDragLeave={() => setDragOver(false)}` fires when the pointer enters a *child*
element. It gets away with it because the dropzone has no interactive children; the new one
contains a language picker and a provider select, so it needs a depth counter:

```tsx
const depth = useRef(0);
onDragEnter={() => { if (++depth.current === 1) setOver(true); }}
onDragLeave={() => { if (--depth.current === 0) setOver(false); }}
onDrop={() => { depth.current = 0; setOver(false); /* … */ }}
```

Copy changes: **"Drop a Burmese audio file here"** (`app/page.tsx:116`) → **"Drop audio or video
here"**. The hardcoded language in the primary call-to-action is the single most visible thing
that must not survive the port.

The language picker sits **inside** the dropzone, not after upload. Asking before means the tier
warning is visible at the moment of choice, which is the entire point of tiering. It defaults to
`projects.default_language_code`, then the user's most-recent, then unset (which disables the
drop target with "Pick a language first").

Flow: drop → stream to MinIO with the sha256 passthrough → server probes duration → the
`ConfirmRunDialog` opens with real numbers → confirm → run starts → the row appears with live
progress. Upload never auto-starts a run.

Empty state — not `"No uploads yet."`:

> **Nothing here yet.**
> 1. Drop an audio or video file above.
> 2. Pick its language — 31 enabled, 12 verified. *(Settings → Languages)*
> 3. Correct the transcript against the audio and export.
>
> *[Alert, if unconfigured]* Google Speech-to-Text isn't configured yet. **Add a key →**

The provider alert ports `app/page.tsx:129-137` into a shadcn `Alert` with a direct link to
`/settings/providers` rather than a bare `/settings`.

### 6. `/jobs/new` — three tabs

shadcn `Tabs`: **File · Batch · From URL**. All three are thin clients over the Phase 8 ingest
API; none of them contains business logic.

**File.** The same dropzone, single file, one language, one provider, `ConfirmRunDialog`,
redirect to `/jobs/[id]`. It exists as a tab so the URL is linkable and the other two tabs are
discoverable.

**Batch.** Drop or select N files → a `Table` of rows, one per file:

```
Language for all  [ Hausa ⬤beta ▾ ]      Provider for all  [ Google · chirp_2 ▾ ]

  ✓  rally-01.mp3      12:04   ~$0.04   ⋯
  ✓  rally-02.mp3      18:41   ~$0.06   ⋯
  ⚠  rally-03.wav      —       —        ⋯   couldn't read duration
  …
  12 files · 4 h 18 min · ~$4.13 estimated      [ Cancel ]  [ Transcribe 12 files ]
```

One language and one provider selection above the table, applying to every row. Per-row overrides
live behind the row's `⋯` `DropdownMenu` (Remove · Override language · Override provider) —
present, never prominent. **Twenty individual pickers is the failure mode:** it is twenty
decisions where one was needed, and the realistic outcome is nineteen set correctly and one
missed, discovered after the bill.

*Reconciliation with the overview:* "Per-file language in batch" is on the deliberately-cut list.
The reconciliation is that the Phase 8 ingest API already takes `languageCode` per item, so the
override is one menu item over an existing field rather than a feature. It ships only if it costs
nothing; if it fights the batch flow at all, delete the menu item — the shared-language path is
unaffected. Flagged again in Risks.

**One aggregate cost confirmation**, never per-file dialogs. The dialog states the file count,
total duration, total estimate, and explicitly names the files whose duration could not be
probed — those are excluded from the estimate and the user must be told, not have them silently
counted as zero.

Submit enqueues one ingest job per file and redirects to `/?project=<id>` where each row streams
its own progress.

**From URL.** Two-step, and the second step never happens automatically.

```
1.  URL  [ https://www.youtube.com/watch?v=… ]  [ Resolve ]
2.  ┌────────────────────────────────────────────────────────┐
    │ [thumb]  Interview with … — Channel Name               │
    │          1 h 42 m 06 s · uploaded 2026-03-11           │
    │          Language [ Pashto ⬤beta ▾ ]   ~$0.31 estimated │
    │                            [ Download and transcribe ] │
    └────────────────────────────────────────────────────────┘
```

Resolve is `POST /api/ingest/url/resolve` → enqueues the Phase 8 `--dump-json` step → returns a
step id → the client polls `GET /api/ingest/url/resolve/:id` every second with a 60 s cap. SSE is
the wrong tool for a single one-shot answer.

**Never auto-start.** Duration is unknown until metadata returns, and "paste a URL, we start
immediately" is precisely the shape of a surprise bill — a four-hour livestream VOD looks exactly
like a four-minute clip in the address bar. The Download button is disabled until a duration and
an estimate exist.

Guardrail errors are actionable, not generic: an off-allowlist domain says *"example.com isn't in
the ingest allowlist. An admin can add it in Settings → Ingest."* A file over `--max-filesize`
says the actual limit and the actual size.

### 7. The language picker

The most designed component in this phase. A `<select>` with 107 options is not a control, it is
a punishment.

#### Data

Resolved on the server, passed down as a prop. No loading state inside the popover.

```ts
export interface PickerLanguage {
  code: string;                 // BCP-47, 'my-MM'
  iso639_1: string | null;      // 'my'
  nameEn: string;               // 'Burmese'
  endonym: string;              // 'မြန်မာ'
  altNames: string[];           // ['Myanmar']
  script: { code: string; direction: 'ltr' | 'rtl'; sample: string };
  tier: 'verified' | 'beta' | 'experimental';
  cer: number | null;
  cerRatio: number | null;      // vs the measured Burmese baseline
  evalN: number | null;
  evalDate: string | null;      // ISO date
  noEvalSet: boolean;           // the five non-FLEURS Google languages
  provider: { id: string; label: string; model: string } | null;
  providerNote: string;         // "only provider that supports my-MM with word timings"
  caps: { wordTimestamps: boolean; wordConfidence: boolean; languageDetection: boolean };
}
```

Built by merging the frozen registry with `language_support` and running `resolveModel()` per
language against the *configured* providers, so the picker shows what will actually happen on
this instance rather than what is theoretically possible. ~107 rows ≈ 25 KB of JSON in the RSC
payload — acceptable, and cached with a tag invalidated by writes to `language_support`.

#### Structure

```tsx
<Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild>
    <Button variant="outline" role="combobox" aria-expanded={open} className="w-[320px] justify-between">
      {sel ? (
        <span className="flex min-w-0 items-center gap-2">
          <ScriptedText script={sel.script.code} dir={sel.script.direction} lang={sel.code}
                        className="truncate">{sel.endonym}</ScriptedText>
          <span className="truncate text-muted-foreground">{sel.nameEn}</span>
          <TierPill tier={sel.tier} />
        </span>
      ) : <span className="text-muted-foreground">Select language…</span>}
      <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
    </Button>
  </PopoverTrigger>

  <PopoverContent align="start" className="w-[440px] p-0">
    <Command filter={matchLanguage} shouldFilter>
      <CommandInput placeholder="Search 107 languages — name, native name, or code" />
      <div className="border-b px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={autodetect} onCheckedChange={setAutodetect} disabled={!detectAvailable} />
          Detect language automatically
          <span className="text-xs text-muted-foreground">(verified and beta only)</span>
        </label>
      </div>
      <CommandList className="max-h-[380px]">
        <CommandEmpty>No language matches “{query}”. <Link href="/settings/languages">See all 107 →</Link></CommandEmpty>
        {recent.length > 0 && <CommandGroup heading="Recent">{recent.map(row)}</CommandGroup>}
        <CommandGroup heading="Verified">{verified.map(row)}</CommandGroup>
        <CommandGroup heading="Beta">{beta.map(row)}</CommandGroup>
        <CommandGroup heading="Experimental">{experimental.map(row)}</CommandGroup>
      </CommandList>
      {hiddenCount > 0 && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {hiddenCount} languages hidden — <Link href="/settings/languages" className="underline">Settings → Languages</Link>
        </div>
      )}
    </Command>
  </PopoverContent>
</Popover>
```

#### The row

```
┌────┬──────────────────────────────────────────┬──────────────┐
│ မြ │ မြန်မာ                                    │  ⬤ verified  │
│    │ Burmese · Google chirp_2                 │              │
└────┴──────────────────────────────────────────┴──────────────┘
```

Four pieces of information, in the order a user needs them:

1. **Sample glyph** — one representative grapheme rendered with `<ScriptedText>` in a fixed-width
   cell. It is how a speaker of the language finds their language by shape rather than by reading
   English. It is also a live smoke test for the font system: a tofu box in the picker means that
   script's binding is broken, visible the first time anyone opens the control.
2. **Endonym**, first and largest. `မြန်မာ`, `Harshen Hausa`, `አማርኛ`, `پښتو`.
3. **English name · resolved provider and model.** The provider line is why this is not a list of
   language names: it answers "will this even run here?" before the click. When no configured
   provider supports the code, the row is disabled with "No configured provider supports this —
   add a key in Settings".
4. **Tier pill**, right-aligned.

#### Search

cmdk's default scorer runs over a single `value` string. Three fields and diacritic folding need
a custom `filter`:

```ts
// apps/web/lib/language-search.ts
export const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

/** cmdk passes the item's `value` and its `keywords`; return 0..1. */
export function matchLanguage(_value: string, search: string, keywords?: string[]): number {
  const q = fold(search);
  if (!q) return 1;
  let best = 0;
  for (const k of keywords ?? []) {
    const h = fold(k);
    if (h === q) best = Math.max(best, 1);
    else if (h.startsWith(q)) best = Math.max(best, 0.8);
    else if (h.includes(q)) best = Math.max(best, 0.4);
  }
  return best;
}
```

with `keywords={[l.code, l.iso639_1 ?? '', l.nameEn, l.endonym, ...l.altNames]}`.

What this buys, concretely:

| Typed | Matches | Why it matters |
|---|---|---|
| `my` | `my-MM` Burmese at 1.0 (exact on `iso639_1`), `ms-MY` Malay lower (substring) | The classic collision. Exact-code beats substring, deterministically |
| `မြန်မာ` | `my-MM` | A Burmese speaker types on a Burmese keyboard |
| `yoruba` | `yo-NG` Yorùbá | NFD folding — without it, `Yorùbá` is unfindable by ASCII |
| `farsi` | `fa-IR` Persian | `altNames` |
| `ha-NG` | Hausa at 1.0 | Copy-pasting a code from the CLI must work |
| `amh` | `am-ET` | ISO 639-3 via `altNames` |

#### Grouping and ordering

- **Recent** — localStorage `thibi.recentLanguages`, MRU, max 5, always on top even for beta and
  experimental entries. A newsroom works in three languages and will pick from this group almost
  every time; it is the largest single usability win in the control. Read through
  `useSyncExternalStore` with `getServerSnapshot: () => []` so the server renders no Recent group
  and hydration does not mismatch.
- **Verified**, **Beta**, **Experimental** — each sorted by English name.
- Languages with `language_support.enabled = false` are **hidden**, with a footer count and a link.
  A 107-row picker is unusable for a newsroom that works in three; the disable toggle in
  `/settings/languages` is what makes the list theirs.
- `unsupported` never appears in the picker at all.

#### Tier pills — never red

```tsx
const TIER_STYLES = {
  verified:     'border border-emerald-600/60 text-emerald-700 dark:text-emerald-400',
  beta:         'border border-amber-500/60 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  experimental: 'border border-dashed border-neutral-400 text-neutral-500 dark:text-neutral-400',
} as const;
```

Green outline, amber, dotted grey. **No red anywhere in this component.** Red means "you did
something wrong" or "this is broken". Experimental Oromo is neither — it is a language the tool
supports and has not measured well. Rendering it in error red tells an Oromo journalist that
their language is a fault condition, which is both factually wrong and insulting. Dotted grey
says *unmeasured*, which is exactly what it is. `no-eval-set` languages use the same dotted grey
with the label "experimental — no eval set" so the reason is on the pill.

The pill text is part of the accessible name (`aria-label="Hausa (Harshen Hausa) — beta"`), so
colour is never the only carrier of the tier.

#### Choosing a tiered language never blocks

Selecting beta closes the popover and reveals an inline note under the trigger — not a toast, not
a modal, not a confirmation:

> ⬤ **Beta** — CER 0.15 on 30 FLEURS clips, 1.6× our Burmese baseline (measured 2026-07-14).
> Expect to correct more than usual. [What this means →](/settings/languages#ha-NG)

Every number comes from `language_support`. Nothing is hardcoded, nothing is rounded to a vibe.
If `cer` is null the note reads *"Beta — no measurement on file"* rather than inventing a figure.
The link anchors directly to that language's row in the eval report, so the warning a journalist
sees is one click from the number it came from. That traceability is the difference between a
disclaimer and a quality statement.

Experimental gets the same note plus a second control:

> ⬜ **Experimental** — not measured against a reference set. The output may be unusable.
>
> **[ Try 2 minutes first ]**  Transcribes the first 2 minutes. ~$0.03. You'll see real output
> before committing the whole file.

**"Try 2 minutes first" is the highest-value affordance in the product for the long tail.** The
honest answer to "does this work in Oromo?" is *spend three cents and look at your own audio* —
and every alternative (a support matrix, a tier table, a docs page, a sales claim) is worse,
because none of them is the user's recording.

Implementation is deliberately not a new pipeline: the existing run path with
`runs.max_duration_ms = 120000`. The planner emits a single chunk `[0, 120000)`; the run row
carries `is_probe = true`, which keeps it out of `jobs.primary_run_id` and labels it "2-min
probe" in the run-tab strip. Perhaps twenty lines total, most of them in the planner.

#### Autodetect

- A checkbox above the list. **Off by default.**
- Restricted to verified + beta. On Google STT v2 this is literal: the request carries
  `languageCodes: [...verifiedAndBeta]` rather than `auto`. Whisper providers have no constrained
  candidate list, so autodetect is **disabled** for them with a tooltip rather than faked
  post-hoc; a second call to "fix" a wrong detection is a second bill.
- Disabled with a tooltip whenever the resolved provider's `caps.languageDetection` is false.
  Never render a control that will be silently ignored.
- One-line rationale in the help text: *autodetect is where Groq produced romanized Burmese.* An
  unconstrained detector on a long-tail language fails silently and the output looks plausible to
  someone who doesn't read the script.
- When on, the trigger reads "Auto-detect (verified + beta)" and the editor shows a resolved
  language chip after the run so the user can see what it decided.

#### Keyboard and a11y

`Enter`/`Space` opens; typing filters immediately; `↑`/`↓` moves (cmdk manages
`aria-activedescendant`); `Enter` selects; `Esc` closes and returns focus to the trigger. Groups
are `role="group"` with `aria-labelledby`. The disabled-row case sets `aria-disabled` with the
reason in the accessible name.

### 8. `ConfirmRunDialog`

Ported from `job-detail.tsx:112-212`. Clicking Transcribe spends money; this dialog is the last
point before the charge, and it has already been through one round of real use.

**Verbatim:** the `<dl>` structure and its label wording, the "Audio length" row with
`minutes.toFixed(1)`, the estimate row's border-top separation, the rate note beneath, the re-run
warning copy — *"This file already has N runs. Transcribing again is charged again."* — and the
unknown-duration warning, *"Audio length couldn't be determined, so there's no estimate for this
file."* Both warnings keep their amber card styling.

**Changed:** the chrome. The hand-rolled overlay (`:146-155`), the backdrop `onClick`
(`:148`) and the Escape `useEffect` (`:133-140`) are deleted in favour of shadcn `Dialog`, which
supplies a focus trap, scroll lock, `aria-modal`, Escape and backdrop-dismiss with better
behaviour than we had. The one thing Radix does *not* do by default is focus the confirm button —
it focuses the first tabbable element, which is Cancel — so the original's `confirmRef.current?.focus()`
(`:134`) is preserved explicitly, because Enter-to-proceed was the point:

```tsx
<DialogContent onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
```

**Extended** to cover language, mode and the LLM passes:

```
Start transcription?

  Provider            Google  (chirp_2)
  Language            Hausa — ⬤ beta          ← the tier warning follows you into the dialog
  Audio length        68.4 min
  Mode                batch (staged to GCS)   ← explains a multi-minute start delay
  ────────────────────────────────────────────
  Transcription       ~$0.21    $0.003/min, Dynamic Batch
  Diarization         $0.00     local — roughly 2.5–7 h on this machine
☑ Clean up (haiku)    ~$0.04    est. 41k in / 41k out tokens
☑ Translate → English ~$0.62    (sonnet)
  ────────────────────────────────────────────
  Estimated total     ~$0.87

  $0.003/min — rate you set manually in Settings.
  ⚠ This file already has 1 run. Transcribing again is charged again.

                                       [ Cancel ]  [ Transcribe ]
```

Three things this adds that the original could not:

1. **Mode.** `batch` has minutes of queue latency before anything appears to happen. A user who
   isn't told will reload the page and start a second run.

   **Corrected 2026-08-10: `Mode` has to be a control here, not a read-out.** The dialog above
   shows `batch` for a 68-minute file, which assumed the engine routes long files to batch. It
   does not, and cannot: spike S3 measured `batchRecognize` at a flat 5.9× realtime against
   chunked parallel sync's 3.6–7× advantage, so the two curves never cross and no duration makes
   batch the better choice. `planMode` reaches `batch` **only** through an explicit `force`, so
   a 68-minute file with no user input is `sync_chunked` and this dialog would be showing a mode
   nobody asked for.

   The row becomes the "cheaper, slower" choice itself — the one place a user trades money
   against time, with both numbers already on screen:

   ```
     Mode              ◉ Standard   ~3 min      ~$1.09
                       ○ Cheaper    ~12 min     ~$0.21   staged to Google Cloud Storage
   ```

   Disabled with a one-line reason when no staging bucket is configured, since that is a
   supported and *faster* setup rather than a missing feature. `planMode` throws rather than
   silently downgrading, so the dialog must not offer what it would refuse.
2. **Diarization's cost is time, not money.** pyannote on CPU is 0.15–0.4× realtime — a 68-minute
   file is 2.5–7 hours. The dialog says so, reading a measured realtime factor from settings when
   one exists. Someone who starts a diarization at 5 pm expecting it at 5:10 pm is a support ticket
   the dialog can prevent.
3. **LLM estimates**, with the tokenizer trap handled:

```ts
// packages/core/src/pricing/estimate.ts
export function estimateLlmPassUsd(
  charCount: number,
  rate: { usdPerMTokIn: number; usdPerMTokOut: number },
  opts: { charsPerToken: number; overheadTokensPerBatch: number; batches: number; outputRatio: number },
): number {
  const inTok  = charCount / opts.charsPerToken + opts.overheadTokensPerBatch * opts.batches;
  const outTok = (charCount / opts.charsPerToken) * opts.outputRatio;
  return (inTok / 1e6) * rate.usdPerMTokIn + (outTok / 1e6) * rate.usdPerMTokOut;
}
```

`charsPerToken` is **per script, from the registry** (`text.charsPerToken`), seeded in Phase 5 by
running the actual tokenizers over the FLEURS references. This is the trap: Burmese is roughly
1.2 characters per token on common BPE tokenizers versus ~4 for English, so an estimate derived
from English character counts under-reports a Burmese cleanup pass by about 3×. An estimate that
is wrong by 3× is worse than no estimate.

Everything here is labelled **estimated**. Actual spend comes from `usage_records` and is shown
after the fact on the job and in `/settings` rollups. The estimate is never presented as a price.

`lib/pricing/format.ts` moves to `packages/core/src/pricing/format.ts` **verbatim** — it already
declares itself Node-free in its header comment (`:1-7`), which is precisely the `packages/core`
contract. Because `core` has zero runtime deps and is browser-safe by construction, the
`'use client'` dialog imports it directly, and `thibi transcribe --dry-run` prints its cost line
through the same functions. One implementation, two surfaces, no drift.

`lib/pricing/use-rate.ts` and the 420-line Cloud Billing catalog scraper behind it are deleted.
Rates come from the `rates` table via server-component props.

### 9. SSE hook — `use-run-stream`

```ts
export interface RunStreamEvent {
  seq: number;
  kind: 'run.state' | 'run.progress' | 'step.state' | 'segments.appended' | 'run.cost' | 'error';
  runId: string;
  data: unknown;
}

export function useRunStream(jobId: string): {
  events: RunStreamEvent[];       // coalesced, one state update per frame
  connection: 'connecting' | 'live' | 'stalled' | 'closed';
};
```

Consumes Phase 9's `GET /api/jobs/:id/stream`. Differences from `job-detail.tsx:256-281`:

| Current | New | Why |
|---|---|---|
| `new EventSource(...)`, one anonymous `message` handler | Named events via `addEventListener('run.progress', …)` etc. | One shape for six meanings forces `if (update.status === …)` branching in the component |
| `if (update.status === 'done') refetch()` (`:277`) | `segments.appended { runId, fromIdx, count }` → fetch only that range | The current line re-downloads every segment. On a three-hour file that is ~4 MB of JSON per `done` tick |
| No replay | Server writes `id: <run_events.seq>`; `EventSource` returns it as `Last-Event-ID` on auto-reconnect; the handler replays from that seq before subscribing | This is the whole point of the bigserial. It only works with **native `EventSource`** — a `fetch`-based SSE polyfill loses the automatic header |
| — | `sessionStorage['thibi.seq.<jobId>']` mirrors the last seq | A full page reload loses the browser's `Last-Event-ID`; without this, a refresh means a full refetch instead of a replay |
| No stall detection | Track last-message time (data or `: ping`); `connection: 'stalled'` after 45 s | The 15 s heartbeat exists so silence is diagnosable. Missing `X-Accel-Buffering: no` behind Caddy makes progress *look* frozen; the stall chip is what turns that into a visible symptom instead of a mystery |
| Per-component | One `EventSource` per page via `RunStreamProvider` context | Phase 12 has four consumers (`run-tabs`, `run-toolbar`, `segment-list`, the dock). Four EventSources is four Postgres listeners |
| Immediate `setState` per event | Buffer in a ref, flush once per `requestAnimationFrame` | The worker already coalesces to ≤1 per run per 500 ms, but a batch replay delivers hundreds at once |

The `connection` state distinguishes two failures the user will otherwise conflate: **the stream
died** (stalled → "Reconnecting…") versus **the worker died** (stream healthy, no progress
events → the run's own step timeline shows a stale heartbeat). Different fixes; the UI must not
show the same chip for both.

Fallback, per the overview's cut list: `NEXT_PUBLIC_PROGRESS_TRANSPORT=poll` swaps the
implementation for a 2 s poll behind an identical hook signature. Nothing above the hook changes.

## Porting notes

| Old (`~/Coding_work/myanmar-transcription`) | New | Treatment |
|---|---|---|
| `lib/pricing/format.ts` (whole file) | `packages/core/src/pricing/format.ts` | **Verbatim**, including the header comment explaining why it is Node-free |
| `app/page.tsx:25-28` `formatBytes` | `packages/core/src/format/bytes.ts` | Verbatim |
| `app/page.tsx:30-35` `formatDuration` | `packages/core/src/format/duration.ts` | Verbatim |
| `job-detail.tsx:112-212` `ConfirmRunDialog` | `components/confirm-run-dialog.tsx` | Body verbatim; chrome → Radix `Dialog`; keep the explicit confirm-focus |
| `job-detail.tsx:46-52` `STATUS_STYLES` | `components/run-status-pill.tsx` | Verbatim colour pairs; add `awaiting_external`, `partial` (amber), `cancelled` |
| `job-detail.tsx:396-415` run-tab strip | Phase 12 `components/editor/run-tabs.tsx` | Structure verbatim; scaffolded here, filled there |
| `app/page.tsx:85-121` dropzone | `components/dropzone.tsx` | Changed: drag-depth counter, multi-file, embedded language picker, new copy |
| `app/page.tsx:129-137` unconfigured notice | `components/provider-alert.tsx` | Changed to shadcn `Alert`, links to `/settings/providers` |
| `app/page.tsx:139-173` job list | `components/job-table.tsx` | Rewritten: server-rendered, table, language/tier/project/cost columns |
| `job-detail.tsx:256-281` SSE effect | `hooks/use-run-stream.ts` | Restructured — named events, replay, coalescing, stall detection |
| `app/api/jobs/[id]/stream/route.ts` | Phase 9's endpoint | Replaced. Keep the 15 s heartbeat (`:23-26`) and the abort cleanup (`:28-37`) — both correct |
| `app/api/jobs/[id]/audio/route.ts` | `/api/media/:assetId/url` (presigned) | Range handler survives **only** behind `MEDIA_SERVING=proxy` with `GetObjectCommand` |

**Must not survive the port:**

| Thing | Where | Why |
|---|---|---|
| `Noto_Sans_Myanmar` in the root layout | `app/layout.tsx:3,16-20` | Preloads a Burmese font on every page including `/settings` |
| `.font-myanmar` | `app/globals.css:29-33` | One hardcoded script. Its 1.9 line-height is right and is carried into the generated CSS |
| `"Drop a Burmese audio file here"` | `app/page.tsx:116` | The most visible hardcoded language in the app |
| Client `useEffect` + `fetch` for page data | `app/page.tsx:46-57` | Server components |
| `lib/pricing/use-rate.ts` + the billing catalog scraper | — | Replaced by the `rates` table |
| The stale region doctrine | `lib/providers/google.ts:11-14,139-141`, `lib/settings.ts:29`, `app/settings/page.tsx:27` | Research proved `my-MM` returns identical output from all three regions |
| `lib/db.ts:70` `DELETE FROM runs WHERE provider NOT IN ('google')` | — | Overview risk #5 |

## Tests

**Registry / font completeness**

- `packages/languages/__tests__/script-bindings.spec.ts`
  - `every-script-has-a-font` — over the real `languages.json`
  - `unbound-script-throws` — fixture `languages.unbound.fixture.json` adds a `dv-MV`/`Thaa` entry; asserts the generator throws with `Thaa` and `dv-MV` in the message
  - `opt-out-suppresses-throw` — same fixture with `SCRIPT_OPT_OUT.Thaa` set
- CI step `pnpm --filter web gen:scripts --check` — fails if `app/generated/scripts.css` is stale

**Language picker** (Vitest + Testing Library, fixture `languages.picker.fixture.ts`, 20 rows
across all three tiers plus 3 disabled)

| Test | Assertion |
|---|---|
| `finds-by-english-name` | `hau` → Hausa is the first option |
| `finds-by-endonym` | `မြန်မာ` → `my-MM` |
| `code-exact-beats-substring` | `my` → `my-MM` renders **above** `ms-MY` Malay |
| `folds-diacritics` | `yoruba` → Yorùbá |
| `finds-by-alt-name` | `farsi` → `fa-IR`; `amh` → `am-ET` |
| `hides-disabled` | 3 disabled rows absent; footer reads "3 languages hidden" |
| `beta-note-cites-the-fixture-number` | note contains `CER 0.15` and `1.6×`, sourced from the fixture, not a literal in the component |
| `null-cer-says-not-measured` | no fabricated number |
| `experimental-shows-try-2-minutes` / `verified-does-not` | button presence |
| `no-eval-set-labels-itself` | pill reads "experimental — no eval set" |
| `autodetect-off-by-default` | checkbox unchecked on mount |
| `autodetect-disabled-without-provider-support` | disabled + tooltip when `caps.languageDetection` false |
| `unconfigured-provider-row-disabled` | `aria-disabled`, reason in the accessible name |
| `recent-group-absent-on-server-render` | `renderToString` produces no "Recent" heading (hydration guard) |

- `tier-pill.spec.tsx` → **`never-red`**: for each of the three tiers, the rendered `class`
  matches none of `/\b(red|rose|destructive)\b/`. Cheap, and it is a real regression guard on a
  decision that a future contributor will otherwise "fix".

**Dialog and pricing**

- `confirm-run-dialog.spec.tsx`: `focuses-confirm-on-open`, `escape-cancels`, `backdrop-cancels`,
  `rerun-warning-when-runs-gt-zero`, `unknown-duration-warning-and-no-estimate`,
  `llm-rows-sum-to-total`, `unchecking-a-pass-lowers-the-total`,
  `batch-mode-shows-latency-note`, `local-diarization-shows-hours-not-dollars`
- `estimate.spec.ts`: fixture `pricing/burmese-68min.json` and `pricing/english-68min.json` with
  equal character counts → asserts the Burmese total is ≈3× the English one, i.e. that
  `charsPerToken` is actually consulted

**SSE**

- `use-run-stream.spec.ts` with a `FakeEventSource`: `sets-last-event-id-on-reconnect`,
  `restores-seq-from-sessionStorage`, `coalesces-to-one-flush-per-frame` (200 events → 1 render),
  `segments-appended-fetches-only-the-range`, `stalled-after-45s-of-silence` (fake timers),
  `heartbeat-resets-the-stall-timer`, `single-source-per-provider` (two consumers → one
  constructor call)

**Browser (Playwright)**

- `fonts.spec.ts` — **the test that keeps `preload: false` from silently regressing**
  - open a Hausa job → `performance.getEntriesByType('resource')` contains no
    `/static/media/.*(myanmar|khmer|ethiopic|arabic)/` woff2
  - open a Burmese job → exactly one Myanmar woff2
  - open the picker and scroll to Khmer → a Khmer woff2 appears *then*, and the sample glyph's
    rendered width is > 0 and not the `.notdef` box (compare against a measured tofu width)
  - the document HTML contains no `<link rel="preload" as="font">` for any non-Latin family
- `rtl.spec.ts` — Pashto job: the text column has `dir="rtl"`, `<html>` and the row wrapper do
  not, and the timecode's `getBoundingClientRect().left` is less than the text's
- `line-height.spec.ts` — Burmese and Khmer rows: the rendered text's `scrollHeight` equals
  `clientHeight` (nothing clipped) at 100% and 200% zoom

## Verification

Run `pnpm --filter web dev` against a stack with Google configured and three seeded jobs (Hausa,
Burmese, Pashto).

1. **Auth.** Visit `/` logged out → redirected to `/login`. Log in → header shows the user menu.
   Log in as a non-admin → no `/admin` link, and hitting `/admin/queue` directly is refused by
   `requireAdmin()`, not merely hidden.
2. **Empty state.** With no jobs, the three-step explainer renders with the real enabled-language
   count. Remove the Google key → the alert appears; add it → it disappears on revalidate.
3. **Font laziness, Hausa.** Open the Hausa job. DevTools → Network → filter Font, disable cache,
   reload. **Expect exactly the Latin woff2 files that render the chrome — no Myanmar, Khmer,
   Ethiopic or Arabic file.** This is the headline check for the whole section.
4. **Font laziness, Burmese.** Same on the Burmese job → exactly one additional Myanmar woff2.
5. **Lazy on demand.** With the Burmese job open, open the language picker and scroll to Khmer.
   The Khmer sample glyph renders as a real glyph, and a Khmer woff2 appears in Network *at that
   moment*. That single observation proves the binding is correct and the fetch is lazy.
6. **Swap behaviour.** Throttle to Slow 3G and reload. Text is readable immediately in a fallback
   and reflows when the script font lands. There must be no invisible-text period.
7. **Line height.** Zoom the Burmese transcript to 200%. Tone marks above and medials below are
   fully visible, not clipped at the row edge. Repeat for Khmer, where coeng hangs lowest.
8. **Picker search.** Type `my` → Burmese above Malay. `မြန်မာ` → Burmese. `yoruba` → Yorùbá.
   `ha-NG` → Hausa. `zzz` → the empty state with a link to all 107.
9. **Tier honesty.** Select Hausa. The beta note shows a CER. Now
   `UPDATE language_support SET cer = 0.22 WHERE code='ha-NG';` and reload — **the number in the
   note changes.** That is the test that it is data, not a string.
10. **Try 2 minutes.** Select an experimental language on a 60-minute file, click *Try 2 minutes
    first*. A run starts, appears as "2-min probe" in the run strip, completes in under a minute,
    and is **not** the job's primary run. The cost recorded in `usage_records` corresponds to 2
    minutes, not 60.
11. **Confirm dialog.** Open it — the focus ring is on **Transcribe**. Enter proceeds; Escape and
    a backdrop click both cancel. Toggle the two LLM passes; the total changes and the rows sum to
    it. On a file with unknown duration, the amber warning appears and the estimate reads
    "unknown". On a file with an existing run, the re-run warning appears.
12. **Progress.** Start a run. The row's progress bar advances. `docker compose stop worker` →
    progress stalls but the connection chip stays "live" (the stream is fine). `docker compose
    start worker` → progress resumes. Now kill the *web* process's Postgres listener (restart
    `web`) → the chip goes "Reconnecting…", then recovers, and the Network tab shows the retried
    `stream` request carrying `Last-Event-ID`. Progress jumps forward without a page reload.
13. **Batch.** `/jobs/new` → Batch → drop 12 files. One language selection applies to all. One
    aggregate dialog shows 12 files, the summed duration and one total. Confirm → 12 rows go to
    queued. A file whose duration could not be probed is named explicitly in the dialog.
14. **URL import.** Paste a YouTube URL. **Nothing starts.** Click Resolve → title, channel,
    duration and thumbnail appear; the estimate matches the real duration. Only now does
    *Download and transcribe* enable. Paste an off-allowlist URL → the error names the domain and
    the setting.
15. **CSS weight.** `curl -s localhost:3000/ | grep -o '@font-face' | wc -l` and measure the byte
    delta of the inlined font CSS. Record the number; it is the budget referenced in Risks §3.

## Risks and open questions

1. **`next/font/google` needs network at build time.** It downloads the woff2 during `next build`.
   A newsroom running our published image is unaffected, but building from source on an air-gapped
   host fails. Mitigation, decided in Phase 15: `pnpm gen:fonts --vendor` downloads the files into
   `apps/web/fonts/` and switches `fonts.ts` to `next/font/local` behind one flag. Everything
   downstream — `SCRIPT_FONTS`, the generator, the CSS — is unchanged, because the map is the
   interface.
2. **Sample-glyph tofu flash.** `preload: false` + `swap` means the first open of the picker can
   show a fallback (possibly `.notdef`) for a script the OS lacks. Mitigation: fixed-width glyph
   cells so the swap doesn't move the layout, and accept the flash. Do not preload nineteen
   families to avoid it — that would undo the entire mechanism for one moment of polish.
3. **CSS size.** Nineteen families × 2 weights is up to 38 `@font-face` blocks plus per-subset
   splits on Noto Sans. If Verification step 15 measures more than ~15 KB, drop non-Latin families
   to weight 400 only and let the browser synthesise bold. Transcripts never bold; synthetic bold
   appears only in a heading, where it is acceptable.
4. **Google Fonts does not cover everything.** There is no Google-hosted Shan-capable Myanmar
   variant, and some scripts a future language needs may be absent entirely. The generator's hard
   failure is correct behaviour but means adding a language can block a build. `SCRIPT_OPT_OUT` is
   the escape hatch, and it requires writing down a reason.
5. **cmdk renders every item.** 107 rows is fine. `/settings/languages` at 107 × 4 providers = 428
   rows is not, and will need virtualization in Phase 14. Not this phase, but do not copy the
   picker's structure there without checking.
6. **Per-file language in batch** is on the overview's cut list; Design §6 records the
   reconciliation. If the overflow menu costs more than a menu item, delete it.
7. **Autodetect on Whisper.** Google takes a constrained `languageCodes` list; Whisper does not.
   The plan disables autodetect for Whisper providers rather than doing a post-hoc reject-and-rerun,
   which would double the bill on exactly the languages where detection is least reliable. Confirm
   this is acceptable before building the checkbox.
8. **shadcn CLI × Tailwind v4.** The registry emits different CSS per Tailwind major. Pin the CLI
   version and commit `components.json`; an unpinned `latest` will eventually generate v3 output.
9. **Tier data freshness.** The picker reads `language_support`, written by the harness. If nobody
   ever runs `thibi eval asr`, every language shows whatever the seed said. Phase 14's
   `/settings/languages` should show the eval date prominently; the picker note already includes
   it.

## Definition of done

- [ ] `pnpm --filter web build` succeeds; `pnpm --filter web gen:scripts --check` passes in CI
- [ ] Adding a language with an unbound script **fails the build** with the language code and the
      script code in the error message
- [ ] `app/globals.css` contains no `.font-myanmar`; `app/layout.tsx` imports no script-specific
      font directly
- [ ] Opening a Hausa job downloads **zero** non-Latin woff2 files (asserted by `fonts.spec.ts`)
- [ ] Opening a Burmese job downloads exactly one Myanmar woff2
- [ ] Every transcript-bearing element carries `data-script`, `dir` **and** `lang`
- [ ] Burmese and Khmer text is not clipped at 100% or 200% zoom
- [ ] `<html>` has no `dir="rtl"` for any job; the Pashto job's text column does; the timecode
      gutter is on the left in both
- [ ] The job list is a server component with no client data fetch, and shows language, tier,
      project, status, duration and cost
- [ ] "Drop a Burmese audio file here" appears nowhere in the repo
- [ ] The picker finds Burmese by `my`, by `မြန်မာ`, by `Myanmar`, and ranks it above Malay
- [ ] No tier pill uses a red, rose or destructive class (asserted)
- [ ] The beta note's CER changes when `language_support.cer` changes in the database
- [ ] "Try 2 minutes first" produces a capped, non-primary run billed for ~2 minutes
- [ ] `ConfirmRunDialog` focuses Confirm, cancels on Escape and backdrop, warns on re-run and on
      unknown duration, and itemises LLM passes with a Burmese-aware token estimate
- [ ] `packages/core/src/pricing/format.ts` is imported by both a client component and the CLI
- [ ] Batch takes one language for N files and shows one aggregate confirmation
- [ ] URL import never starts a download before metadata is displayed
- [ ] Killing and restarting `web` mid-run replays missed events via `Last-Event-ID` with no page
      reload
- [ ] `/settings/languages` renders `tiers.json` and the picker's beta note deep-links into it

---
